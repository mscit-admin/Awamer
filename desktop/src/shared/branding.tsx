/**
 * App branding — name and logo.
 *
 * Change without touching components:
 *   - VITE_APP_NAME      app title (default "NetSphere")
 *   - VITE_APP_LOGO_URL  optional logo image URL; if set, used instead of the
 *                        built-in mark. Put a file in desktop/public and use
 *                        e.g. "/logo.svg".
 */
export const APP_NAME =
  (import.meta.env.VITE_APP_NAME as string | undefined)?.trim() || "NetSphere";

const APP_LOGO_URL = (import.meta.env.VITE_APP_LOGO_URL as string | undefined)?.trim() || "";

export function Logo({ className = "size-4" }: { className?: string }) {
  if (APP_LOGO_URL) {
    return <img src={APP_LOGO_URL} alt={APP_NAME} className={className} />;
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
