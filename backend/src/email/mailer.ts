/**
 * SMTP configuration + transactional email.
 *
 * Settings live in app_settings (instance-wide, admin-editable). The SMTP
 * password is encrypted at rest with the credential SecretBox — never returned
 * to clients. Used for the forgot-password flow and an admin "send test" check.
 */
import nodemailer from "nodemailer";
import type { AppSettingsRepository } from "../repos/appSettings.js";
import type { SecretBox } from "../crypto/secretBox.js";
import type { Logger } from "../logger/index.js";

const K = {
  host: "smtp_host", port: "smtp_port", secure: "smtp_secure",
  user: "smtp_user", pass: "smtp_pass", from: "smtp_from", baseUrl: "app_base_url",
  allowInvalid: "smtp_allow_invalid_certs",
} as const;
const KEYS = Object.values(K);

/** SMTP config as shown to admins — never includes the actual password. */
export interface SmtpPublicConfig {
  host: string; port: number; secure: boolean;
  user: string; from: string; base_url: string;
  allow_invalid_certs: boolean;
  has_password: boolean; configured: boolean;
}

export interface SmtpUpdate {
  host?: string | null; port?: number | null; secure?: boolean | null;
  user?: string | null; password?: string | null; from?: string | null; base_url?: string | null;
  allow_invalid_certs?: boolean | null;
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
      has_password: !!s[K.pass],
      configured: !!(s[K.host] && s[K.from]),
    };
  }

  async update(patch: SmtpUpdate): Promise<void> {
    if (patch.host !== undefined) await this.settings.set(K.host, patch.host?.trim() || null);
    if (patch.port !== undefined) await this.settings.set(K.port, patch.port != null ? String(patch.port) : null);
    if (patch.secure !== undefined) await this.settings.set(K.secure, patch.secure ? "true" : "false");
    if (patch.user !== undefined) await this.settings.set(K.user, patch.user?.trim() || null);
    if (patch.from !== undefined) await this.settings.set(K.from, patch.from?.trim() || null);
    if (patch.base_url !== undefined) await this.settings.set(K.baseUrl, patch.base_url?.trim().replace(/\/+$/, "") || null);
    if (patch.allow_invalid_certs !== undefined) await this.settings.set(K.allowInvalid, patch.allow_invalid_certs ? "true" : "false");
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

  private async transport(): Promise<{ tx: nodemailer.Transporter; from: string } | null> {
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

  async sendPasswordReset(to: string, link: string): Promise<void> {
    await this.send({
      to,
      subject: "Reset your Awamer password",
      text: `A password reset was requested for your account.\n\nReset link (valid for 1 hour):\n${link}\n\nIf you didn't request this, you can ignore this email.`,
      html: `<p>A password reset was requested for your account.</p>
<p><a href="${link}">Reset your password</a> (valid for 1 hour)</p>
<p style="color:#888;font-size:12px">If you didn't request this, you can ignore this email.</p>`,
    });
  }
}
