// Roles are dynamic (admin-managed, stored in the `roles` table), so a role is
// just its string key. BUILTIN_ROLE_KEYS lists the five seeded, locked roles.
export type Role = string;

export const BUILTIN_ROLE_KEYS = ["super_admin", "admin", "user", "readonly", "auditor"] as const;
export const ALL_ROLES: string[] = [...BUILTIN_ROLE_KEYS];

export function isBuiltinRole(s: string): boolean {
  return (BUILTIN_ROLE_KEYS as readonly string[]).includes(s);
}

export function isRole(s: string): s is Role {
  return typeof s === "string" && s.length > 0;
}

export interface User {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  fullName: string | null;
  role: Role;
  isActive: boolean;
  isLocked: boolean;
  failedAttempts: number;
  lastLoginAt: Date | null;
  lastLoginIp: string | null;
  mfaEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type MFAMethod = "totp" | "webauthn" | "backup_codes";

export interface MFADevice {
  id: string;
  userId: string;
  deviceName: string;
  deviceType: MFAMethod;
  secretEnc: Buffer;
  isPrimary: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface RefreshSession {
  jti: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  rotatedTo: string | null;
}

export interface AuditEvent {
  userId: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown>;
  success: boolean;
}

// ----- Domain errors -----

export class DomainError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export const Errors = {
  UserNotFound: () => new DomainError("user_not_found", "user not found"),
  UsernameTaken: () => new DomainError("username_taken", "username already exists"),
  EmailTaken: () => new DomainError("email_taken", "email already exists"),
  InvalidCredentials: () => new DomainError("invalid_credentials", "invalid username or password"),
  AccountLocked: () => new DomainError("account_locked", "account locked"),
  AccountInactive: () => new DomainError("account_inactive", "account inactive"),
  WeakPassword: () => new DomainError("weak_password", "password must be ≥12 chars with upper, lower, digit, symbol"),
  InvalidRole: () => new DomainError("invalid_role", "invalid role"),
  InvalidMFACode: () => new DomainError("invalid_mfa_code", "invalid mfa code"),
  RefreshReuse: () => new DomainError("refresh_reuse", "refresh token reuse detected"),
} as const;
