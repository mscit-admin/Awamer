/**
 * Low-level HTTP client for the NetSphere API.
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

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8080";

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
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...opts.headers,
  };

  if (!opts.unauthenticated) {
    const token = opts.bearerOverride ?? tokenProvider();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers,
  };
  // Only declare a JSON body (and its Content-Type) when there actually is one:
  // a POST/DELETE with no body + "Content-Type: application/json" makes Fastify
  // reject with "Body cannot be empty when content-type is set to ...".
  if (opts.body !== undefined) {
    if (!("Content-Type" in headers)) headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  let response = await fetch(url, init);

  // 401 + we have a refresh hook + this wasn't an explicit override → try to refresh once.
  if (response.status === 401 && !opts.unauthenticated && !opts.bearerOverride && onUnauthorized) {
    const newToken = await onUnauthorized();
    if (newToken) {
      headers.Authorization = `Bearer ${newToken}`;
      response = await fetch(url, { ...init, headers });
    }
  }

  if (!response.ok) {
    let payload: unknown;
    let message = `HTTP ${response.status}`;
    try {
      payload = await response.json();
      const p = payload as { error?: unknown; message?: unknown };
      const err = p?.error;
      if (err && typeof err === "object") {
        // Our envelope: { error: { code, message } }
        const eo = err as { message?: unknown; code?: unknown };
        message = String(eo.message ?? eo.code ?? p?.message ?? message);
      } else if (typeof err === "string") {
        // Fastify default: { error: "Not Found", message: "..." }
        message = String(p?.message ?? err);
      } else if (typeof p?.message === "string") {
        message = p.message;
      }
    } catch {
      // Non-JSON error body — keep generic message.
    }
    throw new ApiError(response.status, message, payload);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
