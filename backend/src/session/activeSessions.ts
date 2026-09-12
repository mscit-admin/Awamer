/**
 * AWM-SEC-022 — active remote-session revocation.
 *
 * Long-lived privileged channels (SSH/Telnet/TCP-tunnel/VNC) are validated only
 * at connect time. This registry lets a security-relevant account change
 * (disable/lock/delete/role change/company move) TERMINATE already-established
 * sessions, via an immediate revocation event plus a periodic fallback loop that
 * revalidates live state (so a missed event or an out-of-band change is still
 * caught within one interval). It closes both the WebSocket and the underlying
 * privileged connection, is idempotent, and never blocks on the DB per frame.
 */
import { can, type Permission } from "../domain/permissions.js";
import type { AuthUserSource } from "../middleware/auth.js";
import type { Logger } from "../logger/index.js";

export type SessionKind = "ssh" | "telnet" | "tunnel" | "vnc";

export type RevokeReason =
  | "USER_DISABLED"
  | "USER_LOCKED"
  | "USER_DELETED"
  | "ROLE_CHANGED"
  | "COMPANY_CHANGED"
  | "PERMISSION_REVOKED"
  | "PERIODIC_REVALIDATION_FAILED"
  | "AUTHORIZATION_CHANGED";

export interface ActiveRemoteSession {
  sessionId: string;
  userId: string;
  kind: SessionKind;
  requiredPermission: Permission;
  /** Terminate the WS + underlying privileged connection. MUST be idempotent. */
  close: (reason: RevokeReason) => void;
}

interface AuditLike {
  log(evt: {
    userId: string | null;
    action: string;
    resourceType?: string | null;
    resourceId?: string | null;
    details?: Record<string, unknown>;
    success: boolean;
  }): Promise<void> | void;
}

export interface ActiveSessionDeps {
  users: AuthUserSource;
  log: Logger;
  audit?: AuditLike;
  /** Periodic revalidation interval (ms). Default 15s. */
  revalidateIntervalMs?: number;
  /** Consecutive transient DB failures before failing closed. Default 3. */
  failCloseThreshold?: number;
}

function isUserNotFound(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "user_not_found";
}

export class ActiveSessionManager {
  private readonly byId = new Map<string, ActiveRemoteSession>();
  private readonly byUser = new Map<string, Set<string>>();
  private readonly failCounts = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly failThreshold: number;

  constructor(private readonly deps: ActiveSessionDeps) {
    this.intervalMs = deps.revalidateIntervalMs ?? 15_000;
    this.failThreshold = deps.failCloseThreshold ?? 3;
  }

  register(s: ActiveRemoteSession): void {
    this.byId.set(s.sessionId, s);
    let set = this.byUser.get(s.userId);
    if (!set) { set = new Set(); this.byUser.set(s.userId, set); }
    set.add(s.sessionId);
  }

  unregister(sessionId: string): void {
    const s = this.byId.get(sessionId);
    if (!s) return;
    this.byId.delete(sessionId);
    const set = this.byUser.get(s.userId);
    if (set) { set.delete(sessionId); if (set.size === 0) this.byUser.delete(s.userId); }
  }

  count(): number { return this.byId.size; }
  countForUser(userId: string): number { return this.byUser.get(userId)?.size ?? 0; }

  private sessionsForUser(userId: string): ActiveRemoteSession[] {
    const set = this.byUser.get(userId);
    if (!set) return [];
    return [...set].map((id) => this.byId.get(id)).filter((x): x is ActiveRemoteSession => x !== undefined);
  }

  /** Unregister first (so a re-entrant close is a no-op), then close + audit. */
  private closeOne(s: ActiveRemoteSession, reason: RevokeReason): void {
    this.unregister(s.sessionId);
    try {
      s.close(reason);
    } catch (e) {
      this.deps.log.warn({ err: (e as Error).message, sessionId: s.sessionId }, "active-session close failed");
    }
    if (this.deps.audit) {
      try {
        void this.deps.audit.log({
          userId: s.userId, action: "token_revoke", resourceType: "session", resourceId: s.sessionId,
          success: true, details: { op: "remote_session_revoked", kind: s.kind, reason },
        });
      } catch { /* audit must never block revocation */ }
    }
  }

  /** Unconditionally terminate ALL of a user's sessions (disable/lock/delete/company move). */
  revokeUser(userId: string, reason: RevokeReason): number {
    const sessions = this.sessionsForUser(userId);
    for (const s of sessions) this.closeOne(s, reason);
    return sessions.length;
  }

  /**
   * Revalidate a user's live security state and close sessions that are no longer
   * authorized. Fail-closed on a DELETED user; permission-aware for role changes;
   * grace-then-fail-closed on persistent DB failure.
   */
  async revalidateUser(userId: string): Promise<void> {
    if (this.countForUser(userId) === 0) return;
    let user: Awaited<ReturnType<AuthUserSource["getById"]>>;
    try {
      user = await this.deps.users.getById(userId);
    } catch (e) {
      if (isUserNotFound(e)) {
        this.failCounts.delete(userId);
        this.revokeUser(userId, "USER_DELETED");
        return;
      }
      // Transient DB error: allow a short grace window, then fail closed.
      const n = (this.failCounts.get(userId) ?? 0) + 1;
      this.failCounts.set(userId, n);
      if (n >= this.failThreshold) {
        this.failCounts.delete(userId);
        this.revokeUser(userId, "PERIODIC_REVALIDATION_FAILED");
      }
      return;
    }
    this.failCounts.delete(userId);
    if (!user.isActive) { this.revokeUser(userId, "USER_DISABLED"); return; }
    const tempLocked = user.lockedUntil != null && user.lockedUntil.getTime() > Date.now();
    if (user.isLocked || tempLocked) { this.revokeUser(userId, "USER_LOCKED"); return; }
    for (const s of this.sessionsForUser(userId)) {
      if (!can(user.role, s.requiredPermission)) this.closeOne(s, "PERMISSION_REVOKED");
    }
  }

  /** Start the shared periodic revalidation loop (fallback for missed events). */
  startPeriodic(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.revalidateAll(); }, this.intervalMs);
    // Do not keep the event loop alive just for this timer.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Revalidate every user with at least one active session (batched by user). */
  async revalidateAll(): Promise<void> {
    for (const userId of [...this.byUser.keys()]) {
      try { await this.revalidateUser(userId); } catch { /* isolate one user's failure */ }
    }
  }
}
