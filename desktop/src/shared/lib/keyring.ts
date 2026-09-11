/**
 * Thin wrapper around the Rust-side keyring commands.
 *
 * Auth model by runtime:
 *   - Native desktop (Tauri): secrets live in the OS keyring.
 *   - Browser: the long-lived REFRESH token is NOT stored here at all — it is
 *     held in an HttpOnly, script-inaccessible cookie set by the server. The
 *     legacy `netsphere.refresh_token` localStorage entry from older browser
 *     builds is a security liability and is purged at startup
 *     (see `cleanupLegacyBrowserAuth` / SEC-019A). No refresh token must ever
 *     be written to localStorage in the browser build.
 *
 * This wrapper is therefore used, in the browser, only for NON-refresh,
 * per-tab conveniences (e.g. the app-lock preference), where a localStorage
 * fallback is acceptable. localStorage is readable by any script on the origin,
 * so it must not hold long-lived auth material. If even localStorage is
 * unavailable (private mode, SSR, tests), we degrade to in-memory storage.
 */
import { invoke } from "@tauri-apps/api/core";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const memStore = new Map<string, string>();

function webStore(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      // Probe — Safari private mode throws on setItem.
      const probe = "__keyring_probe__";
      window.localStorage.setItem(probe, "1");
      window.localStorage.removeItem(probe);
      return window.localStorage;
    }
  } catch {
    /* fall through to in-memory */
  }
  return null;
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (!isTauri) {
    const ls = webStore();
    if (ls) ls.setItem(key, value);
    else memStore.set(key, value);
    return;
  }
  await invoke("keyring_set", { key, value });
}

export async function secureGet(key: string): Promise<string | null> {
  if (!isTauri) {
    const ls = webStore();
    return ls ? ls.getItem(key) : (memStore.get(key) ?? null);
  }
  try {
    return await invoke<string>("keyring_get", { key });
  } catch (err) {
    // "not found" surfaces as a string error from the command
    if (typeof err === "string" && err.toLowerCase().includes("not found")) return null;
    return null;
  }
}

export async function secureDelete(key: string): Promise<void> {
  if (!isTauri) {
    const ls = webStore();
    if (ls) ls.removeItem(key);
    else memStore.delete(key);
    return;
  }
  await invoke("keyring_delete", { key });
}

/**
 * SEC-019A — legacy browser refresh-token keys that older builds wrote to
 * localStorage before the HttpOnly-cookie design. They are long-lived auth
 * material and must not linger in script-readable storage.
 */
export const LEGACY_REFRESH_KEYS = ["netsphere.refresh_token"] as const;

/**
 * Remove legacy browser-stored refresh tokens at startup. No-op under Tauri
 * (its refresh token lives in the OS keyring, not localStorage) and safe when
 * storage is unavailable. `storage`/`tauri` are injectable for tests. Does NOT
 * touch unrelated preferences (e.g. `netsphere.lock`).
 */
export function cleanupLegacyBrowserAuth(opts: { storage?: Storage | null; tauri?: boolean } = {}): void {
  const underTauri = opts.tauri ?? isTauri;
  if (underTauri) return;
  let store: Storage | null | undefined = opts.storage;
  if (store === undefined) {
    try { store = typeof window !== "undefined" ? window.localStorage : null; } catch { store = null; }
  }
  if (!store) return;
  for (const key of LEGACY_REFRESH_KEYS) {
    try { store.removeItem(key); } catch { /* ignore */ }
  }
}
