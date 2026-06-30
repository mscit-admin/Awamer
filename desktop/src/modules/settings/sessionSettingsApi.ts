/** Instance-wide SSH session settings (admin only). */
import { request } from "@/shared/lib/api";

export const sessionSettingsApi = {
  get() {
    return request<{ ssh_idle_timeout_minutes: number }>("/api/v1/admin/session-settings");
  },
  update(minutes: number) {
    return request<{ ssh_idle_timeout_minutes: number }>("/api/v1/admin/session-settings", {
      method: "PUT",
      body: { ssh_idle_timeout_minutes: minutes },
    });
  },
};
