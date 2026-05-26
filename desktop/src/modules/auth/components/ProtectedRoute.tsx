import { type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useAuthStore } from "@/modules/auth/store/authStore";

interface Props {
  children: ReactNode;
}

/**
 * Gate that redirects to /login when the user isn't authenticated.
 * Shows a loading state while the auth store is restoring its session
 * to avoid flashing the login screen on every cold start.
 */
export function ProtectedRoute({ children }: Props) {
  const status = useAuthStore((s) => s.status);
  const location = useLocation();

  if (status === "idle" || status === "authenticating") {
    return (
      <div className="h-full flex items-center justify-center text-fg-muted text-sm">
        <div className="flex items-center gap-3">
          <div className="size-2 rounded-full bg-accent animate-pulse" />
          <span className="font-mono">restoring session…</span>
        </div>
      </div>
    );
  }

  if (status !== "authenticated") {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
