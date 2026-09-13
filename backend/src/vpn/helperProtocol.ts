/**
 * SEC-INFRA-001 — authenticated IPC protocol between the (unprivileged) Awamer
 * backend and the privileged `awamer-vpn-helper`.
 *
 * Trust model
 * -----------
 * The helper listens ONLY on a Unix domain socket with restrictive permissions
 * (network isolation), but per the brief we do not trust isolation alone: every
 * request is authenticated with an HMAC-SHA256 over a canonical serialization
 * using a high-entropy shared secret (`VPN_HELPER_SECRET`), and carries a
 * timestamp + unique request id so the helper can reject stale/replayed
 * requests. Responses are signed the same way so the backend can trust replies.
 *
 * The wire format is newline-delimited JSON. This module is pure (no I/O) so it
 * is shared verbatim by both sides and unit-tested in isolation.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const PROTOCOL_VERSION = 1;

/** Structured, allow-listed operations. There is NO generic exec/command op. */
export const HELPER_OPS = [
  "health",
  "client_connect",
  "client_stop",
  "client_status",
  "server_start",
  "server_stop",
  "server_status",
  // Multi-VPN-Server: per-server host firewall rules, constructed by the helper
  // from structured {serverId, port, proto} — NOT arbitrary firewall text.
  "firewall_allow",
  "firewall_remove",
] as const;
export type HelperOp = (typeof HELPER_OPS)[number];
export const isHelperOp = (s: unknown): s is HelperOp =>
  typeof s === "string" && (HELPER_OPS as readonly string[]).includes(s);

/** Session/server identifiers are used as on-disk directory names by the helper,
 *  so they are constrained to a safe charset (a UUID matches). This is the first
 *  line of defence against path traversal in the runtime directory. */
export const REF_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isValidRef = (s: unknown): s is string => typeof s === "string" && REF_RE.test(s);

export interface HelperRequest {
  v: number;
  op: HelperOp;
  /** Unique request id (also the replay nonce). */
  id: string;
  /** Client clock, epoch ms. */
  ts: number;
  payload: Record<string, unknown>;
  /** HMAC — present once signed. */
  mac?: string;
}

export interface HelperResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  /** Echo of the request id + timestamp so the reply is bound to the request. */
  id: string;
  ts: number;
  mac?: string;
}

/** Deterministic JSON: object keys sorted recursively so both sides hash the
 *  exact same bytes regardless of key insertion order. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

function requestMacInput(r: Pick<HelperRequest, "v" | "op" | "id" | "ts" | "payload">): string {
  return canonicalize(["req", r.v, r.op, r.id, r.ts, r.payload]);
}
function responseMacInput(r: Pick<HelperResponse, "ok" | "result" | "error" | "id" | "ts">): string {
  return canonicalize(["res", r.ok, r.result ?? null, r.error ?? null, r.id, r.ts]);
}

function hmac(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

/** Constant-time hex comparison that never throws on length mismatch. */
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export function signRequest(secret: string, r: Omit<HelperRequest, "mac">): HelperRequest {
  return { ...r, mac: hmac(secret, requestMacInput(r)) };
}
export function signResponse(secret: string, r: Omit<HelperResponse, "mac">): HelperResponse {
  return { ...r, mac: hmac(secret, responseMacInput(r)) };
}

export class HelperAuthError extends Error {
  constructor(public readonly reason: string) { super(`helper auth: ${reason}`); }
}

/**
 * Verify a request's authenticity, freshness (timestamp within `skewMs`) and
 * shape. Replay (nonce) rejection is the caller's job via a NonceCache — this is
 * pure. Throws HelperAuthError with a machine-readable reason on any failure.
 */
export function verifyRequest(secret: string, r: unknown, opts: { skewMs?: number; now?: number } = {}): HelperRequest {
  const skewMs = opts.skewMs ?? 30_000;
  const now = opts.now ?? Date.now();
  if (typeof r !== "object" || r === null) throw new HelperAuthError("malformed");
  const req = r as Record<string, unknown>;
  if (req.v !== PROTOCOL_VERSION) throw new HelperAuthError("bad_version");
  if (!isHelperOp(req.op)) throw new HelperAuthError("unknown_op");
  if (typeof req.id !== "string" || req.id.length === 0 || req.id.length > 128) throw new HelperAuthError("bad_id");
  if (typeof req.ts !== "number" || !Number.isFinite(req.ts)) throw new HelperAuthError("bad_ts");
  if (typeof req.payload !== "object" || req.payload === null || Array.isArray(req.payload)) throw new HelperAuthError("bad_payload");
  if (typeof req.mac !== "string") throw new HelperAuthError("missing_mac");
  if (Math.abs(now - req.ts) > skewMs) throw new HelperAuthError("stale");
  const expected = hmac(secret, requestMacInput(req as unknown as HelperRequest));
  if (!safeEqualHex(expected, req.mac)) throw new HelperAuthError("bad_mac");
  return req as unknown as HelperRequest;
}

/** Verify a response's authenticity + binding to the request id. */
export function verifyResponse(secret: string, r: unknown, expectId: string): HelperResponse {
  if (typeof r !== "object" || r === null) throw new HelperAuthError("malformed");
  const res = r as Record<string, unknown>;
  if (typeof res.mac !== "string") throw new HelperAuthError("missing_mac");
  if (res.id !== expectId) throw new HelperAuthError("id_mismatch");
  const expected = hmac(secret, responseMacInput(res as unknown as HelperResponse));
  if (!safeEqualHex(expected, res.mac)) throw new HelperAuthError("bad_mac");
  return res as unknown as HelperResponse;
}

/** Replay protection: remember request ids until they expire (2×skew window). */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs = 60_000) {}
  /** Returns true if this id is fresh (and records it); false if already seen. */
  check(id: string, now = Date.now()): boolean {
    this.gc(now);
    if (this.seen.has(id)) return false;
    this.seen.set(id, now + this.ttlMs);
    return true;
  }
  private gc(now: number): void {
    for (const [id, exp] of this.seen) if (exp < now) this.seen.delete(id);
  }
}
