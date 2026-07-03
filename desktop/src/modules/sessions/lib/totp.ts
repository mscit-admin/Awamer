/**
 * Client-side TOTP (RFC 6238) using Web Crypto — KeePass-style.
 *
 * The server stores the seed encrypted and only hands it back on reveal; the
 * rolling code is computed here so we never round-trip (and audit-log) the
 * server every second. Supports SHA1/256/512, 6-8 digits, custom period.
 */

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

const HASH: Record<TotpAlgorithm, string> = {
  SHA1: "SHA-1",
  SHA256: "SHA-256",
  SHA512: "SHA-512",
};

/** Decode an RFC 4648 base32 string (no padding required) to bytes. */
export function base32Decode(input: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/,"").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export interface TotpParams {
  algorithm?: TotpAlgorithm;
  digits?: number;
  period?: number;
  /** Unix time in seconds; defaults to now. */
  now?: number;
}

export interface TotpResult {
  code: string;
  secondsRemaining: number;
  period: number;
}

/** Compute the current TOTP code and how long it stays valid. */
export async function computeTotp(secretBase32: string, params: TotpParams = {}): Promise<TotpResult> {
  const algorithm = params.algorithm ?? "SHA1";
  const digits = params.digits ?? 6;
  const period = params.period ?? 30;
  const nowSec = Math.floor(params.now ?? Date.now() / 1000);
  const counter = Math.floor(nowSec / period);

  const key = base32Decode(secretBase32);
  // 8-byte big-endian counter.
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }

  const cryptoKey = await crypto.subtle.importKey(
    "raw", key.buffer as ArrayBuffer, { name: "HMAC", hash: HASH[algorithm] }, false, ["sign"],
  );
  const sigBuf = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, msg.buffer as ArrayBuffer));

  // Dynamic truncation (RFC 4226 §5.3).
  const offset = sigBuf[sigBuf.length - 1] & 0x0f;
  const binary =
    ((sigBuf[offset] & 0x7f) << 24) |
    ((sigBuf[offset + 1] & 0xff) << 16) |
    ((sigBuf[offset + 2] & 0xff) << 8) |
    (sigBuf[offset + 3] & 0xff);
  const code = (binary % 10 ** digits).toString().padStart(digits, "0");
  const secondsRemaining = period - (nowSec % period);
  return { code, secondsRemaining, period };
}
