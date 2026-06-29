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

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
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
  ) {}

  /** Issue + email a reset token. Never throws on unknown email. */
  async requestReset(email: string, fallbackBaseUrl: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user || !user.isActive) {
      this.log.info({ email }, "password reset requested for unknown/inactive account (ignored)");
      return;
    }
    const raw = randomBytes(32).toString("base64url");
    await this.resets.invalidateForUser(user.id);
    await this.resets.create(user.id, hashToken(raw), new Date(Date.now() + TOKEN_TTL_MS));

    const base = (await this.mailer.baseUrl()) || fallbackBaseUrl;
    const link = `${base.replace(/\/+$/, "")}/reset-password?token=${raw}`;

    if (await this.mailer.isConfigured()) {
      try {
        await this.mailer.sendPasswordReset(user.email, link);
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
    await this.users.updatePasswordHash(rec.userId, hash);
    await this.resets.markUsed(rec.id);
    await this.refresh.revokeAllForUser(rec.userId);
    await this.audit.log({ userId: rec.userId, action: "password_change", success: true, details: { stage: "reset_completed" } });
  }
}
