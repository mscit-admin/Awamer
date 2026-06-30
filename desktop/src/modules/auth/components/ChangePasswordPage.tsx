import { useState, type FormEvent } from "react";
import { ArrowLeft, KeyRound, Info, CheckCircle2, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { authApi } from "@/modules/auth/api/authApi";
import { useAuthStore } from "@/modules/auth/store/authStore";
import { ApiError } from "@/shared/lib/api";

/**
 * Self-service password change (Phase 2.x).
 *
 * Posts to /api/v1/auth/change-password. On success the backend revokes all
 * refresh sessions, so we sign the user out and send them to login to
 * re-authenticate with the new password.
 */
const POLICY = "At least 12 characters with upper- and lower-case letters, a digit, and a symbol.";

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.message) {
      case "invalid_credentials": return "Your current password is incorrect.";
      case "weak_password": return POLICY;
      case "password_unchanged": return "The new password must be different from your current one.";
      default: return err.message || "Could not change password.";
    }
  }
  return err instanceof Error ? err.message : "Could not change password.";
}

export function ChangePasswordPage() {
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError("The new password and confirmation don't match.");
      return;
    }
    if (next.length < 12) {
      setError(POLICY);
      return;
    }
    setBusy(true);
    try {
      await authApi.changePassword(current, next);
      setDone(true);
      // Other sessions were revoked server-side; sign out and re-login.
      setTimeout(async () => {
        await logout();
        navigate("/login", { replace: true });
      }, 1800);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="max-w-md mx-auto py-8 animate-slide-up">
        <div className="card p-6 flex items-start gap-3">
          <CheckCircle2 className="size-5 text-emerald-400 flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <div className="font-medium mb-1">Password changed</div>
            <p className="text-fg-muted leading-relaxed">
              Your password was updated and other sessions were signed out.
              Redirecting you to sign in again…
            </p>
          </div>
        </div>
      </div>
    );
  }

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
          <p className="text-sm text-fg-muted mt-0.5">Account password rotation.</p>
        </div>
      </div>

      <form onSubmit={onSubmit} className="card p-5 space-y-4">
        <div>
          <label className="block text-xs text-fg-muted mb-1">Current password</label>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            className="input w-full"
            required
          />
        </div>
        <div>
          <label className="block text-xs text-fg-muted mb-1">New password</label>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            className="input w-full"
            required
          />
        </div>
        <div>
          <label className="block text-xs text-fg-muted mb-1">Confirm new password</label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            className="input w-full"
            required
          />
        </div>

        <div className="flex items-start gap-2 text-xs text-fg-muted">
          <Info className="size-3.5 mt-0.5 flex-shrink-0" />
          <span>{POLICY}</span>
        </div>

        {error && (
          <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded">
            {error}
          </div>
        )}

        <button type="submit" disabled={busy} className="btn-primary w-full">
          {busy ? <><Loader2 className="size-4 animate-spin" /> Changing…</> : "Change password"}
        </button>
      </form>
    </div>
  );
}
