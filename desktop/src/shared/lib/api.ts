/**
 * Low-level HTTP client for the Awamer API.
 *
 * Wraps fetch with:
 *   - Base URL injection
 *   - JSON serialization
 *   - Bearer-token attachment
 *   - Centralised error mapping
 *   - Automatic refresh on 401
 *
 * All higher-level API modules should go through this rather than calling
 * fetch directly so behaviours like auth and logging stay consistent.
 */

// BUG-001: the backend dev port is 8081 (AUTH_HTTP_PORT default). The previous
// 8080 default pointed at nothing, so a dev build without VITE_API_BASE_URL set
// silently failed every API call. Aligned with the rest of the app + backend.
import { isTauri } from "./keyring";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8081";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public payload?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  /** When true the request goes out without an auth header even if one is available. */
  unauthenticated?: boolean;
  /** Optional bearer token override (e.g. MFA short-lived token). */
  bearerOverride?: string;
}

/** Provider that returns the current access token, or null if unauthenticated. */
export type TokenProvider = () => string | null;

/** Hook fired when a request comes back 401 so the caller can attempt refresh. */
export type UnauthorizedHook = () => Promise<string | null>;

let tokenProvider: TokenProvider = () => null;
let onUnauthorized: UnauthorizedHook | null = null;

export function configureApiClient(opts: { token: TokenProvider; onUnauthorized?: UnauthorizedHook }) {
  tokenProvider = opts.token;
  onUnauthorized = opts.onUnauthorized ?? null;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE_URL}${path}`;
  // Build the request fresh each call so the 401-refresh retry (below) picks up
  // the newly-issued token via tokenProvider().
  const doFetch = () => {
    const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
    if (!opts.unauthenticated) {
      const token = opts.bearerOverride ?? tokenProvider();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    // SEC-019: the browser build opts into HttpOnly-cookie refresh-token
    // transport; the Tauri app keeps the OS keyring (body token, no header).
    if (!isTauri) headers["X-Awamer-Client"] = "web";
    // Send/receive the same-origin refresh cookie.
    const init: RequestInit = { method: opts.method ?? "GET", headers, credentials: isTauri ? "same-origin" : "include" };
    // Only declare a JSON body (+ its Content-Type) when there actually is one:
    // a bodyless POST/DELETE with a JSON content-type makes Fastify reject it.
    if (opts.body !== undefined) {
      if (!("Content-Type" in headers)) headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return fetch(url, init);
  };

  const response = await withRefresh(doFetch, opts.unauthenticated || Boolean(opts.bearerOverride));
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Attach the current bearer token to a set of headers. */
function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  const headers = { ...base };
  const token = tokenProvider();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Run a fetch, retrying once after a 401 if a refresh hook is set. `doFetch`
 * must read the current token each call so the retry uses the refreshed one.
 */
async function withRefresh(doFetch: () => Promise<Response>, skip = false): Promise<Response> {
  const response = await doFetch();
  if (response.status === 401 && !skip && onUnauthorized) {
    const newToken = await onUnauthorized();
    if (newToken) return doFetch();
  }
  return response;
}

/** Single error-body parser for all entry points. Handles our
 *  `{ error: { code, message } }` envelope and Fastify's `{ error, message }`. */
async function parseError(response: Response): Promise<ApiError> {
  let payload: unknown;
  let message = `HTTP ${response.status}`;
  try {
    payload = await response.json();
    const p = payload as { error?: unknown; message?: unknown };
    const err = p?.error;
    if (err && typeof err === "object") {
      const eo = err as { message?: unknown; code?: unknown };
      message = String(eo.message ?? eo.code ?? p?.message ?? message);
    } else if (typeof err === "string") {
      message = String(p?.message ?? err);
    } else if (typeof p?.message === "string") {
      message = p.message;
    }
  } catch { /* non-JSON body — keep generic message */ }
  return new ApiError(response.status, message, payload);
}

/** Upload multipart/form-data (e.g. a file). The browser sets the boundary. */
export async function uploadMultipart<T>(path: string, form: FormData): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE_URL}${path}`;
  const response = await withRefresh(() =>
    fetch(url, { method: "POST", headers: authHeaders({ Accept: "application/json" }), body: form }));
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** GET a binary response as a Blob (e.g. an attachment download). */
export async function fetchBlob(path: string): Promise<Blob> {
  const url = path.startsWith("http") ? path : `${API_BASE_URL}${path}`;
  const response = await withRefresh(() => fetch(url, { method: "GET", headers: authHeaders() }));
  if (!response.ok) throw await parseError(response);
  return await response.blob();
}
