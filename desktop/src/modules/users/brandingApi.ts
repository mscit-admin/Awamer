/** Branding read/update API. GET is public; PUT requires admin. */
import { request } from "@/shared/lib/api";

export interface Branding {
  app_name: string | null;
  logo: string | null;
  favicon: string | null;
}

export const brandingApi = {
  get() {
    return request<Branding>("/api/v1/branding", { unauthenticated: true });
  },
  update(patch: { app_name?: string | null; logo?: string | null; favicon?: string | null }) {
    return request<Branding>("/api/v1/branding", { method: "PUT", body: patch });
  },
};
