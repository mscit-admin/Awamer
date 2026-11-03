/**
 * SEC-MFA-POLICY-001 — installation-wide "MFA required" policy (ASVS V6.3.3).
 *
 * A list of role keys whose members MUST have an active TOTP device. A user in
 * such a role without MFA is confined to the enrollment endpoints (HTTP) and
 * refused on every WebSocket gateway until they enroll — see
 * `verifyCurrentAccessToken` in middleware/auth.ts.
 *
 * Stored in `app_settings` under `mfa_required_roles` as a JSON array. UNSET
 * means the secure default (super_admin + admin); an explicit `[]` is a
 * deliberate, audited opt-out by a `settings:manage` holder.
 *
 * Cached in process (single-instance model, like RoleService) and refreshed on
 * every policy update. Before the first load the default applies (fail closed).
 */

export const MFA_POLICY_KEY = "mfa_required_roles";
export const DEFAULT_MFA_REQUIRED_ROLES: readonly string[] = ["super_admin", "admin"];

let required: ReadonlySet<string> = new Set(DEFAULT_MFA_REQUIRED_ROLES);

/** True when members of `role` must have MFA enabled. */
export function mfaRequiredForRole(role: string): boolean {
  return required.has(role);
}

export function mfaRequiredRoles(): string[] {
  return [...required].sort();
}

export function setMfaRequiredRoles(roles: readonly string[]): void {
  required = new Set(roles);
}

/**
 * Parse the stored value. `null` (unset) → default. A corrupt value also falls
 * back to the default rather than silently disabling enforcement.
 */
export function parseMfaRequiredRoles(raw: string | null): string[] {
  if (raw == null) return [...DEFAULT_MFA_REQUIRED_ROLES];
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  } catch { /* fall through */ }
  return [...DEFAULT_MFA_REQUIRED_ROLES];
}

export interface MfaPolicySettingsSource {
  getMany(keys: string[]): Promise<Record<string, string | null>>;
}

/** Load the stored policy into the process cache. */
export async function loadMfaPolicy(settings: MfaPolicySettingsSource): Promise<void> {
  const s = await settings.getMany([MFA_POLICY_KEY]);
  setMfaRequiredRoles(parseMfaRequiredRoles(s[MFA_POLICY_KEY] ?? null));
}
