/**
 * MULTI-VPN-ROLLBACK-001 — transactionally-safe VPN Server port/protocol change.
 *
 * A naïve "stop → update DB → move firewall → start" flow can leave a server
 * broken (DB pointing at a non-running listener, or a previously-working server
 * permanently stopped) if any late step fails. This service replaces it with an
 * explicit, rollback-capable state machine:
 *
 *   snapshot → validate NEW → prepare NEW firewall (old rule kept) →
 *   stop old (if running) → persist NEW → start NEW (if was running) →
 *   verify listener → ONLY THEN remove OLD firewall → commit.
 *
 * On any failure it rolls back to the original working state (old DB + old
 * firewall + old OpenVPN restarted). If rollback itself cannot restore the
 * server it returns an explicit RECOVERY_REQUIRED outcome (never a false
 * success), fully audited.
 *
 * The old firewall rule is NEVER removed before the new configuration is proven
 * healthy. Only Awamer-owned rules (server-tagged) are ever manipulated — done
 * inside the privileged helper (see helperCore firewall ops).
 */
import type { Logger } from "../logger/index.js";
import { DomainError, type AuditEvent } from "../domain/index.js";
import type { VpnServer } from "../domain/vpnServer.js";
import {
  assertPortAllowed, assertProto, assertSubnetValid, type VpnPortPolicy,
} from "../domain/vpnPortPolicy.js";
import type { VpnServerRepository } from "../repos/vpnServerRepo.js";
import type { VpnServerManager, FirewallOpResult } from "./vpnServerManager.js";

export const VpnReconfigErrors = {
  InProgress: () => new DomainError("vpn_reconfiguration_in_progress", "another reconfiguration of this VPN server is in progress"),
  Failed: (msg: string) => new DomainError("vpn_reconfiguration_failed", msg),
  RecoveryRequired: (msg: string) => new DomainError("vpn_recovery_required", msg),
} as const;

/** Fields a reconfiguration may change (mirrors the repo's update patch). */
export interface ReconfigPatch {
  description?: string | null;
  publicHost?: string;
  port?: number;
  proto?: "udp" | "tcp";
  subnet?: string;
  dns?: string | null;
  clientToClient?: boolean;
  cipher?: string;
}

export type ReconfigureOutcome =
  /** No port/proto change — other fields persisted, runtime untouched. */
  | { status: "updated"; server: VpnServer }
  /** Port/proto changed and the new configuration is live + healthy. */
  | { status: "reconfigured"; server: VpnServer; firewall: FirewallOpResult; wasRunning: boolean }
  /** New config is live, but removing the OLD firewall rule failed — the working
   *  new server is intentionally NOT broken; operator cleanup is flagged. */
  | { status: "cleanup_required"; server: VpnServer; firewall: FirewallOpResult; warning: string }
  /** New config failed; the server was restored to its original working state. */
  | { status: "rolled_back"; server: VpnServer; failureStage: string; error: string }
  /** New config failed AND rollback could not fully restore — needs an operator. */
  | { status: "recovery_required"; failureStage: string; error: string; details: Record<string, unknown> };

interface Deps {
  servers: VpnServerRepository;
  manager: VpnServerManager;
  audit: { log: (e: AuditEvent) => Promise<void> | void };
  policy: VpnPortPolicy;
  log: Logger;
}

/** Build the full field patch that reverts a server to a snapshot. */
function revertPatch(s: VpnServer): Required<ReconfigPatch> {
  return {
    description: s.description, publicHost: s.publicHost, port: s.port, proto: s.proto,
    subnet: s.subnet, dns: s.dns, clientToClient: s.clientToClient, cipher: s.cipher,
  };
}

export class VpnReconfigurationService {
  /** Per-server in-process guard: a second concurrent reconfiguration of the same
   *  server gets a deterministic conflict instead of interleaving. The check+add
   *  is synchronous (no await between), so it is race-free within the process. */
  private readonly inProgress = new Set<string>();

  constructor(private readonly deps: Deps) {}

