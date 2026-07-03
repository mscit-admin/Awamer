/**
 * TOTP input parsing/validation (pure — no crypto, no DB).
 *
 * Accepts either a raw base32 secret or a full `otpauth://totp/...` URI
 * (what an authenticator QR encodes) and normalises both into a canonical
 * { secret, algorithm, digits, period } shape. The rolling code itself is
 * computed on the CLIENT (KeePass-style) — the server only stores the seed.
 */

import { PhaseTwoErrors, isTotpAlgorithm, type TotpAlgorithm } from "./session.js";

export interface ParsedTotp {
  secret: string;          // normalised base32 (upper, no spaces/padding)
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

const BASE32 = /^[A-Z2-7]+$/;

/** Normalise a base32 secret; throws InvalidTotpSecret if it isn't valid base32. */
export function normaliseBase32Secret(raw: string): string {
  const s = raw.replace(/\s+/g, "").replace(/=+$/,"").toUpperCase();
  if (!s || !BASE32.test(s)) throw PhaseTwoErrors.InvalidTotpSecret();
  return s;
}

function clampDigits(n: number | undefined, fallback: number): number {
  const v = Math.trunc(n ?? fallback);
  return v >= 6 && v <= 8 ? v : fallback;
}
function clampPeriod(n: number | undefined, fallback: number): number {
  const v = Math.trunc(n ?? fallback);
  return v >= 15 && v <= 60 ? v : fallback;
}

/**
 * Parse a set-TOTP request. `input.otpauthUri` takes precedence; any explicit
 * algorithm/digits/period overrides win over what the URI encodes.
 */
export function parseTotpInput(input: {
  secret?: string;
  otpauthUri?: string;
  algorithm?: string;
  digits?: number;
  period?: number;
}): ParsedTotp {
  let secret = input.secret;
  let algorithm: TotpAlgorithm = "SHA1";
  let digits = 6;
  let period = 30;

  if (input.otpauthUri) {
    let url: URL;
    try {
      url = new URL(input.otpauthUri.trim());
    } catch {
      throw PhaseTwoErrors.InvalidTotpSecret();
    }
    if (url.protocol !== "otpauth:") throw PhaseTwoErrors.InvalidTotpSecret();
    const p = url.searchParams;
    secret = p.get("secret") ?? secret;
    const alg = (p.get("algorithm") ?? "").toUpperCase();
    if (alg && isTotpAlgorithm(alg)) algorithm = alg;
    const d = Number(p.get("digits"));
    if (Number.isFinite(d)) digits = d;
    const per = Number(p.get("period"));
    if (Number.isFinite(per)) period = per;
  }

  // Explicit fields override URI-derived values.
  if (input.algorithm && isTotpAlgorithm(input.algorithm.toUpperCase())) {
    algorithm = input.algorithm.toUpperCase() as TotpAlgorithm;
  }
  digits = clampDigits(input.digits, digits);
  period = clampPeriod(input.period, period);

  if (!secret) throw PhaseTwoErrors.InvalidTotpSecret();
  return { secret: normaliseBase32Secret(secret), algorithm, digits, period };
}
