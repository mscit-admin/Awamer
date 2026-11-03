/**
 * Auth API client — wraps the auth-service endpoints behind a typed surface
 * so React components don't have to think about HTTP details.
 *
 * Endpoint inventory (Phase 1 backend):
 *   POST /api/v1/auth/login
 *   POST /api/v1/auth/refresh
 *   POST /api/v1/auth/logout
 *   POST /api/v1/auth/mfa/verify     (login challenge)
 *   POST /api/v1/auth/mfa/enroll     (auth)
 *   POST /api/v1/auth/mfa/activate   (auth, confirms enrollment)
 *   GET  /api/v1/users/me            (auth)
 *   PATCH /api/v1/users/me           (auth; email change needs an email_change step-up)
 *   POST /api/v1/auth/step-up        (auth, password [+ MFA code] → single-use token)
 */
import { request } from "@/shared/lib/api";

export interface User {
  id: string;
  username: string;
  email: string;
  full_name?: string;
  role: string;
  permissions?: string[];
  mfa_enabled: boolean;
  /** SEC-MFA-POLICY-001: this user's role must have MFA (cannot disable it). */
  mfa_policy_required?: boolean;
  /** SEC-MFA-POLICY-001: role requires MFA and none is enrolled yet. */
  mfa_enrollment_required?: boolean;
  /** SEC-PW-TEMP-001: the password was set by an admin and must be replaced first. */
  password_change_required?: boolean;
  company_id?: string | null;
  org_unit_id?: string | null;
}

export interface LoginResponse {
  mfa_required?: boolean;
  mfa_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
  user?: User;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  user?: User;
}

/** Purposes a step-up token can be minted for (bound server-side). */
export type StepUpPurpose = "mfa_change" | "email_change";

export interface MFAEnrollResponse {
  device_id: string;
  secret: string;
  otpauth_url: string;
  qr_code_png: string; // base64-encoded PNG bytes
  recovery_hint?: string;
}

export const authApi = {
  login(username: string, password: string) {
    return request<LoginResponse>("/api/v1/auth/login", {
      method: "POST",
      body: { username, password },
      unauthenticated: true,
    });
  },

  refresh(refreshToken?: string | null) {
    // SEC-019: the browser sends no body token — the HttpOnly cookie is used.
    // Tauri passes its keyring token in the body.
    return request<TokenResponse>("/api/v1/auth/refresh", {
      method: "POST",
      body: refreshToken ? { refresh_token: refreshToken } : {},
      unauthenticated: true,
    });
  },

  logout(refreshToken?: string | null) {
    // SEC-017: hand the server the refresh token so it revokes that session
    // server-side (not just a client-side wipe). Best-effort — the client
    // clears local state regardless.
    return request<void>("/api/v1/auth/logout", {
      method: "POST",
      body: refreshToken ? { refresh_token: refreshToken } : {},
      unauthenticated: true,
    }).catch(() => undefined);
  },

  me() {
    return request<User>("/api/v1/users/me");
  },

  /** Minimal user directory for share pickers (any authenticated user). */
  directory() {
    return request<{ data: { id: string; username: string; full_name: string | null }[] }>(
      "/api/v1/users/directory",
    );
  },

  /** Changing `email` requires `stepUpToken` minted for "email_change". */
  updateMe(input: { full_name?: string; email?: string }, stepUpToken?: string) {
    return request<User>("/api/v1/users/me", {
      method: "PATCH",
      // In the body, not a header: X-Step-Up-Token is not a CORS-allowed header.
      body: stepUpToken ? { ...input, step_up_token: stepUpToken } : input,
    });
  },

  /**
   * Re-authenticate (password, plus the current MFA code when MFA is on) for a
   * single sensitive action. Returns a short-lived single-use token.
   */
  stepUp(password: string, purpose: StepUpPurpose, mfaCode?: string) {
    return request<{ step_up_token: string; expires_in: number }>("/api/v1/auth/step-up", {
      method: "POST",
      body: { password, purpose, ...(mfaCode ? { mfa_code: mfaCode } : {}) },
    });
  },

  // MFA
  mfaEnroll(stepUpToken: string, deviceName?: string) {
    return request<MFAEnrollResponse>("/api/v1/auth/mfa/enroll", {
      method: "POST",
      body: { device_name: deviceName ?? "Authenticator", step_up_token: stepUpToken },
    });
  },

  /** Activate (confirm) an enrolled MFA device with its first valid code. */
  mfaActivate(deviceId: string, code: string) {
    return request<void>("/api/v1/auth/mfa/activate", {
      method: "POST",
      body: { device_id: deviceId, code },
    });
  },

  /** Complete an MFA login challenge using the short-lived MFA token. */
  mfaVerify(code: string, mfaToken: string) {
    return request<TokenResponse>("/api/v1/auth/mfa/verify", {
      method: "POST",
      body: { code },
      bearerOverride: mfaToken,
    });
  },

  /** Disable MFA for the current user. Requires an "mfa_change" step-up. */
  mfaDisable(stepUpToken: string) {
    return request<void>("/api/v1/auth/mfa/disable", {
      method: "POST",
      body: { step_up_token: stepUpToken },
    });
  },

  /** Self-service password change. Revokes other sessions on success. */
  changePassword(currentPassword: string, newPassword: string) {
    return request<{ status: string }>("/api/v1/auth/change-password", {
      method: "POST",
      body: { current_password: currentPassword, new_password: newPassword },
    });
  },
};
