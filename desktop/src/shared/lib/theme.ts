/**
 * Light/dark theme handling. The palette is driven by CSS variables that
 * switch on a `light`/`dark` class on <html> (see styles/global.css).
 */
export type Theme = "dark" | "light";

const KEY = "netsphere.theme";

export function getStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function currentTheme(): Theme {
  return typeof document !== "undefined" && document.documentElement.classList.contains("light")
    ? "light"
    : "dark";
}

export function applyTheme(t: Theme): void {
  const el = document.documentElement;
  el.classList.remove("light", "dark");
  el.classList.add(t);
}

export function setTheme(t: Theme): void {
  try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
  applyTheme(t);
}

/** Apply the stored theme (or system default) — call once at startup. */
export function initTheme(): Theme {
  const t = getStoredTheme() ?? systemTheme();
  applyTheme(t);
  return t;
}
