import { Errors, isAccountLocked } from "../domain/index.js";
import type { UserRepository } from "../repos/userRepo.js";
import type { RefreshRepository, AuditRepository } from "../repos/otherRepos.js";
import type { JwtService } from "../jwt/index.js";
import type { Logger } from "../logger/index.js";

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export class RefreshUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly refresh: RefreshRepository,
    private readonly audit: AuditRepository,
    private readonly jwt: JwtService,
    private readonly log: Logger,
  ) {}

  async execute(refreshToken: string, ip: string | null, ua: string | null): Promise<RefreshResult> {
    const claims = await this.jwt.verifyRefresh(refreshToken); // throws JwtInvalid/Expired

    const session = await this.refresh.get(claims.jti);
    if (!session) {
      // Token signed by us, but no record — likely cleared or never inserted.
      // Treat conservatively as reuse.
      throw Errors.RefreshReuse();
    }
    if (session.rotatedTo) {
      // Already rotated → strong reuse signal. Revoke ALL of this user's sessions.
      this.log.warn({ userId: session.userId, jti: session.jti }, "refresh token reuse detected");
      await this.refresh.revokeAllForUser(session.userId);
      await this.audit.log({
        userId: session.userId, action: "token_reuse_detected", success: false,
        ipAddress: ip, userAgent: ua,
      });
      throw Errors.RefreshReuse();
    }
    if (session.revokedAt || session.expiresAt < new Date()) {
      throw Errors.RefreshReuse();
    }

    // SEC-002 / SEC-007: enforce current account state on every refresh.
    // A valid, non-reused refresh token is not enough — the account must still
    // be eligible right now. This mirrors the login policy so that disabling,
    // locking or deleting a user takes effect for existing sessions instead of
    // letting the 168h refresh chain renew itself indefinitely.
    let user;
    try {
      user = await this.users.getById(claims.sub);
    } catch {
      // Account deleted (or otherwise gone). Kill the chain and deny.
      await this.refresh.revokeAllForUser(session.userId);
      await this.audit.log({
        userId: session.userId, action: "token_refresh_denied", success: false,
        ipAddress: ip, userAgent: ua, details: { reason: "user_gone" },
      });
      throw Errors.RefreshReuse();
    }

    if (!user.isActive || isAccountLocked(user, new Date())) {
      // Disabled or locked → revoke the whole session chain so no further
      // refresh (with this or any sibling token) succeeds, then deny with a
      // generic error (the route maps every throw to 401 invalid_refresh, so
      // account state is never disclosed to the caller).
      await this.refresh.revokeAllForUser(user.id);
      await this.audit.log({
        userId: user.id, action: "token_refresh_denied", success: false,
        ipAddress: ip, userAgent: ua,
        details: { reason: user.isActive ? "locked" : "inactive" },
      });
      throw user.isActive ? Errors.AccountLocked() : Errors.AccountInactive();
    }

    const { access, refresh: newRefresh } = await this.jwt.issuePair(user.id, user.role, user.authVersion);
    await this.refresh.insert({ jti: newRefresh.jti, userId: user.id, expiresAt: newRefresh.expiresAt });
    await this.refresh.markRotated(session.jti, newRefresh.jti);
    await this.audit.log({
      userId: user.id, action: "token_refresh", success: true,
      ipAddress: ip, userAgent: ua,
    });
    return {
      accessToken: access.token,
      refreshToken: newRefresh.token,
      expiresAt: access.expiresAt,
    };
  }

  /**
   * SEC-017 — current-session logout. Verifies the presented refresh token and
   * revokes exactly that session server-side, so it (and any stolen copy) can no
   * longer be refreshed. Idempotent and safe on an invalid/expired token.
   */
  async logout(refreshToken: string, ip: string | null, ua: string | null): Promise<void> {
    try {
      const claims = await this.jwt.verifyRefresh(refreshToken);
      await this.refresh.revoke(claims.jti);
      await this.audit.log({ userId: claims.sub, action: "logout", success: true, ipAddress: ip, userAgent: ua });
    } catch {
      // Invalid/expired token → nothing to revoke; logout stays idempotent.
    }
  }

  /** SEC-017 — revoke every active session for a user (logout everywhere). */
  async logoutAll(userId: string, ip: string | null, ua: string | null): Promise<void> {
    await this.refresh.revokeAllForUser(userId);
    await this.audit.log({ userId, action: "logout", success: true, ipAddress: ip, userAgent: ua, details: { scope: "all" } });
  }
}
