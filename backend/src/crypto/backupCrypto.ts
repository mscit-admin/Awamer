/**
 * Passphrase-based encryption for backup files.
 *
 * Independent of the server's credential master key: a backup is encrypted with
 * a passphrase the *user* chooses, so the exported file is portable and safe at
 * rest, and can only be restored by someone who knows that passphrase. Uses
 * scrypt for key derivation and AES-256-GCM for authenticated encryption.
 */
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export interface EncryptedBackup {
  format: "awamer-backup-enc";
  version: 1;
  kdf: { algo: "scrypt"; N: number; r: number; p: number; salt: string };
  iv: string;
  tag: string;
  ct: string;
}

// scrypt cost parameters — N must be a power of two. 2^15 is a good balance for
// an interactive one-off operation.
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
}

export function encryptBackup(plaintext: string, passphrase: string): EncryptedBackup {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    format: "awamer-backup-enc",
    version: 1,
    kdf: { algo: "scrypt", N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString("base64") },
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
}

export class BackupDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupDecryptError";
  }
}

export function isEncryptedBackup(v: unknown): v is EncryptedBackup {
  return !!v && typeof v === "object" && (v as { format?: string }).format === "awamer-backup-enc";
}

export function decryptBackup(enc: EncryptedBackup, passphrase: string): string {
  try {
    const salt = Buffer.from(enc.kdf.salt, "base64");
    const key = scryptSync(passphrase, salt, KEY_LEN, {
      N: enc.kdf.N, r: enc.kdf.r, p: enc.kdf.p, maxmem: 64 * 1024 * 1024,
    });
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(enc.iv, "base64"));
    decipher.setAuthTag(Buffer.from(enc.tag, "base64"));
    const pt = Buffer.concat([decipher.update(Buffer.from(enc.ct, "base64")), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    // GCM auth failure or KDF mismatch both land here — almost always a wrong passphrase.
    throw new BackupDecryptError("could not decrypt backup — wrong passphrase or corrupted file");
  }
}
