/**
 * SEC-PW-POLICY-001 — password policy (ASVS 5.0 V6.2).
 *
 *   - length 12..128 characters (V6.2.1, V6.2.9). Counted in Unicode code points;
 *     any character is allowed, nothing is truncated (V6.2.8).
 *   - NO composition rules: no required upper/lower/digit/symbol (V6.2.5).
 *   - not one of the 10,000 most common leaked passwords of that length,
 *     compared case-insensitively (V6.2.4).
 *   - does not contain account- or product-specific words: the username, the
 *     email's local part and domain name, name parts, or the product name
 *     (V6.2.11).
 *
 * Applied on every path that sets a password: admin create/reset, self change,
 * and the email reset link. The server is the source of truth; the client only
 * mirrors the length rule.
 */
import { COMMON_PASSWORDS } from "./data/commonPasswords.js";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Product / system identifiers that must never appear in a password. */
const PRODUCT_WORDS = ["awamer", "netsphere"];

const COMMON = new Set(COMMON_PASSWORDS);

export interface PasswordContext {
  username?: string | null;
  email?: string | null;
  fullName?: string | null;
}

export type PasswordProblem = "too_short" | "too_long" | "common" | "contextual";

/** Words derived from the account that the password must not contain. */
function contextWords(ctx: PasswordContext): string[] {
  const words: string[] = [...PRODUCT_WORDS];
  const add = (w: string | undefined | null, min: number) => {
    const v = (w ?? "").trim().toLowerCase();
    if (v.length >= min) words.push(v);
  };
  add(ctx.username, 3);
  if (ctx.email) {
    const [local, domain] = ctx.email.toLowerCase().split("@");
    add(local, 3);
    // the registrable-looking label, e.g. "example" in mail.example.com
    const labels = (domain ?? "").split(".").filter(Boolean);
    if (labels.length >= 2) add(labels[labels.length - 2], 4);
  }
  for (const part of (ctx.fullName ?? "").split(/\s+/)) add(part, 4);
  return words;
}

/** The first rule the password breaks, or null when it is acceptable. */
export function checkPassword(password: string, ctx: PasswordContext = {}): PasswordProblem | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return "too_short";
  if (length > PASSWORD_MAX_LENGTH) return "too_long";
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return "common";
  if (contextWords(ctx).some((w) => lower.includes(w))) return "contextual";
  return null;
}

export function validatePassword(password: string, ctx: PasswordContext = {}): boolean {
  return checkPassword(password, ctx) === null;
}

export const PASSWORD_PROBLEM_MESSAGE: Record<PasswordProblem, string> = {
  too_short: `password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  too_long: `password must be at most ${PASSWORD_MAX_LENGTH} characters`,
  common: "this password is too common — choose a less predictable one",
  contextual: "password must not contain your username, email, name or the product name",
};
