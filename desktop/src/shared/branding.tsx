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

interface BrandingState {
  appName: string;
  logoUrl: string;
  loaded: boolean;
  load: () => Promise<void>;
  apply: (b: { app_name?: string | null; logo?: string | null }) => void;
}

export const useBranding = create<BrandingState>((set) => ({
  appName: ENV_NAME,
  logoUrl: ENV_LOGO,
  loaded: false,
  async load() {
    try {
      const b = await request<{ app_name: string | null; logo: string | null }>("/api/v1/branding", {
        unauthenticated: true,
      });
      const name = b.app_name?.trim() || ENV_NAME;
      set({ appName: name, logoUrl: b.logo || ENV_LOGO, loaded: true });
      document.title = name;
    } catch {
      set({ loaded: true });
    }
  },
  apply(b) {
    set((s) => {
      const name = (b.app_name ?? undefined)?.trim() || s.appName;
      document.title = name;
      return { appName: name, logoUrl: b.logo !== undefined ? (b.logo || "") : s.logoUrl };
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
