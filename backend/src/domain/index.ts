export type Role = "super_admin" | "admin" | "user" | "readonly" | "auditor";

export const ALL_ROLES: Role[] = ["super_admin", "admin", "user", "readonly", "auditor"];

export function isRole(s: string): s is Role {
  return (ALL_ROLES as string[]).includes(s);
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
