/**
 * Client-side password generator for the credential vault.
 *
 * Uses the Web Crypto CSPRNG (crypto.getRandomValues) with rejection sampling
 * so the output is unbiased across the chosen alphabet. Nothing is sent to the
 * server — the caller pastes the result into a secret field like any typed value.
 */

export interface PasswordOptions {
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
  /** Exclude look-alike characters (O/0, l/1/I, etc.). */
  avoidAmbiguous: boolean;
}

export const DEFAULT_PASSWORD_OPTIONS: PasswordOptions = {
  length: 20,
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: true,
};

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?";
const AMBIGUOUS = new Set("O0oIl1|`'\"{}[]()/\\".split(""));

function buildAlphabet(o: PasswordOptions): string {
  let chars = "";
  if (o.lowercase) chars += LOWER;
  if (o.uppercase) chars += UPPER;
  if (o.digits) chars += DIGITS;
  if (o.symbols) chars += SYMBOLS;
  if (o.avoidAmbiguous) chars = [...chars].filter((c) => !AMBIGUOUS.has(c)).join("");
  return chars;
}

/** Draw an unbiased index in [0, max) from the CSPRNG using rejection sampling. */
function randomIndex(max: number): number {
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  let x = 0;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % max;
}

export function generatePassword(opts: Partial<PasswordOptions> = {}): string {
  const o = { ...DEFAULT_PASSWORD_OPTIONS, ...opts };
  const alphabet = buildAlphabet(o);
  if (!alphabet.length) return "";
  const length = Math.max(4, Math.min(128, Math.floor(o.length)));
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomIndex(alphabet.length)];
  return out;
}

/** Rough Shannon-entropy estimate (bits) for a generated password. */
export function estimateEntropyBits(opts: Partial<PasswordOptions> = {}): number {
  const o = { ...DEFAULT_PASSWORD_OPTIONS, ...opts };
  const size = buildAlphabet(o).length;
  if (size <= 1) return 0;
  const length = Math.max(4, Math.min(128, Math.floor(o.length)));
  return Math.round(length * Math.log2(size));
}
