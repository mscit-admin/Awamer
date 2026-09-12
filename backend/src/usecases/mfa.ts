import { v4 as uuid } from "uuid";
import { authenticator } from "otplib";
import qrcode from "qrcode";
import { Errors } from "../domain/index.js";
import type { UserRepository } from "../repos/userRepo.js";
import type { MFADeviceRepository, AuditRepository, RefreshRepository } from "../repos/otherRepos.js";
import type { AppSettingsRepository } from "../repos/appSettings.js";
import type { Config } from "../config/index.js";
import type { Argon2Service } from "../crypto/argon2.js";
import type { SecretBox } from "../crypto/secretBox.js";
import type { SessionRevoker } from "../session/activeSessions.js";

// 30-second window, 6 digits — RFC 6238 defaults.
authenticator.options = { window: 1, step: 30, digits: 6 };

/**
 * MFA fail-closed hardening — a stored TOTP secret that is NOT in the expected
 * encrypted envelope (legacy plaintext, corruption, tampering, or a wrong key)
 * must never be interpreted as a seed. It is surfaced as this sanitized error
 * (no secret material in the message) so callers deny authentication instead of
 * trusting an unexpected value.
 */
export class MfaSecretError extends Error {
  readonly code = "mfa_secret_unreadable";
  constructor() {
    super("stored MFA secret is not in the expected encrypted format");
    this.name = "MfaSecretError";
  }
}

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
    private readonly secretBox: SecretBox,
    private readonly settings: AppSettingsRepository,
    private readonly refresh?: RefreshRepository,
    private readonly sessions?: SessionRevoker,
  ) {}

  /** SEC-MFA-001: encrypt the base32 TOTP secret for `secret_enc` storage. */
  private sealSecret(secret: string): Buffer {
    return this.secretBox.sealBytes(Buffer.from(secret, "utf8"));
  }

  /**
   * Decrypt a stored TOTP secret, FAIL-CLOSED. After the startup migration
   * (`reencryptLegacyMfaSecrets`, which runs before the service accepts traffic)
   * every secret is an AES-256-GCM envelope. A value that is NOT a sealed
   * envelope — legacy plaintext that somehow survived, corruption, or tampering
   * — is rejected with a sanitized `MfaSecretError` rather than being trusted as
   * a plaintext seed. A malformed/tampered envelope, or the wrong key, makes
   * `openBytes` throw (GCM auth failure), which is equally fail-closed. The
   * secret is never logged or echoed.
   */
  private openSecret(secretEnc: Buffer): string {
    if (!this.secretBox.isSealedBytes(secretEnc)) {
      throw new MfaSecretError();
    }
    return this.secretBox.openBytes(secretEnc).toString("utf8");
  }

  /**
   * SEC-SESSION-001 — an MFA security change (activation/replacement/disable)
   * invalidates prior authenticated state: bump auth_version (old access tokens
   * fail), revoke refresh sessions, and close live remote sessions.
   */
  private async invalidateAllSessions(userId: string): Promise<void> {
    await this.users.incrementAuthVersion(userId);
    await this.refresh?.revokeAllForUser(userId);
    this.sessions?.revokeUser(userId, "CREDENTIALS_CHANGED");
  }

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
      secretEnc: this.sealSecret(secret),
      isPrimary: false,
    });
    return { deviceId, secret, otpauthUrl, qrPngBase64 };
  }

  /** Confirm a fresh enrollment by checking the user's first OTP. */
  async verifyAndActivate(userId: string, deviceId: string, code: string): Promise<void> {
    const all = await this.devices.listByUser(userId);
    const device = all.find((d) => d.id === deviceId);
    if (!device) throw Errors.InvalidMFACode();
    const secret = this.openSecret(device.secretEnc);

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
    await this.invalidateAllSessions(userId);

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
    const secret = this.openSecret(device.secretEnc);
    if (!authenticator.check(code, secret)) throw Errors.InvalidMFACode();
    await this.devices.updateLastUsed(device.id);
  }

  /**
   * Admin action: disable MFA for another user (no password needed). Removes
   * every MFA device and clears the flag; the acting admin is audit-logged.
   * Used by user administration to help a user locked out of their authenticator.
   */
  async adminDisable(adminId: string, userId: string): Promise<void> {
    const user = await this.users.getById(userId);
    const devices = await this.devices.listByUser(userId);
    for (const d of devices) await this.devices.delete(d.id, userId);
    user.mfaEnabled = false;
    await this.users.update(user);
    await this.invalidateAllSessions(userId);
    await this.audit.log({
      userId: adminId, action: "mfa_disable", success: true,
      resourceType: "user", resourceId: userId, details: { admin_disable: true, devices_removed: devices.length },
    });
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
    await this.removeAllDevices(userId);
  }

  /**
   * SEC-MFA-002 — disable MFA after a step-up token has already re-authenticated
   * the user (password + current MFA). No password argument is needed here.
   */
  async disableAfterStepUp(userId: string): Promise<void> {
    await this.removeAllDevices(userId);
  }

  /** Shared teardown: delete devices, clear flag, invalidate sessions, audit. */
  private async removeAllDevices(userId: string): Promise<void> {
    const user = await this.users.getById(userId);
    const devices = await this.devices.listByUser(userId);
    for (const d of devices) {
      await this.devices.delete(d.id, userId);
    }
    user.mfaEnabled = false;
    await this.users.update(user);
    await this.invalidateAllSessions(userId);
    await this.audit.log({
      userId, action: "mfa_disable", success: true,
      details: { devices_removed: devices.length },
    });
  }
}
