/**
 * Thin wrapper around the Rust-side keyring commands.
 *
 * In dev (browser preview without Tauri), falls back to in-memory storage
 * so the React app remains testable in isolation.
 */
import { invoke } from "@tauri-apps/api/core";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const memStore = new Map<string, string>();

export async function secureSet(key: string, value: string): Promise<void> {
  if (!isTauri) {
    memStore.set(key, value);
    return;
  }
  await invoke("keyring_set", { key, value });
}

export async function secureGet(key: string): Promise<string | null> {
  if (!isTauri) {
    return memStore.get(key) ?? null;
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
    memStore.delete(key);
    return;
  }
  await invoke("keyring_delete", { key });
}
