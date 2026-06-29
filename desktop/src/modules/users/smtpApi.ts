/** SMTP configuration API (admin only). */
import { request } from "@/shared/lib/api";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  base_url: string;
  allow_invalid_certs: boolean;
  reset_ttl_minutes: number;
  reset_subject: string;
  reset_body: string;
  has_password: boolean;
  configured: boolean;
}

export interface SmtpUpdate {
  host?: string | null;
  port?: number | null;
  secure?: boolean | null;
  user?: string | null;
  password?: string | null;
  from?: string | null;
  base_url?: string | null;
  allow_invalid_certs?: boolean | null;
  reset_ttl_minutes?: number | null;
  reset_subject?: string | null;
  reset_body?: string | null;
}

export const smtpApi = {
  get() {
    return request<SmtpConfig>("/api/v1/admin/smtp");
  },
  update(patch: SmtpUpdate) {
    return request<SmtpConfig>("/api/v1/admin/smtp", { method: "PUT", body: patch });
  },
  test(to: string) {
    return request<{ ok: boolean }>("/api/v1/admin/smtp/test", { method: "POST", body: { to } });
  },
};
