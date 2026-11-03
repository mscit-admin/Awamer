/** Instance-wide session + MFA policy settings (settings:manage — Super Admin). */
import { request } from "@/shared/lib/api";

export interface SessionSettings {
  ssh_idle_timeout_minutes: number;
  /** SEC-MFA-POLICY-001: role keys whose members must enroll MFA. */
  mfa_required_roles: string[];
}

export const sessionSettingsApi = {
  get() {
    return request<SessionSettings>("/api/v1/admin/session-settings");
  },
  update(minutes: number) {
    return request<SessionSettings>("/api/v1/admin/session-settings", {
      method: "PUT",
      body: { ssh_idle_timeout_minutes: minutes },
    });
  },
  updateMfaRequiredRoles(roles: string[]) {
    return request<SessionSettings>("/api/v1/admin/session-settings", {
      method: "PUT",
      body: { mfa_required_roles: roles },
    });
  },
};
