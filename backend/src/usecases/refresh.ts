import { Errors } from "../domain/index.js";
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

    const user = await this.users.getById(claims.sub);
    const { access, refresh: newRefresh } = await this.jwt.issuePair(user.id, user.role);
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
}
