/**
 * Auth state machine.
 *
 * Tokens live in two places:
 *   - access_token: in memory only (Zustand). Lost on reload by design.
 *   - refresh_token: in OS keyring via Tauri command.
 *
 * The store also handles the silent-refresh flow: if a request fires
 * with an expired access token, the API layer calls `refreshTokens()`
 * which uses the keyring-stored refresh token.
 */
import { create } from "zustand";

import { authApi, type User, type LoginResponse } from "@/modules/auth/api/authApi";
import { configureApiClient } from "@/shared/lib/api";
import { secureDelete, secureGet, secureSet, isTauri } from "@/shared/lib/keyring";

const REFRESH_KEY = "netsphere.refresh_token";

export type AuthStatus = "idle" | "authenticating" | "authenticated" | "mfa_required" | "unauthenticated";

interface AuthState {
  status: AuthStatus;
  user: User | null;
  accessToken: string | null;
  expiresAt: string | null;

  // MFA challenge state during login
  mfaToken: string | null;
  mfaUserId: string | null;

  // Last error message for UI display
  error: string | null;

  // Actions
  login: (username: string, password: string) => Promise<{ mfaRequired: boolean }>;
  verifyMfa: (code: string) => Promise<void>;
  logout: () => Promise<void>;
  restore: () => Promise<void>;
  refreshTokens: () => Promise<string | null>;
  refreshUser: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => {
  // Wire the API client to the store on first creation.
  configureApiClient({
    token: () => get().accessToken,
    onUnauthorized: async () => {
      return get().refreshTokens();
    },
  });

  return {
    status: "idle",
    user: null,
    accessToken: null,
    expiresAt: null,
    mfaToken: null,
    mfaUserId: null,
    error: null,

    async login(username, password) {
      set({ status: "authenticating", error: null });
      try {
        const res: LoginResponse = await authApi.login(username, password);
        if (res.mfa_required && res.mfa_token) {
          set({
            status: "mfa_required",
            mfaToken: res.mfa_token,
            mfaUserId: res.user?.id ?? null,
            user: res.user ?? null,
          });
          return { mfaRequired: true };
        }
        // SEC-019: in the browser the refresh token lives in an HttpOnly cookie
        // (not the body), so only the access token is required here.
        if (!res.access_token) {
          throw new Error("malformed login response");
        }
        if (res.refresh_token) await secureSet(REFRESH_KEY, res.refresh_token);
        set({
          status: "authenticated",
          user: res.user,
          accessToken: res.access_token,
          expiresAt: res.expires_at ?? null,
          mfaToken: null,
          mfaUserId: null,
          error: null,
        });
        return { mfaRequired: false };
      } catch (err) {
        const message = err instanceof Error ? err.message : "login failed";
        set({ status: "unauthenticated", error: message });
        throw err;
      }
    },

    async verifyMfa(code) {
      const { mfaToken } = get();
      if (!mfaToken) throw new Error("no MFA challenge in progress");
      set({ status: "authenticating", error: null });
      try {
        const res = await authApi.mfaVerify(code, mfaToken);
        if (res.refresh_token) await secureSet(REFRESH_KEY, res.refresh_token);
        set({
          status: "authenticated",
          user: res.user,
          accessToken: res.access_token,
          expiresAt: res.expires_at,
          mfaToken: null,
          mfaUserId: null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "mfa verification failed";
        set({ status: "mfa_required", error: message });
        throw err;
      }
    },

    async logout() {
      // SEC-017: revoke the session server-side before clearing local state.
      const refresh = await secureGet(REFRESH_KEY);
      await authApi.logout(refresh);
      await secureDelete(REFRESH_KEY);
      set({
        status: "unauthenticated",
        user: null,
        accessToken: null,
        expiresAt: null,
        mfaToken: null,
        mfaUserId: null,
        error: null,
      });
    },

    async restore() {
      try {
        const refresh = await secureGet(REFRESH_KEY);
        // Tauri needs a keyring token; the browser relies on the HttpOnly cookie.
        if (!refresh && isTauri) {
          set({ status: "unauthenticated" });
          return;
        }
        const res = await authApi.refresh(refresh);
        if (res.refresh_token) await secureSet(REFRESH_KEY, res.refresh_token);
        set({
          status: "authenticated",
          accessToken: res.access_token,
          expiresAt: res.expires_at,
          user: res.user ?? null,
        });
        // Backend may not include user in /refresh response — fetch /users/me to be safe.
        if (!res.user) {
          try {
            const me = await authApi.me();
            set({ user: me });
          } catch {
            // non-fatal
          }
        }
      } catch {
        await secureDelete(REFRESH_KEY);
        set({ status: "unauthenticated" });
      }
    },

    async refreshTokens() {
      const refresh = await secureGet(REFRESH_KEY);
      if (!refresh && isTauri) {
        set({ status: "unauthenticated", accessToken: null, user: null });
        return null;
      }
      try {
        const res = await authApi.refresh(refresh);
        if (res.refresh_token) await secureSet(REFRESH_KEY, res.refresh_token);
        set({ accessToken: res.access_token, expiresAt: res.expires_at });
        return res.access_token;
      } catch {
        await secureDelete(REFRESH_KEY);
        set({ status: "unauthenticated", accessToken: null, user: null });
        return null;
      }
    },

    async refreshUser() {
      try {
        const me = await authApi.me();
        set({ user: me });
      } catch {
        // ignore — caller can decide whether to log out
      }
    },

    clearError() {
      set({ error: null });
    },
  };
});
