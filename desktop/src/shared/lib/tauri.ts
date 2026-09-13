/**
 * Runtime detection for the Tauri (native desktop) environment.
 *
 * Features that rely on the Rust core — live SSH terminals and SFTP — only
 * work in the desktop app. When the same React bundle is served as a plain
 * web app (browser), `window.__TAURI_INTERNALS__` is undefined and any
 * `invoke()` call throws a confusing low-level TypeError. Use `isTauri` to
 * guard those entry points and show `DESKTOP_ONLY_MESSAGE` instead.
 */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const DESKTOP_ONLY_MESSAGE =
  "Live SSH/SFTP sessions require the Awamer desktop app. " +
  "The browser version supports account, host, credential, folder, and " +
  "tag management only.";
