/**
 * Self-service password change (Phase 2.x).
 *
 * Re-authenticates with the current password, enforces the password policy,
 * stores the new hash, and revokes all of the user's refresh sessions so any
 * other devices are forced to sign in again with the new password.
 */
import type { UserRepository } from "../repos/userRepo.js";
import type { RefreshRepository, AuditRepository } from "../repos/otherRepos.js";
import type { Argon2Service } from "../crypto/argon2.js";
import { Errors, DomainError } from "../domain/index.js";
import { validatePassword } from "./register.js";

export class ChangePasswordUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly refresh: RefreshRepository,
    private readonly audit: AuditRepository,
    private readonly argon2: Argon2Service,
  ) {}

  /** Verify a user's current password (used to unlock the app's idle lock). */
  async verify(userId: string, password: string): Promise<boolean> {
    try {
      const user = await this.users.getById(userId);
      return await this.argon2.verify(user.passwordHash, password);
    } catch {
      return false;
    }
  }

  async execute(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.users.getById(userId);

    const ok = await this.argon2.verify(user.passwordHash, currentPassword);
    if (!ok) {
      await this.audit.log({
        userId, action: "password_change", success: false,
        details: { reason: "bad_current_password" },
      });
      throw Errors.InvalidCredentials();
    }

    if (!validatePassword(newPassword)) throw Errors.WeakPassword();

    // Reject a no-op change (new password identical to the current one).
    if (await this.argon2.verify(user.passwordHash, newPassword)) {
      throw new DomainError("password_unchanged", "new password must differ from the current one");
    }

    const passwordHash = await this.argon2.hash(newPassword);
    await this.users.updatePasswordHash(userId, passwordHash);

    // Force re-login everywhere else.
    await this.refresh.revokeAllForUser(userId);

    await this.audit.log({
      userId, action: "password_change", success: true,
    });
  }
}
