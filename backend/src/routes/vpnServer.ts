/**
 * Built-in OpenVPN server management (migration 019) — gated by
 * `vpn_server:manage` (admin). Create server instances (which mint a CA +
 * server cert), manage their users, download per-user `.ovpn` files, and
 * start/stop the running openvpn process.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { JwtService } from "../jwt/index.js";
import type { AuditRepository } from "../repos/otherRepos.js";
import type { VpnServerRepository } from "../repos/vpnServerRepo.js";
import type { VpnServerManager } from "../vpn/vpnServerManager.js";
import type { VpnReconfigurationService } from "../vpn/vpnReconfigure.js";
import { makeAuthMiddleware, requirePermission } from "../middleware/auth.js";
import { DomainError } from "../domain/index.js";
import {
  assembleClientOvpn, toVpnServerPublic, toVpnServerClientPublic, VPN_SERVER_CIPHERS,
  isSafeVpnUsername,
} from "../domain/vpnServer.js";

interface Deps {
  servers: VpnServerRepository;
  manager: VpnServerManager;
  reconfig: VpnReconfigurationService;
  audit: AuditRepository;
  jwt: JwtService;
  users: import("../repos/userRepo.js").UserRepository;
  /** VPN Server port assignment range (for UI display + validation messages). */
  portPolicy: { min: number; max: number };
}

const protoEnum = z.enum(["udp", "tcp"]);
const HOST_RE = /^[a-zA-Z0-9._:-]+$/;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

function status(code: string): number {
  if (code.endsWith("_not_found")) return 404;
  if (code.endsWith("_taken") || code.endsWith("_in_use") || code.endsWith("_in_progress") || code === "vpn_reconfiguration_failed") return 409;
  if (code === "vpn_recovery_required") return 500;
  return 400;
}

