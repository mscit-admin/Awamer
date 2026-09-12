import { v4 as uuid } from "uuid";
import { Errors, isAccountLocked, type User } from "../domain/index.js";
import type { UserRepository } from "../repos/userRepo.js";
import type { RefreshRepository, AuditRepository } from "../repos/otherRepos.js";
import type { JwtService } from "../jwt/index.js";
import type { Argon2Service } from "../crypto/argon2.js";
import type { Logger } from "../logger/index.js";
import type { Config } from "../config/index.js";

export interface LoginInput {
  username: string;
  password: string;
  ip: string | null;
  ua: string | null;
}

export interface LoginResult {
  mfaRequired: boolean;
  mfaToken?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  user?: User;
}

export class LoginUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly refresh: RefreshRepository,
    private readonly audit: AuditRepository,
    private readonly jwt: JwtService,
    private readonly argon2: Argon2Service,
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {}

  async execute(input: LoginInput): Promise<LoginResult> {
    let user: User;
    try {
      user = await this.users.getByUsername(input.username);
    } catch {
      // Defence against username enumeration: do a dummy hash with the same
      // cost as the real one so timing doesn't leak existence.
      await this.dummyHashCheck(input.password);
      await this.audit.log({
        userId: null, action: "login", success: false,
        ipAddress: input.ip, userAgent: input.ua,
        details: { reason: "user_not_found", username: input.username },
      });
      throw Errors.InvalidCredentials();
    }

    // Status checks
    if (!user.isActive) {
      await this.audit.log({
        userId: user.id, action: "login", success: false,
        ipAddress: input.ip, userAgent: input.ua, details: { reason: "inactive" },
      });
      throw Errors.AccountInactive();
    }
    if (isAccountLocked(user, new Date())) {
      await this.audit.log({
        userId: user.id, action: "login", success: false,
        ipAddress: input.ip, userAgent: input.ua, details: { reason: "locked" },
      });
      throw Errors.AccountLocked();
    }

    const ok = await this.argon2.verify(user.passwordHash, input.password);
    if (!ok) {
      const newCount = await this.users.incrementFailedAttempts(user.id);
      if (newCount >= this.cfg.env.ACCOUNT_LOCKOUT_THRESHOLD) {
        // Temporary lockout that expires on its own — avoids an anonymous
        // "lock any account forever" DoS while still throttling guessing.
        const until = new Date(Date.now() + this.cfg.env.ACCOUNT_LOCKOUT_MINUTES * 60_000);
        await this.users.setLockedUntil(user.id, until);
        this.log.warn({ userId: user.id, attempts: newCount, until }, "account temporarily locked due to failed attempts");
      }
      await this.audit.log({
        userId: user.id, action: "login", success: false,
        ipAddress: input.ip, userAgent: input.ua,
        details: { reason: "bad_password", attempts: newCount },
      });
      throw Errors.InvalidCredentials();
    }

    await this.users.resetFailedAttempts(user.id);

    // MFA challenge step
    if (user.mfaEnabled) {
      const mfa = await this.jwt.issueOne(user.id, "mfa_pending", "access", 5 * 60);
      await this.audit.log({
        userId: user.id, action: "login", success: true,
        ipAddress: input.ip, userAgent: input.ua, details: { step: "mfa_required" },
      });
      return { mfaRequired: true, mfaToken: mfa.token };
    }

    return this.completeLogin(user, input.ip, input.ua);
  }

  async completeLogin(user: User, ip: string | null, ua: string | null): Promise<LoginResult> {
    const { access, refresh } = await this.jwt.issuePair(user.id, user.role, user.authVersion);
    await this.refresh.insert({ jti: refresh.jti, userId: user.id, expiresAt: refresh.expiresAt });
    await this.users.recordLogin(user.id, ip);
    await this.audit.log({
      userId: user.id, action: "login", success: true,
      ipAddress: ip, userAgent: ua,
    });
    return {
      mfaRequired: false,
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresAt: access.expiresAt,
      user,
    };
  }

  /** Same cost as a real verify, throwaway result. */
  private async dummyHashCheck(password: string): Promise<void> {
    // A pre-computed Argon2id hash whose decode succeeds → forces real Argon2
    // computation before failing.
    const dummy = "$argon2id$v=19$m=65536,t=3,p=4$ZHVtbXlzYWx0ZHVtbXlzYWx0$" +
      "kPsNFnVQwLnMqs9ggCFZL58qNUlZWAHP6r9KShEpExc";
    try {
      await this.argon2.verify(dummy, password);
    } catch {
      // ignore — purpose is timing parity only
    }
  }
}

// ---------------------------------------------------------------------------
// MFA-step-2 completion (called after TOTP code accepted)
// ---------------------------------------------------------------------------

export async function completeMFALogin(
  uc: LoginUseCase,
  users: UserRepository,
  userId: string,
  ip: string | null,
  ua: string | null,
): Promise<LoginResult> {
  const user = await users.getById(userId);
  if (!user.isActive) throw Errors.AccountInactive();
  if (isAccountLocked(user, new Date())) throw Errors.AccountLocked();
  return uc.completeLogin(user, ip, ua);
}

// silence unused-import warning when v4 is only used elsewhere
void uuid;
