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
 *   PATCH /api/v1/users/me           (auth)
 */
import { request } from "@/shared/lib/api";

export interface User {
  id: string;
  username: string;
  email: string;
  full_name?: string;
  role: string;
  mfa_enabled: boolean;
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

  refresh(refreshToken: string) {
    return request<TokenResponse>("/api/v1/auth/refresh", {
      method: "POST",
      body: { refresh_token: refreshToken },
      unauthenticated: true,
    });
  },

  logout() {
    return request<void>("/api/v1/auth/logout", {
      method: "POST",
    }).catch(() => undefined); // best-effort; client clears state anyway
  },

  me() {
    return request<User>("/api/v1/users/me");
  },

  updateMe(input: { full_name?: string; email?: string }) {
    return request<User>("/api/v1/users/me", {
      method: "PATCH",
      body: input,
    });
  },

  // MFA
  mfaEnroll(deviceName?: string) {
    return request<MFAEnrollResponse>("/api/v1/auth/mfa/enroll", {
      method: "POST",
      body: { device_name: deviceName ?? "Authenticator" },
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

  /** Disable MFA for the current user. Requires current password. */
  mfaDisable(password: string) {
    return request<void>("/api/v1/auth/mfa/disable", {
      method: "POST",
      body: { password },
    });
  },
};