export function makeVpnServerRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt, deps.users));
    app.addHook("preHandler", requirePermission("vpn_server:manage"));

    const fail = (reply: FastifyReply, e: unknown) => {
      if (e instanceof DomainError) return reply.code(status(e.code)).send({ error: { code: e.code, message: e.message } });
      throw e;
    };
    const uid = (req: { auth?: { sub: string } }) => req.auth!.sub;

    // Firewall lifecycle: open/close a server's data port via the privileged
    // helper. Best-effort + AUDITED — a firewall failure/action-required is
    // recorded, never silently ignored, and never claims external readiness.
    const fwAllow = async (actor: string, s: { id: string; port: number; proto: string }) => {
      try {
        const r = await deps.manager.firewallAllow(s.id, s.port, s.proto);
        await deps.audit.log({ userId: actor, action: "vpn_server_firewall_allow", success: r.applied, resourceType: "vpn_server", resourceId: s.id, details: { port: s.port, proto: s.proto, applied: r.applied, action_required: r.action_required, backend: r.backend } });
        return r;
      } catch (e) {
        await deps.audit.log({ userId: actor, action: "vpn_server_firewall_allow", success: false, resourceType: "vpn_server", resourceId: s.id, details: { port: s.port, proto: s.proto, error: e instanceof Error ? e.message : String(e) } });
        return { applied: false, action_required: true, backend: "unknown", detail: "firewall op failed" };
      }
    };
    const fwRemove = async (actor: string, s: { id: string; port: number; proto: string }) => {
      try {
        const r = await deps.manager.firewallRemove(s.id, s.port, s.proto);
        await deps.audit.log({ userId: actor, action: "vpn_server_firewall_remove", success: r.applied, resourceType: "vpn_server", resourceId: s.id, details: { port: s.port, proto: s.proto, applied: r.applied, backend: r.backend } });
      } catch (e) {
        await deps.audit.log({ userId: actor, action: "vpn_server_firewall_remove", success: false, resourceType: "vpn_server", resourceId: s.id, details: { port: s.port, proto: s.proto, error: e instanceof Error ? e.message : String(e) } });
      }
    };

    // ---- port policy (UI shows the allowed range) -------------------
    app.get("/port-policy", async (_req, reply) => reply.send({ min: deps.portPolicy.min, max: deps.portPolicy.max }));

    // ---- servers ----------------------------------------------------
    app.get("/servers", async (req, reply) => {
      const list = await deps.servers.listServers(uid(req));
      const counts = await deps.servers.clientCounts(list.map((s) => s.id));
      return reply.send({ data: list.map((s) => ({ ...toVpnServerPublic(s, counts.get(s.id) ?? 0), status: deps.manager.status(s.id) })) });
    });

    const createSchema = z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(1000).nullable().optional(),
      public_host: z.string().max(253).regex(HOST_RE, "invalid host"),
      port: z.number().int().min(1).max(65535).optional(),
      auto_assign_port: z.boolean().optional(),
      proto: protoEnum.optional(),
      subnet: z.string().regex(CIDR_RE, "subnet must be CIDR, e.g. 10.8.1.0/24").optional(),
      dns: z.string().max(253).regex(HOST_RE).nullable().optional(),
      client_to_client: z.boolean().optional(),
      internet_access: z.boolean().optional(),
      // SEC-VPN-CFG-001: strict allowlist (was free text → config injection).
      cipher: z.enum(VPN_SERVER_CIPHERS).optional(),
    });

    app.post("/servers", async (req, reply) => {
      const p = createSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: { code: "validation_failed", message: p.error.message } });
      const d = p.data;
      try {
        const s = await deps.servers.createServer(uid(req), {
          name: d.name, description: d.description ?? null, publicHost: d.public_host,
          port: d.port, autoAssignPort: d.auto_assign_port, proto: d.proto, subnet: d.subnet, dns: d.dns ?? null,
          clientToClient: d.client_to_client, internetAccess: d.internet_access, cipher: d.cipher,
        });
        await deps.audit.log({ userId: uid(req), action: "vpn_server_create", success: true, resourceType: "vpn_server", resourceId: s.id, details: { port: s.port, proto: s.proto, subnet: s.subnet } });
        // Open the host firewall for the assigned data port (audited, best-effort).
        const fw = await fwAllow(uid(req), s);
        return reply.code(201).send({ ...toVpnServerPublic(s), firewall: fw });
      } catch (e) { return fail(reply, e); }
    });

    app.get("/servers/:id", async (req, reply) => {
      try {
        const s = await deps.servers.getServer(uid(req), (req.params as { id: string }).id);
        return reply.send({ ...toVpnServerPublic(s), status: deps.manager.status(s.id) });
      } catch (e) { return fail(reply, e); }
    });

    const updateSchema = createSchema.partial().omit({ name: true, auto_assign_port: true });
    app.patch("/servers/:id", async (req, reply) => {
      const p = updateSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: { code: "validation_failed", message: p.error.message } });
      const d = p.data;
      const id = (req.params as { id: string }).id;
      try {
        // MULTI-VPN-ROLLBACK-001 — a rollback-safe state machine performs any
        // port/protocol change: it never removes the old firewall rule before the
        // new listener is proven healthy, and restores the original working state
        // (or reports RECOVERY_REQUIRED) if anything fails. Non-identity edits are
        // a plain persist.
        const outcome = await deps.reconfig.reconfigure(uid(req), id, {
          description: d.description, publicHost: d.public_host, port: d.port, proto: d.proto,
          subnet: d.subnet, dns: d.dns, clientToClient: d.client_to_client,
          internetAccess: d.internet_access, cipher: d.cipher,
        });
        switch (outcome.status) {
          case "updated":
            return reply.send({ ...toVpnServerPublic(outcome.server), status: deps.manager.status(id) });
          case "reconfigured":
            return reply.send({ ...toVpnServerPublic(outcome.server), firewall: outcome.firewall, status: deps.manager.status(id) });
          case "cleanup_required":
            return reply.send({ ...toVpnServerPublic(outcome.server), firewall: outcome.firewall, warning: outcome.warning, status: deps.manager.status(id) });
          case "rolled_back":
            // The change was NOT applied; the server was restored to its original
            // working configuration. Report a clear failure — never a false success.
            return reply.code(409).send({ error: {
              code: "vpn_reconfiguration_failed",
              message: `reconfiguration failed at ${outcome.failureStage}; server restored to its original configuration (${outcome.error})`,
            } });
          case "recovery_required":
            return reply.code(500).send({ error: {
              code: "vpn_recovery_required",
              message: `reconfiguration failed at ${outcome.failureStage} and automatic rollback could not fully restore the server; operator intervention required`,
            } });
        }
      } catch (e) { return fail(reply, e); }
    });

    app.delete("/servers/:id", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      try {
        const s = await deps.servers.getServer(uid(req), id); // port/proto for rule removal
        await deps.manager.stop(id);
        // Remove ONLY this server's Awamer-owned firewall rule before deletion.
        await fwRemove(uid(req), { id, port: s.port, proto: s.proto });
        await deps.servers.deleteServer(uid(req), id);
        await deps.audit.log({ userId: uid(req), action: "vpn_server_delete", success: true, resourceType: "vpn_server", resourceId: id, details: { port: s.port, proto: s.proto } });
        return reply.code(204).send();
      } catch (e) { return fail(reply, e); }
    });

    // ---- runtime ----------------------------------------------------
    app.post("/servers/:id/start", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      try {
        const s = await deps.servers.getServer(uid(req), id);
        const st = await deps.manager.start(s);
        await deps.audit.log({ userId: uid(req), action: "vpn_server_start", success: true, resourceType: "vpn_server", resourceId: id, details: { port: s.port, proto: s.proto } });
        // Ensure the host firewall permits this server's data port (idempotent).
        const fw = await fwAllow(uid(req), s);
        return reply.send({ ...st, firewall: fw });
      } catch (e) {
        if (e instanceof DomainError) return fail(reply, e);
        return reply.code(502).send({ error: { code: "vpn_server_start_failed", message: e instanceof Error ? e.message : "start failed" } });
      }
    });

    app.post("/servers/:id/stop", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      try {
        await deps.servers.getServer(uid(req), id); // ownership
        await deps.manager.stop(id);
        return reply.send({ ok: true });
      } catch (e) { return fail(reply, e); }
    });

    // ---- clients ----------------------------------------------------
    app.get("/servers/:id/clients", async (req, reply) => {
      try {
        const list = await deps.servers.listClients(uid(req), (req.params as { id: string }).id);
        return reply.send({ data: list.map(toVpnServerClientPublic) });
      } catch (e) { return fail(reply, e); }
    });

    const clientSchema = z.object({
      name: z.string().min(1).max(100),
      username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/, "invalid username"),
      password: z.string().min(8).max(128).optional(),
      internet_access: z.boolean().optional(),
    });
    app.post("/servers/:id/clients", async (req, reply) => {
      const serverId = (req.params as { id: string }).id;
      const p = clientSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: { code: "validation_failed", message: p.error.message } });
      const password = p.data.password ?? randomBytes(12).toString("base64url");
      try {
        if (!isSafeVpnUsername(p.data.username)) return reply.code(400).send({ error: { code: "validation_failed", message: "invalid username" } });
        const c = await deps.servers.createClient(uid(req), serverId, { name: p.data.name, username: p.data.username, password, internetAccess: p.data.internet_access });
        await deps.audit.log({ userId: uid(req), action: "vpn_server_client_create", success: true, resourceType: "vpn_server", resourceId: serverId, details: { client: c.id } });
        // Return the password once so the admin can hand it over (also stored, reveal-gated).
        return reply.code(201).send({ ...toVpnServerClientPublic(c), password });
      } catch (e) { return fail(reply, e); }
    });

    const revokeSchema = z.object({ revoked: z.boolean() });
    app.post("/servers/:id/clients/:cid/revoke", async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string };
      const p = revokeSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: { code: "validation_failed", message: p.error.message } });
      try {
        await deps.servers.setClientRevoked(uid(req), id, cid, p.data.revoked);
        await deps.audit.log({ userId: uid(req), action: p.data.revoked ? "vpn_server_client_revoke" : "vpn_server_client_unrevoke", success: true, resourceType: "vpn_server", resourceId: id, details: { client: cid } });
        return reply.send({ ok: true, revoked: p.data.revoked });
      } catch (e) { return fail(reply, e); }
    });

    // Per-client internet access (applies when the server's internet policy is
    // on; takes effect at the next server start).
    const internetSchema = z.object({ enabled: z.boolean() });
    app.post("/servers/:id/clients/:cid/internet", async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string };
      const p = internetSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: { code: "validation_failed", message: p.error.message } });
      try {
        await deps.servers.setClientInternet(uid(req), id, cid, p.data.enabled);
        await deps.audit.log({ userId: uid(req), action: p.data.enabled ? "vpn_server_client_internet_on" : "vpn_server_client_internet_off", success: true, resourceType: "vpn_server", resourceId: id, details: { client: cid } });
        return reply.send({ ok: true, internet_access: p.data.enabled });
      } catch (e) { return fail(reply, e); }
    });

    app.delete("/servers/:id/clients/:cid", async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string };
      try {
        await deps.servers.deleteClient(uid(req), id, cid);
        return reply.code(204).send();
      } catch (e) { return fail(reply, e); }
    });

    /** Reveal a client's username/password (audited). */
    app.get("/servers/:id/clients/:cid/credentials", async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string };
      try {
        const c = await deps.servers.getClient(uid(req), id, cid);
        await deps.audit.log({ userId: uid(req), action: "vpn_server_client_reveal", success: true, resourceType: "vpn_server", resourceId: id, details: { client: cid } });
        return reply.send({ username: c.username, password: c.password });
      } catch (e) { return fail(reply, e); }
    });

    /** Download the unified .ovpn for a client. */
    app.get("/servers/:id/clients/:cid/ovpn", async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string };
      try {
        const s = await deps.servers.getServer(uid(req), id);
        const c = await deps.servers.getClient(uid(req), id, cid);
        const ovpn = assembleClientOvpn({
          proto: s.proto, publicHost: s.publicHost, port: s.port, cipher: s.cipher,
          caCert: s.caCert, clientCert: c.cert, clientKey: c.key, tlsCrypt: s.tlsCrypt,
        });
        await deps.audit.log({ userId: uid(req), action: "vpn_server_client_download", success: true, resourceType: "vpn_server", resourceId: id, details: { client: cid } });
        const safe = c.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        return reply
          .header("Content-Type", "application/x-openvpn-profile")
          .header("Content-Disposition", `attachment; filename="${safe}.ovpn"`)
          .send(ovpn);
      } catch (e) { return fail(reply, e); }
    });
  };
}
