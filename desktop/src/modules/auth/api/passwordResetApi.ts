/** Public forgot/reset-password API. */
import { request } from "@/shared/lib/api";

export const passwordResetApi = {
  forgot(email: string) {
    return request<{ ok: boolean }>("/api/v1/auth/forgot-password", {
      method: "POST", body: { email }, unauthenticated: true,
    });
  },
  reset(token: string, password: string) {
    return request<{ ok: boolean }>("/api/v1/auth/reset-password", {
      method: "POST", body: { token, password }, unauthenticated: true,
    });
  },
};
