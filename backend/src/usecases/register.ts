import { v4 as uuid } from "uuid";
import { Errors, type Role, isRole } from "../domain/index.js";
import type { UserRepository } from "../repos/userRepo.js";
import type { AuditRepository } from "../repos/otherRepos.js";
import type { Argon2Service } from "../crypto/argon2.js";

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  fullName?: string | null;
  role?: string;
}

export class RegisterUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly audit: AuditRepository,
    private readonly argon2: Argon2Service,
  ) {}

  async execute(input: RegisterInput) {
    if (!validatePassword(input.password)) throw Errors.WeakPassword();

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
    });
    await this.audit.log({
      userId: user.id, action: "user_create", success: true,
      resourceType: "user", resourceId: user.id,
    });
    return user;
  }
}

/** Phase 1 password policy: ≥12 chars with mixed classes. */
export function validatePassword(p: string): boolean {
  if (p.length < 12) return false;
  let upper = false, lower = false, digit = false, sym = false;
  for (const c of p) {
    if (c >= "A" && c <= "Z") upper = true;
    else if (c >= "a" && c <= "z") lower = true;
    else if (c >= "0" && c <= "9") digit = true;
    else if (`!@#$%^&*()-_=+[]{};:,.<>/?\\|\`~"'`.includes(c)) sym = true;
  }
  return upper && lower && digit && sym;
}
