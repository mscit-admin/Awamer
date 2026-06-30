import { v4 as uuid } from "uuid";
import { authenticator } from "otplib";
import qrcode from "qrcode";
import { Errors } from "../domain/index.js";
import type { UserRepository } from "../repos/userRepo.js";
import type { MFADeviceRepository, AuditRepository } from "../repos/otherRepos.js";
import type { AppSettingsRepository } from "../repos/appSettings.js";
import type { Config } from "../config/index.js";
import type { Argon2Service } from "../crypto/argon2.js";

// 30-second window, 6 digits — RFC 6238 defaults.
authenticator.options = { window: 1, step: 30, digits: 6 };

export interface EnrollResult {
  deviceId: string;
  secret: string;       // base32, displayed to user
  otpauthUrl: string;   // for direct QR scan
  qrPngBase64: string;  // pre-rendered PNG of the otpauth URL
}

export class MFAUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly devices: MFADeviceRepository,
    private readonly audit: AuditRepository,
    private readonly cfg: Config,
    private readonly argon2: Argon2Service,
    private readonly settings: AppSettingsRepository,
  ) {}

  /**
   * The label shown at the top of the entry in authenticator apps (Google
   * Authenticator, etc.). Uses the configurable branding app name so admins can
   * rename it from the Branding screen; falls back to "Awamer". Control chars
   * and colons are stripped — a colon would corrupt the otpauth label.
   */
  private async issuer(): Promise<string> {
    let name: string | null = null;
    try {
      const s = await this.settings.getMany(["app_name"]);
      name = s["app_name"] ?? null;
    } catch { /* settings unavailable — use the default */ }
    const cleaned = (name ?? "").replace(/[\u0000-\u001f:]/g, "").trim();
    return cleaned || "Awamer";
  }

  async enroll(userId: string, deviceName: string): Promise<EnrollResult> {
    const user = await this.users.getById(userId);

    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(user.username, await this.issuer(), secret);
    const dataUrl = await qrcode.toDataURL(otpauthUrl, { width: 220, margin: 1 });
    const qrPngBase64 = dataUrl.replace(/^data:image\/png;base64,/, "");

    const deviceId = uuid();
    await this.devices.create({
      id: deviceId,
      userId,
      deviceName,
      deviceType: "totp",
      secretEnc: Buffer.from(secret, "utf8"),
      isPrimary: false,
    });
    return { deviceId, secret, otpauthUrl, qrPngBase64 };
  }

  /** Confirm a fresh enrollment by checking the user's first OTP. */
  async verifyAndActivate(userId: string, deviceId: string, code: string): Promise<void> {
    const all = await this.devices.listByUser(userId);
    const device = all.find((d) => d.id === deviceId);
    if (!device) throw Errors.InvalidMFACode();
    const secret = device.secretEnc.toString("utf8");

    if (!authenticator.check(code, secret)) {
      await this.audit.log({
        userId, action: "mfa_enroll", success: false,
        details: { reason: "bad_code", deviceId },
      });
      throw Errors.InvalidMFACode();
    }

    await this.devices.setPrimary(deviceId, userId);

    const user = await this.users.getById(userId);
    user.mfaEnabled = true;
    await this.users.update(user);

    await this.audit.log({
      userId, action: "mfa_enroll", success: true,
      resourceType: "mfa_device", resourceId: deviceId,
    });
  }

  /** Used during login step 2 — checks against the user's primary device. */
  async verifyCode(userId: string, code: string): Promise<void> {
    let device = await this.devices.getPrimary(userId);
    if (!device) {
      const all = await this.devices.listByUser(userId);
      device = all[0] ?? null;
    }
    if (!device) throw Errors.InvalidMFACode();
    const secret = device.secretEnc.toString("utf8");
    if (!authenticator.check(code, secret)) throw Errors.InvalidMFACode();
    await this.devices.updateLastUsed(device.id);
  }

  /**
   * Disable MFA for the user. Requires the current password as a
   * re-authentication step — stops a stolen access token from being
   * enough to weaken the account's security.
   *
   * Deletes ALL MFA devices (TOTP, backup codes, etc.) and clears the
   * mfa_enabled flag. The action is audit-logged.
   */
  async disable(userId: string, currentPassword: string): Promise<void> {
    const user = await this.users.getById(userId);

    const ok = await this.argon2.verify(user.passwordHash, currentPassword);
    if (!ok) {
      await this.audit.log({
        userId, action: "mfa_disable", success: false,
        details: { reason: "bad_password" },
      });
      throw Errors.InvalidCredentials();
    }

    // Remove every MFA device (we keep DELETE atomic per device but that
    // keeps the audit trail simpler than a bulk DELETE).
    const devices = await this.devices.listByUser(userId);
    for (const d of devices) {
      await this.devices.delete(d.id, userId);
    }

    // Clear the flag on the user record.
    user.mfaEnabled = false;
    await this.users.update(user);

    await this.audit.log({
      userId, action: "mfa_disable", success: true,
      details: { devices_removed: devices.length },
    });
  }
}
