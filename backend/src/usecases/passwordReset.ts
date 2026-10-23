/**
 * Forgot / reset password.
 *
 * requestReset: look up the user by email, issue a one-time token (only its
 * hash is stored), and email a reset link. Always returns without revealing
 * whether the email exists.
 *
 * resetPassword: validate the token, set the new password, consume the token,
 * and revoke all refresh sessions.
 */
import { randomBytes, createHash } from "node:crypto";
import type { UserRepository } from "../repos/userRepo.js";
import type { PasswordResetRepository } from "../repos/passwordResetRepo.js";
import type { RefreshRepository, AuditRepository } from "../repos/otherRepos.js";
import type { Argon2Service } from "../crypto/argon2.js";
import type { MailService } from "../email/mailer.js";
import type { Logger } from "../logger/index.js";
import { Errors, DomainError } from "../domain/index.js";
import { validatePassword } from "./register.js";
import { resolveTrustedBaseUrl } from "./publicBaseUrl.js";
import type { SessionRevoker } from "../session/activeSessions.js";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Minimal config surface the reset flow needs (SEC-RESET-001). */
export interface ResetBaseUrlConfig {
  isProd: boolean;
  /** Validated APP_PUBLIC_BASE_URL, or null. */
  publicBaseUrl: string | null;
}

export class PasswordResetUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly resets: PasswordResetRepository,
    private readonly refresh: RefreshRepository,
    private readonly mailer: MailService,
    private readonly argon2: Argon2Service,
    private readonly audit: AuditRepository,
    private readonly log: Logger,
    private readonly cfg: ResetBaseUrlConfig,
    private readonly sessions?: SessionRevoker,
  ) {}

  /**
   * Issue + email a reset token. Never throws on unknown email.
   * SEC-RESET-001: the reset link base URL comes ONLY from the trusted config
   * (APP_PUBLIC_BASE_URL or a valid app_base_url setting) — never from request
   * headers. In production with no trusted base URL configured, the reset is
   * blocked (fail closed) rather than emitting a header-poisonable link.
   */
  async requestReset(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user || !user.isActive) {
      this.log.info({ email }, "password reset requested for unknown/inactive account (ignored)");
      return;
    }

    // Resolve the trusted base URL BEFORE creating a token (fail fast).
    const dbBaseUrl = await this.mailer.baseUrl();
    let base = resolveTrustedBaseUrl({
      envBaseUrl: this.cfg.publicBaseUrl,
      dbBaseUrl,
      allowHttp: !this.cfg.isProd,
    });
    if (!base) {
      if (this.cfg.isProd) {
        // Fail closed: never build a reset link from request-derived data.
        this.log.error(
          { userId: user.id },
          "password reset blocked: no trusted APP_PUBLIC_BASE_URL / app_base_url configured",
        );
        await this.audit.log({
          userId: user.id,
          action: "password_change",
          success: false,
          details: { stage: "reset_blocked_no_base_url" },
        });
        throw new DomainError(
          "reset_unavailable",
          "password reset is not available: no trusted public base URL is configured",
        );
      }
      // Development/test only: an explicit safe local default (never headers).
      base = "http://localhost:1420";
    }

    const ttlMinutes = await this.mailer.resetTtlMinutes();
    const raw = randomBytes(32).toString("base64url");
    await this.resets.invalidateForUser(user.id);
    await this.resets.create(user.id, hashToken(raw), new Date(Date.now() + ttlMinutes * 60 * 1000));

    // Point at the app root with the token as a query param: the root always
    // serves the SPA, so the link works even without server-side deep-link
    // (history) fallback. The app forwards it to the reset screen on load.
    const link = `${base.replace(/\/+$/, "")}/?reset_token=${raw}`;

    if (await this.mailer.isConfigured()) {
      try {
        await this.mailer.sendPasswordReset(user.email, link, ttlMinutes);
      } catch (e) {
        this.log.error({ err: e instanceof Error ? e.message : e }, "failed to send password reset email");
      }
    } else {
      this.log.warn({ userId: user.id }, "password reset requested but SMTP is not configured — email not sent");
    }
    await this.audit.log({ userId: user.id, action: "password_change", success: true, details: { stage: "reset_requested" } });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const rec = await this.resets.findValid(hashToken(token));
    if (!rec) throw new DomainError("invalid_token", "this reset link is invalid or has expired");
    if (!validatePassword(newPassword)) throw Errors.WeakPassword();

    const hash = await this.argon2.hash(newPassword);
    // SEC-RESET-RACE-001: consume the link atomically BEFORE changing the
    // password, so two parallel requests with one link cannot both succeed.
    if (!(await this.resets.claim(rec.id))) {
      throw new DomainError("invalid_token", "this reset link is invalid or has expired");
    }
    await this.users.updatePasswordHash(rec.userId, hash);
    // SEC-SESSION-001: a reset invalidates ALL prior state — bump auth_version
    // (old access tokens fail), revoke refresh sessions, close live remote
    // sessions (SSH/Telnet/Tunnel/VNC).
    await this.users.incrementAuthVersion(rec.userId);
    await this.refresh.revokeAllForUser(rec.userId);
    this.sessions?.revokeUser(rec.userId, "CREDENTIALS_CHANGED");
    await this.audit.log({ userId: rec.userId, action: "password_change", success: true, details: { stage: "reset_completed" } });
  }
}
