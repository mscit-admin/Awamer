import { useState, type FormEvent } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { Loader2, Lock, AlertCircle, CheckCircle2, ArrowLeft } from "lucide-react";
import { passwordResetApi } from "../api/passwordResetApi";
import { ApiError } from "@/shared/lib/api";

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 12) { setError("Password must be at least 12 characters with upper, lower, digit and symbol."); return; }
    if (password !== confirm) { setError("Passwords do not match."); return; }
    setBusy(true);
    try {
      await passwordResetApi.reset(token, password);
      setDone(true);
      setTimeout(() => navigate("/login"), 2500);
    } catch (err) {
      const code = err instanceof ApiError ? err.message : "";
      setError(code === "weak_password"
        ? "Password must be at least 12 characters with upper, lower, digit and symbol."
        : code === "invalid_token"
          ? "This reset link is invalid or has expired. Request a new one."
          : err instanceof Error ? err.message : "Reset failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full grid place-items-center px-6 animate-fade-in">
      <div className="w-full max-w-sm card p-8">
        <h1 className="text-xl font-semibold mb-1">Set a new password</h1>
        <p className="text-sm text-fg-muted mb-6">Choose a strong password for your account.</p>

        {!token ? (
          <div className="flex items-start gap-2 p-3 rounded-md bg-danger/10 border border-danger/30 text-danger text-sm">
            <AlertCircle className="size-4 mt-0.5 shrink-0" /> Missing reset token. Use the link from your email.
          </div>
        ) : done ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2 p-3 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm">
              <CheckCircle2 className="size-4 mt-0.5 shrink-0" /> Password updated. Redirecting to sign in…
            </div>
            <Link to="/login" className="btn-ghost text-xs inline-flex"><ArrowLeft className="size-3.5" /> Go to sign in</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <PwField id="password" label="New password" value={password} onChange={setPassword} autoFocus />
            <PwField id="confirm" label="Confirm password" value={confirm} onChange={setConfirm} />
            {error && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-danger/10 border border-danger/30 text-danger text-sm">
                <AlertCircle className="size-4 mt-0.5 shrink-0" /> <span>{error}</span>
              </div>
            )}
            <button type="submit" disabled={busy} className="btn-primary w-full">
              {busy ? <><Loader2 className="size-4 animate-spin" /> Updating…</> : "Update password"}
            </button>
            <Link to="/login" className="btn-ghost text-xs inline-flex"><ArrowLeft className="size-3.5" /> Back to sign in</Link>
          </form>
        )}
      </div>
    </div>
  );
}

function PwField({ id, label, value, onChange, autoFocus }: { id: string; label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      <div className="relative">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none"><Lock className="size-4" /></div>
        <input id={id} type="password" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" autoFocus={autoFocus} required className="input pl-10" />
      </div>
    </div>
  );
}
