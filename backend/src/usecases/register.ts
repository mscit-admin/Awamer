import { v4 as uuid } from "uuid";
import { Errors, type Role, isRole } from "../domain/index.js";
import type { UserRepository } from "../repos/userRepo.js";
import type { AuditRepository } from "../repos/otherRepos.js";
import type { Argon2Service } from "../crypto/argon2.js";
import { checkPassword, validatePassword, PASSWORD_PROBLEM_MESSAGE, type PasswordContext } from "../domain/passwordPolicy.js";

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  fullName?: string | null;
  role?: string;
  companyId?: string | null;
  orgUnitId?: string | null;
}

export class RegisterUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly audit: AuditRepository,
    private readonly argon2: Argon2Service,
    /** SEC-PW-TEMP-001: lifetime of the initial (admin-chosen) password. */
    private readonly tempPasswordTtlSec = 72 * 3600,
  ) {}

  async execute(input: RegisterInput) {
    assertPasswordPolicy(input.password, { username: input.username, email: input.email, fullName: input.fullName });

    const role: Role = input.role ? (isRole(input.role) ? input.role : (() => { throw Errors.InvalidRole(); })()) : "user";

    const passwordHash = await this.argon2.hash(input.password);
    const id = uuid();
    const user = await this.users.create({
      id,
      username: input.username.trim(),
      email: input.email.trim(),
      passwordHash,
      fullName: input.fullName?.trim() ?? null,
      role,
      companyId: input.companyId ?? null,
      orgUnitId: input.orgUnitId ?? null,
      // SEC-PW-TEMP-001: accounts are created by an admin, so the initial
      // password is temporary — the user replaces it at first sign-in.
      temporaryPassword: { expiresAt: new Date(Date.now() + this.tempPasswordTtlSec * 1000) },
    });
    await this.audit.log({
      userId: user.id, action: "user_create", success: true,
      resourceType: "user", resourceId: user.id,
    });
    return user;
  }
}

/**
 * SEC-PW-POLICY-001: throw `weak_password` (with the specific reason) unless the
 * password satisfies the policy in domain/passwordPolicy.ts.
 */
export function assertPasswordPolicy(password: string, ctx: PasswordContext = {}): void {
  const problem = checkPassword(password, ctx);
  if (problem) throw Errors.WeakPassword(PASSWORD_PROBLEM_MESSAGE[problem]);
}

/** Kept for callers that only need a yes/no answer. */
export { validatePassword };
