import { ArrowLeft, KeyRound, Info } from "lucide-react";
import { useNavigate } from "react-router-dom";

/**
 * Phase 1: change-password is a UI placeholder.
 *
 * The backend doesn't yet expose POST /auth/change-password (Phase 2 will
 * add it alongside admin-driven password resets). For Phase 1, the seed
 * admin password is set in `.env` and rotated by re-seeding.
 *
 * Why ship the page? So the navigation graph is complete and the seam is
 * obvious — when Phase 2 lands, this file becomes a 30-line form.
 */
export function ChangePasswordPage() {
  const navigate = useNavigate();
  return (
    <div className="max-w-md mx-auto py-8 animate-slide-up">
      <button onClick={() => navigate("/settings")} className="btn-ghost -ml-3 mb-4 text-xs">
        <ArrowLeft className="size-3.5" />
        Back to settings
      </button>

      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-md bg-bg-elevated border border-border grid place-items-center">
          <KeyRound className="size-5 text-fg-muted" />
        </div>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Change password</h1>
          <p className="text-sm text-fg-muted mt-0.5">
            Account password rotation.
          </p>
        </div>
      </div>

      <div className="card p-5 flex items-start gap-3">
        <Info className="size-4 mt-0.5 text-accent flex-shrink-0" />
        <div className="text-sm">
          <div className="font-medium mb-1">Coming in Phase 2</div>
          <p className="text-fg-muted leading-relaxed">
            Self-service password change ships alongside the user-management
            module. For now, an administrator can reset passwords by re-seeding
            the database, and the seed admin password is set in <code className="font-mono text-fg">.env</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