  async reconfigure(userId: string, id: string, patch: ReconfigPatch): Promise<ReconfigureOutcome> {
    if (this.inProgress.has(id)) throw VpnReconfigErrors.InProgress();
    this.inProgress.add(id);
    try {
      return await this.run(userId, id, patch);
    } finally {
      this.inProgress.delete(id);
    }
  }

  private async run(userId: string, id: string, patch: ReconfigPatch): Promise<ReconfigureOutcome> {
    // 2. Snapshot current state (ownership enforced by getServer).
    const before = await this.deps.servers.getServer(userId, id);
    const newPort = patch.port ?? before.port;
    const newProto = patch.proto ?? before.proto;
    const identityChange = newPort !== before.port || newProto !== before.proto;
    const wasRunning = this.deps.manager.status(id).state === "running";

    // Non-identity change: no firewall/OpenVPN dance needed. Persist and return.
    // (A running server keeps running on its current port; port/proto are the
    // only fields that require the rollback-safe lifecycle.)
    if (!identityChange) {
      const server = await this.deps.servers.updateServer(userId, id, patch);
      return { status: "updated", server };
    }

    // 3. Validate the NEW port/proto cheaply BEFORE touching the running server,
    // so an invalid request fails fast with nothing changed. (DB uniqueness +
    // subnet-overlap are enforced authoritatively when we persist, step 6.)
    try {
      assertProto(newProto);
      assertPortAllowed(newPort, this.deps.policy);
      if (patch.subnet !== undefined) assertSubnetValid(patch.subnet);
    } catch (e) {
      throw e instanceof DomainError ? e : VpnReconfigErrors.Failed(String(e));
    }

    // Track exactly what we mutated so rollback only undoes what actually happened
    // (e.g. a firewall-prepare failure must NOT bounce the still-running old server).
    const progress = { newFirewallCreated: false, oldStopped: false, dbChanged: false };
    try {
      // 4. Prepare the NEW firewall rule WITHOUT deleting the old one. A hard
      // failure here aborts before any disruption (old server keeps running).
      const prep = await this.deps.manager.firewallAllow(id, newPort, newProto);
      progress.newFirewallCreated = prep.applied;
      if (!prep.applied && !prep.action_required) {
        return this.rollback(userId, before, wasRunning, newPort, newProto, progress,
          "firewall_prepare", `could not open the new firewall port ${newPort}/${newProto}`);
      }

      // 5. Stop the old OpenVPN (only if it was running).
      if (wasRunning) { await this.deps.manager.stop(id); progress.oldStopped = true; }

      // 6. Persist the NEW configuration (authoritative range/reserved/uniqueness/
      // subnet validation happens here, race-safe under the assignment lock).
      let server: VpnServer;
      try {
        server = await this.deps.servers.updateServer(userId, id, patch);
        progress.dbChanged = true;
      } catch (e) {
        return this.rollback(userId, before, wasRunning, newPort, newProto, progress,
          "db_update", e instanceof Error ? e.message : String(e));
      }

      // 7 + 8. Start OpenVPN on the NEW port and verify the listener is healthy.
      if (wasRunning) {
        try {
          const st = await this.deps.manager.start(server);
          if (st.state !== "running") {
            return this.rollback(userId, before, wasRunning, newPort, newProto, progress,
              "listener_health", `new listener not healthy (state=${st.state})`);
          }
        } catch (e) {
          return this.rollback(userId, before, wasRunning, newPort, newProto, progress,
            "openvpn_start", e instanceof Error ? e.message : String(e));
        }
      }

      // 9. SUCCESS — only now remove the OLD Awamer-owned firewall rule.
      let oldRemoved: FirewallOpResult | null = null;
      try {
        oldRemoved = await this.deps.manager.firewallRemove(id, before.port, before.proto);
      } catch (e) {
        // The new server works; do NOT break it. Flag operator cleanup.
        await this.audit(userId, "vpn_server_reconfigure", "cleanup_required", before, server, {
          stage: "old_firewall_cleanup", error: e instanceof Error ? e.message : String(e) });
        return { status: "cleanup_required", server, firewall: prep,
          warning: `old firewall rule ${before.port}/${before.proto} could not be removed; remove it manually` };
      }
      if (!oldRemoved.applied && !oldRemoved.action_required) {
        await this.audit(userId, "vpn_server_reconfigure", "cleanup_required", before, server, {
          stage: "old_firewall_cleanup", detail: oldRemoved.detail });
        return { status: "cleanup_required", server, firewall: prep,
          warning: `old firewall rule ${before.port}/${before.proto} may still be present` };
      }

      // 10. Commit.
      await this.audit(userId, "vpn_server_reconfigure", "success", before, server,
        { wasRunning, oldFirewall: `${before.port}/${before.proto}` });
      return { status: "reconfigured", server, firewall: prep, wasRunning };
    } catch (e) {
      // Any unexpected error after we started mutating → attempt rollback.
      return this.rollback(userId, before, wasRunning, newPort, newProto, progress,
        "unexpected", e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Restore the server to its original working state. If restoration cannot be
   * completed, returns RECOVERY_REQUIRED (audited) rather than a false success.
   */
  private async rollback(
    userId: string, before: VpnServer, wasRunning: boolean,
    newPort: number, newProto: "udp" | "tcp",
    progress: { newFirewallCreated: boolean; oldStopped: boolean; dbChanged: boolean },
    failureStage: string, error: string,
  ): Promise<ReconfigureOutcome> {
    const actions: Record<string, unknown> = { failureStage, error, ...progress };
    try {
      // 1. Remove the NEW firewall rule if we created it (regardless of how far we got).
      if (progress.newFirewallCreated) {
        try { await this.deps.manager.firewallRemove(before.id, newPort, newProto); actions.new_firewall_removed = true; }
        catch { actions.new_firewall_removed = false; }
      }

      // If we never disrupted the old server (failure before stopping it), the old
      // OpenVPN is still running and the DB is unchanged — nothing else to undo.
      if (!progress.oldStopped && !progress.dbChanged) {
        await this.audit(userId, "vpn_server_reconfigure", "rolled_back", before, before, actions);
        return { status: "rolled_back", server: before, failureStage, error };
      }

      // 2. Restore the OLD DB configuration.
      const restored = await this.deps.servers.updateServer(userId, before.id, revertPatch(before));
      actions.db_restored = true;

      // 3. Confirm/restore the OLD firewall rule (it was never removed; idempotent).
      const fwOld = await this.deps.manager.firewallAllow(before.id, before.port, before.proto);
      actions.old_firewall = fwOld.applied || fwOld.action_required;

      // 4. Restart the OLD OpenVPN only if we actually stopped it.
      if (wasRunning && progress.oldStopped) {
        // Clear any partially-started new instance first (same server id).
        try { await this.deps.manager.stop(before.id); } catch { /* ignore */ }
        const st = await this.deps.manager.start(restored);
        actions.old_restarted = st.state === "running";
        if (st.state !== "running") {
          await this.audit(userId, "vpn_server_reconfigure", "recovery_required", before, restored, actions);
          return { status: "recovery_required", failureStage, error, details: actions };
        }
      }

      await this.audit(userId, "vpn_server_reconfigure", "rolled_back", before, restored, actions);
      return { status: "rolled_back", server: restored, failureStage, error };
    } catch (rbErr) {
      actions.rollback_error = rbErr instanceof Error ? rbErr.message : String(rbErr);
      await this.audit(userId, "vpn_server_reconfigure", "recovery_required", before, null, actions);
      this.deps.log.error({ server: before.id, ...actions }, "VPN reconfiguration rollback FAILED — recovery required");
      return { status: "recovery_required", failureStage, error, details: actions };
    }
  }

  private async audit(
    userId: string, action: string, result: string,
    before: VpnServer, after: VpnServer | null, details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.audit.log({
        userId, action, success: result === "success" || result === "rolled_back",
        resourceType: "vpn_server", resourceId: before.id,
        details: {
          result,
          original: `${before.port}/${before.proto}`,
          requested: after ? `${after.port}/${after.proto}` : "n/a",
          ...details,
        },
      });
    } catch { /* audit must never mask the reconfiguration outcome */ }
  }
}
