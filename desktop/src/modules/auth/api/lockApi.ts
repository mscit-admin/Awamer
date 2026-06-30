/** Verify the current user's password (used to unlock the app idle-lock). */
import { request } from "@/shared/lib/api";

export const lockApi = {
  verifyPassword(password: string) {
    return request<{ ok: boolean }>("/api/v1/auth/verify-password", { method: "POST", body: { password } });
  },
};
