import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";

/**
 * Phase 10 — encryption at rest for credential secrets.
 *
 * Credential `secret_data` was stored as plaintext JSONB in Phase 2. This
 * module wraps the secret object in an authenticated-encryption envelope
 * (AES-256-GCM) before it ever reaches the database, and unwraps it on read.
 * The transformation is transparent to callers: routes and the desktop still
 * see a plain `secretData` object.
 *
 * No external dependency — uses Node's built-in `crypto`.
 *
 * Key management
 * --------------
 * The data key comes from `CREDENTIAL_ENCRYPTION_KEY` (32 bytes, base64 or
 * hex). If that is unset, the key is derived from `JWT_REFRESH_SECRET` via
 * HKDF-SHA256 so encryption is *always on*, even in a dev setup that hasn't
 * provisioned a dedicated key. Production refuses to start without an explicit
 * key (see `resolveSecretKey`).
 */

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM standard nonce length
const ENVELOPE_VERSION = 1;

/** On-disk shape of an encrypted secret. Stored as JSONB. */
export interface SecretEnvelope {
  /** Version marker — also distinguishes envelopes from legacy plaintext. */
  __enc__: number;
  /** base64 nonce */
  iv: string;
  /** base64 GCM auth tag */
  tag: string;
  /** base64 ciphertext of the UTF-8 JSON plaintext */
  ct: string;
}

export function isSecretEnvelope(v: unknown): v is SecretEnvelope {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.__enc__ === ENVELOPE_VERSION &&
    typeof o.iv === "string" &&
    typeof o.tag === "string" &&
    typeof o.ct === "string"
  );
}

/**
 * Resolve the 32-byte data key.
 *
 * - `CREDENTIAL_ENCRYPTION_KEY` set → decode it (base64 first, hex fallback)
 *   and require exactly 32 bytes.
 * - unset in dev/staging → derive deterministically from JWT_REFRESH_SECRET
 *   via HKDF and warn loudly.
 * - unset in production → throw; an explicit key is mandatory.
 */
export function resolveSecretKey(cfg: Config, log: Logger): Buffer {
  const raw = cfg.env.CREDENTIAL_ENCRYPTION_KEY?.trim();

  if (raw) {
    let key: Buffer | null = null;
    // Try base64 then hex; validate the decoded length is exactly 32 bytes.
    const b64 = Buffer.from(raw, "base64");
    if (b64.length === KEY_BYTES) {
      key = b64;
    } else {
      const hex = Buffer.from(raw, "hex");
      if (hex.length === KEY_BYTES) key = hex;
    }
    if (!key) {
      throw new Error(
        "CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes " +
          "(base64 or hex). Generate one with: " +
          "openssl rand -base64 32",
      );
    }
    return key;
  }

  if (cfg.isProd) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY is required in production. " +
        "Generate one with: openssl rand -base64 32",
    );
  }

  log.warn(
    "CREDENTIAL_ENCRYPTION_KEY not set — deriving a credential encryption " +
      "key from JWT_REFRESH_SECRET (dev only). Set a dedicated key before " +
      "production: openssl rand -base64 32",
  );
  // Deterministic derivation so encrypted rows survive restarts in dev.
  const ikm = Buffer.from(cfg.env.JWT_REFRESH_SECRET, "utf8");
  const salt = Buffer.from("netsphere/credential-secret/v1", "utf8");
  const info = Buffer.from("aes-256-gcm data key", "utf8");
  const derived = hkdfSync("sha256", ikm, salt, info, KEY_BYTES);
  return Buffer.from(derived);
}

export interface SecretBox {
  encrypt(plain: Record<string, unknown>): SecretEnvelope;
  decrypt(env: SecretEnvelope): Record<string, unknown>;
  /** Pass through an already-plaintext value (legacy rows) unchanged. */
  open(stored: unknown): Record<string, unknown>;
  /** Wrap a value for storage; `{}` stays `{}` to avoid encrypting nothing. */
  seal(plain: Record<string, unknown>): SecretEnvelope | Record<string, unknown>;
}

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== KEY_BYTES) {
    throw new Error(`secretBox: key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }

  function encrypt(plain: Record<string, unknown>): SecretEnvelope {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const pt = Buffer.from(JSON.stringify(plain), "utf8");
    const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      __enc__: ENVELOPE_VERSION,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ct: ct.toString("base64"),
    };
  }

  function decrypt(env: SecretEnvelope): Record<string, unknown> {
    const iv = Buffer.from(env.iv, "base64");
    const tag = Buffer.from(env.tag, "base64");
    const ct = Buffer.from(env.ct, "base64");
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    const parsed = JSON.parse(pt.toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  }

  return {
    encrypt,
    decrypt,
    open(stored: unknown): Record<string, unknown> {
      if (isSecretEnvelope(stored)) return decrypt(stored);
      // Legacy plaintext JSONB (pre-Phase-10) or empty — return as-is.
      if (stored && typeof stored === "object") return stored as Record<string, unknown>;
      return {};
    },
    seal(plain: Record<string, unknown>): SecretEnvelope | Record<string, unknown> {
      // Don't encrypt an empty object — keeps "no secret" rows readable and
      // avoids a useless envelope. Any non-empty payload is encrypted.
      if (!plain || Object.keys(plain).length === 0) return {};
      return encrypt(plain);
    },
  };
}
