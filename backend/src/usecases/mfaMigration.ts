/**
 * SEC-MFA-001 — one-time, idempotent, restart-safe migration of legacy PLAINTEXT
 * TOTP secrets in `mfa_devices.secret_enc` to the AES-256-GCM binary envelope.
 *
 * The column previously held the raw base32 secret as UTF-8 bytes. This runs at
 * startup (like the built-in-role reconciliation): every device whose bytes are
 * not already a sealed envelope is re-sealed in place. Already-encrypted rows
 * are skipped, so re-running is a no-op. It never logs secret content — only the
 * counts — and never deletes a device (existing authenticators keep working).
 */
import type { MFADeviceRepository } from "../repos/otherRepos.js";
import type { SecretBox } from "../crypto/secretBox.js";
import type { Logger } from "../logger/index.js";

export async function reencryptLegacyMfaSecrets(
  devices: MFADeviceRepository,
  secretBox: SecretBox,
  log: Logger,
): Promise<{ migrated: number; alreadySealed: number }> {
  const all = await devices.listAllSecrets();
  let migrated = 0;
  let alreadySealed = 0;
  for (const d of all) {
    if (secretBox.isSealedBytes(d.secretEnc)) {
      alreadySealed++;
      continue;
    }
    // Legacy plaintext → seal in place. No secret content is ever logged.
    const sealed = secretBox.sealBytes(d.secretEnc);
    await devices.updateSecret(d.id, sealed);
    migrated++;
  }
  if (migrated > 0) {
    log.info({ migrated, alreadySealed }, "SEC-MFA-001: encrypted legacy plaintext TOTP secrets at rest");
  }
  return { migrated, alreadySealed };
}
