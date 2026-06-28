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
  loaded: boolean;
  load: () => Promise<void>;
  apply: (b: { app_name?: string | null; logo?: string | null; favicon?: string | null }) => void;
}

export const useBranding = create<BrandingState>((set) => ({
  appName: ENV_NAME,
  logoUrl: ENV_LOGO,
  favicon: "",
  loaded: false,
  async load() {
    try {
      const b = await request<{ app_name: string | null; logo: string | null; favicon: string | null }>(
        "/api/v1/branding",
        { unauthenticated: true },
      );
      const name = b.app_name?.trim() || ENV_NAME;
      set({ appName: name, logoUrl: b.logo || ENV_LOGO, favicon: b.favicon || "", loaded: true });
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
      return {
        appName: name,
        logoUrl: b.logo !== undefined ? (b.logo || "") : s.logoUrl,
        favicon: b.favicon !== undefined ? (b.favicon || "") : s.favicon,
      };
    });
  },
}));

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
