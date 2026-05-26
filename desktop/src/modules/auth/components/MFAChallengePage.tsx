import { useEffect, useRef, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2, ShieldCheck, AlertCircle } from "lucide-react";

import { useAuthStore } from "@/modules/auth/store/authStore";

export function MFAChallengePage() {
  const navigate = useNavigate();
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const verifyMfa = useAuthStore((s) => s.verifyMfa);
  const clearError = useAuthStore((s) => s.clearError);
  const logout = useAuthStore((s) => s.logout);

  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  if (status === "authenticated") return <Navigate to="/" replace />;
  if (status === "unauthenticated") return <Navigate to="/login" replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    clearError();
    if (code.length !== 6) return;
    setSubmitting(true);
    try {
      await verifyMfa(code);
      navigate("/", { replace: true });
    } catch {
      setCode("");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="h-full grid place-items-center px-6 animate-fade-in">
      <div className="w-full max-w-sm">
        <button
          type="button"
          onClick={handleCancel}
          className="btn-ghost -ml-3 mb-6 text-xs"
        >
          <ArrowLeft className="size-3.5" />
          Cancel
        </button>

        <div className="flex items-center gap-3 mb-6">
          <div className="size-10 rounded-md bg-accent/10 border border-accent/30 grid place-items-center">
            <ShieldCheck className="size-5 text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Verify your identity</h1>
            <p className="text-xs text-fg-muted mt-0.5">
              Enter the 6-digit code from your authenticator app.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="mfa-code" className="label">
              Authentication code
            </label>
            <input
              ref={inputRef}
              id="mfa-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="input text-center text-2xl font-mono tracking-[0.4em] py-3"
              placeholder="000000"
              required
            />
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 p-3 rounded-md bg-danger/10 border border-danger/30 text-danger text-sm"
            >
              <AlertCircle className="size-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || code.length !== 6}
            className="btn-primary w-full"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Verifying…
              </>
            ) : (
              "Verify"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
