/**
 * App branding — name and logo, configurable at runtime from the Branding
 * admin screen (persisted on the server) with env-var fallbacks.
 *
 * Fallbacks (used until/if the server value is set):
 *   - VITE_APP_NAME      default app title
 *   - VITE_APP_LOGO_URL  default logo image URL
 */
import { create } from "zustand";
import { request } from "@/shared/lib/api";

const ENV_NAME = (import.meta.env.VITE_APP_NAME as string | undefined)?.trim() || "NetSphere";
const ENV_LOGO = (import.meta.env.VITE_APP_LOGO_URL as string | undefined)?.trim() || "";

// Cache the last-known branding in localStorage and hydrate it synchronously on
// startup, so returning users see the branded name/logo/watermark on the very
// first paint instead of a flash of the defaults ("NetSphere" / username).
const CACHE_KEY = "netsphere.branding";
interface BrandingCache { appName: string; logoUrl: string; favicon: string; loginImage: string; terminalWatermark: string }
function readCache(): BrandingCache | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(CACHE_KEY) : null;
    return raw ? (JSON.parse(raw) as BrandingCache) : null;
  } catch { return null; }
}
function writeCache(s: BrandingCache): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(s)); } catch { /* ignore quota/private mode */ }
}
const CACHED = readCache();

function applyFavicon(href: string): void {
  if (!href || typeof document === "undefined") return;
  let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = href;
}

interface BrandingState {
  appName: string;
  logoUrl: string;
  favicon: string;
  loginImage: string;
  terminalWatermark: string;
  loaded: boolean;
  load: () => Promise<void>;
  apply: (b: { app_name?: string | null; logo?: string | null; favicon?: string | null; login_image?: string | null; terminal_watermark?: string | null }) => void;
}

export const useBranding = create<BrandingState>((set) => ({
  // Hydrate from the cache (last-known branding) so the first paint is branded.
  appName: CACHED?.appName || ENV_NAME,
  logoUrl: CACHED?.logoUrl ?? ENV_LOGO,
  favicon: CACHED?.favicon ?? "",
  loginImage: CACHED?.loginImage ?? "",
  terminalWatermark: CACHED?.terminalWatermark ?? "",
  // With a cache we already have displayable branding — treat it as "known" so
  // fallbacks (e.g. the username watermark) don't flash before the fetch.
  loaded: CACHED != null,
  async load() {
    try {
      const b = await request<{ app_name: string | null; logo: string | null; favicon: string | null; login_image: string | null; terminal_watermark: string | null }>(
        "/api/v1/branding",
        { unauthenticated: true },
      );
      const name = b.app_name?.trim() || ENV_NAME;
      const next = { appName: name, logoUrl: b.logo || ENV_LOGO, favicon: b.favicon || "", loginImage: b.login_image || "", terminalWatermark: b.terminal_watermark || "" };
      set({ ...next, loaded: true });
      writeCache(next);
      document.title = name;
      if (b.favicon) applyFavicon(b.favicon);
    } catch {
      set({ loaded: true });
    }
  },
  apply(b) {
    set((s) => {
      const name = (b.app_name ?? undefined)?.trim() || s.appName;
      document.title = name;
      if (b.favicon) applyFavicon(b.favicon);
      const next = {
        appName: name,
        logoUrl: b.logo !== undefined ? (b.logo || "") : s.logoUrl,
        favicon: b.favicon !== undefined ? (b.favicon || "") : s.favicon,
        loginImage: b.login_image !== undefined ? (b.login_image || "") : s.loginImage,
        terminalWatermark: b.terminal_watermark !== undefined ? (b.terminal_watermark || "") : s.terminalWatermark,
      };
      writeCache(next);
      return next;
    });
  },
}));

// Apply cached title/favicon immediately at startup so returning users don't
// see the default title flash before the branding fetch resolves.
if (typeof document !== "undefined" && CACHED) {
  if (CACHED.appName) document.title = CACHED.appName;
  if (CACHED.favicon) applyFavicon(CACHED.favicon);
}

/** Reactive terminal watermark image (data URI / URL), empty if unset. */
export function useTerminalWatermark(): string {
  return useBranding((s) => s.terminalWatermark);
}

/** Reactive login background image (data URI / URL), empty if unset. */
export function useLoginImage(): string {
  return useBranding((s) => s.loginImage);
}

/** Reactive app name for components. */
export function useAppName(): string {
  return useBranding((s) => s.appName);
}

export function Logo({ className = "size-4" }: { className?: string }) {
  const logoUrl = useBranding((s) => s.logoUrl);
  if (logoUrl) {
    return <img src={logoUrl} alt="" className={className + " object-contain"} />;
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12 2L3 7l9 5 9-5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5"
        stroke="rgb(var(--c-accent))"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
