/**
 * SMTP configuration + transactional email.
 *
 * Settings live in app_settings (instance-wide, admin-editable). The SMTP
 * password is encrypted at rest with the credential SecretBox — never returned
 * to clients. Used for the forgot-password flow and an admin "send test" check.
 */
import nodemailer, { type Transporter } from "nodemailer";
import type { AppSettingsRepository } from "../repos/appSettings.js";
import type { SecretBox } from "../crypto/secretBox.js";
import type { Logger } from "../logger/index.js";

const K = {
  host: "smtp_host", port: "smtp_port", secure: "smtp_secure",
  user: "smtp_user", pass: "smtp_pass", from: "smtp_from", baseUrl: "app_base_url",
  allowInvalid: "smtp_allow_invalid_certs",
  resetTtl: "reset_ttl_minutes", resetSubject: "reset_subject", resetBody: "reset_body",
} as const;
const KEYS = Object.values(K);

export const DEFAULT_RESET_TTL_MINUTES = 60;
export const DEFAULT_RESET_SUBJECT = "Reset your password";
export const DEFAULT_RESET_BODY =
  "A password reset was requested for your account.\n\n" +
  "Reset link (valid for {{minutes}} minutes):\n{{link}}\n\n" +
  "If you didn't request this, you can ignore this email.";

/** SMTP config as shown to admins — never includes the actual password. */
export interface SmtpPublicConfig {
  host: string; port: number; secure: boolean;
  user: string; from: string; base_url: string;
  allow_invalid_certs: boolean;
  reset_ttl_minutes: number; reset_subject: string; reset_body: string;
  has_password: boolean; configured: boolean;
}

export interface SmtpUpdate {
  host?: string | null; port?: number | null; secure?: boolean | null;
  user?: string | null; password?: string | null; from?: string | null; base_url?: string | null;
  allow_invalid_certs?: boolean | null;
  reset_ttl_minutes?: number | null; reset_subject?: string | null; reset_body?: string | null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export class MailService {
  constructor(
    private readonly settings: AppSettingsRepository,
    private readonly box: SecretBox,
    private readonly log: Logger,
  ) {}

  async getPublicConfig(): Promise<SmtpPublicConfig> {
    const s = await this.settings.getMany(KEYS);
    return {
      host: s[K.host] ?? "",
      port: s[K.port] ? Number(s[K.port]) : 587,
      secure: s[K.secure] === "true",
      user: s[K.user] ?? "",
      from: s[K.from] ?? "",
      base_url: s[K.baseUrl] ?? "",
      allow_invalid_certs: s[K.allowInvalid] === "true",
      reset_ttl_minutes: s[K.resetTtl] ? Number(s[K.resetTtl]) : DEFAULT_RESET_TTL_MINUTES,
      reset_subject: s[K.resetSubject] ?? DEFAULT_RESET_SUBJECT,
      reset_body: s[K.resetBody] ?? DEFAULT_RESET_BODY,
      has_password: !!s[K.pass],
      configured: !!(s[K.host] && s[K.from]),
    };
  }

  /** Configured reset-token validity in minutes (clamped 5..1440). */
  async resetTtlMinutes(): Promise<number> {
    const s = await this.settings.getMany([K.resetTtl]);
    const n = s[K.resetTtl] ? Number(s[K.resetTtl]) : DEFAULT_RESET_TTL_MINUTES;
    return Math.max(5, Math.min(1440, Number.isFinite(n) ? n : DEFAULT_RESET_TTL_MINUTES));
  }

  async update(patch: SmtpUpdate): Promise<void> {
    if (patch.host !== undefined) await this.settings.set(K.host, patch.host?.trim() || null);
    if (patch.port !== undefined) await this.settings.set(K.port, patch.port != null ? String(patch.port) : null);
    if (patch.secure !== undefined) await this.settings.set(K.secure, patch.secure ? "true" : "false");
    if (patch.user !== undefined) await this.settings.set(K.user, patch.user?.trim() || null);
    if (patch.from !== undefined) await this.settings.set(K.from, patch.from?.trim() || null);
    if (patch.base_url !== undefined) await this.settings.set(K.baseUrl, patch.base_url?.trim().replace(/\/+$/, "") || null);
    if (patch.allow_invalid_certs !== undefined) await this.settings.set(K.allowInvalid, patch.allow_invalid_certs ? "true" : "false");
    if (patch.reset_ttl_minutes !== undefined) await this.settings.set(K.resetTtl, patch.reset_ttl_minutes != null ? String(Math.max(5, Math.min(1440, patch.reset_ttl_minutes))) : null);
    if (patch.reset_subject !== undefined) await this.settings.set(K.resetSubject, patch.reset_subject?.trim() || null);
    if (patch.reset_body !== undefined) await this.settings.set(K.resetBody, patch.reset_body || null);
    // Password: only overwrite when a non-empty value is supplied; "" keeps existing.
    if (patch.password) {
      await this.settings.set(K.pass, JSON.stringify(this.box.seal({ pass: patch.password })));
    } else if (patch.password === null) {
      await this.settings.set(K.pass, null);
    }
  }

  async baseUrl(): Promise<string> {
    const s = await this.settings.getMany([K.baseUrl]);
    return s[K.baseUrl] ?? "";
  }

  private async transport(): Promise<{ tx: Transporter; from: string } | null> {
    const s = await this.settings.getMany(KEYS);
    if (!s[K.host] || !s[K.from]) return null;
    let pass: string | undefined;
    if (s[K.pass]) {
      try { pass = (this.box.open(JSON.parse(s[K.pass]!)) as { pass?: string }).pass; } catch { /* ignore */ }
    }
    const user = s[K.user] || undefined;
    const tx = nodemailer.createTransport({
      host: s[K.host]!,
      port: s[K.port] ? Number(s[K.port]) : 587,
      secure: s[K.secure] === "true",
      auth: user ? { user, pass } : undefined,
      // Self-hosted servers often present self-signed / mismatched certs.
      ...(s[K.allowInvalid] === "true" ? { tls: { rejectUnauthorized: false } } : {}),
    });
    return { tx, from: s[K.from]! };
  }

  async isConfigured(): Promise<boolean> {
    const s = await this.settings.getMany([K.host, K.from]);
    return !!(s[K.host] && s[K.from]);
  }

  async send(msg: { to: string; subject: string; text: string; html?: string }): Promise<void> {
    const t = await this.transport();
    if (!t) throw new Error("SMTP is not configured");
    await t.tx.sendMail({ from: t.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
  }

  async sendTest(to: string): Promise<void> {
    await this.send({
      to,
      subject: "Awamer SMTP test",
      text: "This is a test email from Awamer. Your SMTP settings are working.",
    });
  }

  async sendPasswordReset(to: string, link: string, ttlMinutes: number): Promise<void> {
    const s = await this.settings.getMany([K.resetSubject, K.resetBody]);
    const subject = s[K.resetSubject]?.trim() || DEFAULT_RESET_SUBJECT;
    const template = s[K.resetBody] || DEFAULT_RESET_BODY;

    // Substitute placeholders. Plain-text uses the raw URL; HTML turns the
    // {{link}} token into an anchor after escaping the rest.
    const withMinutes = template.replace(/\{\{\s*minutes\s*\}\}/g, String(ttlMinutes));
    const text = withMinutes.replace(/\{\{\s*link\s*\}\}/g, link);
    const html = escapeHtml(withMinutes)
      .replace(/\n/g, "<br>")
      .replace(/\{\{\s*link\s*\}\}/g, `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`);

    await this.send({ to, subject, text, html });
  }
}
