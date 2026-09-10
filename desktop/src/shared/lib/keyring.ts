/**
 * Thin wrapper around the Rust-side keyring commands.
 *
 * In the native desktop app, secrets live in the OS keyring via Tauri.
 * When running as a plain web app (no Tauri — e.g. served from nginx in a
 * browser), we fall back to localStorage so the session survives a page
 * reload. localStorage is less secure than an OS keychain (it's readable by
 * any script on the origin), but it's the standard trade-off for a browser
 * client and keeps the web build usable. If even localStorage is unavailable
 * (private mode, SSR, tests), we degrade to in-memory storage.
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
