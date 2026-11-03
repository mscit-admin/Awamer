import { type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useAuthStore } from "@/modules/auth/store/authStore";

const MFA_SETUP_PATH = "/settings/security/mfa";
const PASSWORD_CHANGE_PATH = "/settings/security/password";

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
  const user = useAuthStore((s) => s.user);
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

  // SEC-PW-TEMP-001: an admin-set password must be replaced first, then
  // SEC-MFA-POLICY-001: a role that requires MFA must enroll. The server refuses
  // everything else until then — keep the user on the page that fixes it.
  if (user?.password_change_required) {
    if (location.pathname !== PASSWORD_CHANGE_PATH) return <Navigate to={PASSWORD_CHANGE_PATH} replace />;
  } else if (user?.mfa_enrollment_required && location.pathname !== MFA_SETUP_PATH) {
    return <Navigate to={MFA_SETUP_PATH} replace />;
  }

  return <>{children}</>;
}
