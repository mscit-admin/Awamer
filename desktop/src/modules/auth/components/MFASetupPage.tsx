import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, ArrowLeft, CheckCircle2, Copy, Loader2, ShieldCheck, ShieldOff, Lock } from "lucide-react";

import { authApi, type MFAEnrollResponse } from "@/modules/auth/api/authApi";
import { useAuthStore } from "@/modules/auth/store/authStore";
import { ApiError } from "@/shared/lib/api";

type Phase = "intro" | "scanning" | "verifying" | "done" | "disable_confirm" | "disabled";

export function MFASetupPage() {
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const logout = useAuthStore(s => s.logout);
  // SEC-MFA-POLICY-001: this role must have MFA. When not enrolled yet the user
  // is held on this page (ProtectedRoute) and cannot go anywhere else.
  const forced = !!user?.mfa_enrollment_required;
  const policyRequired = !!user?.mfa_policy_required;

  // Enabling or disabling MFA ends every session server-side (auth_version
  // bump), so finish by signing out; the next sign-in uses the new state.
  function finishAndSignOut() {
    setTimeout(() => {
      void logout().then(() => navigate("/login", { replace: true }));
    }, 2200);
  }

  // If MFA is already enabled, start in disable_confirm; else intro.
  const [phase, setPhase] = useState<Phase>(user?.mfa_enabled ? "disable_confirm" : "intro");
  const [enrollment, setEnrollment] = useState<MFAEnrollResponse | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [password, setPassword] = useState("");

  async function handleStart(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // SEC-MFA-002: enrollment needs a fresh step-up, not just the session.
      const { step_up_token } = await authApi.stepUp(password, "mfa_change");
      setPassword("");
      const res = await authApi.mfaEnroll(step_up_token);
      setEnrollment(res);
      setPhase("scanning");
    } catch (err) {
      setError(stepUpMessage(err, "Failed to start enrollment"));
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm(e: FormEvent) {
    e.preventDefault();
    if (!enrollment) return;
    setError(null);
    setBusy(true);
    try {
      await authApi.mfaActivate(enrollment.device_id, code);
      setPhase("done");
      finishAndSignOut();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { step_up_token } = await authApi.stepUp(disablePassword, "mfa_change", disableCode);
      setDisablePassword("");
      setDisableCode("");
      await authApi.mfaDisable(step_up_token);
      setPhase("disabled");
      finishAndSignOut();
    } catch (err) {
      setError(stepUpMessage(err, "Failed to disable"));
    } finally {
      setBusy(false);
    }
  }

  async function copySecret() {
    if (!enrollment) return;
    await navigator.clipboard.writeText(enrollment.secret);
    setSecretCopied(true);
    setTimeout(() => setSecretCopied(false), 1500);
  }

  return (
    <div className="max-w-lg mx-auto py-8 animate-slide-up">
      {!forced && (
        <button onClick={() => navigate("/settings")} className="btn-ghost -ml-3 mb-4 text-xs">
          <ArrowLeft className="size-3.5" />
          Back to settings
        </button>
      )}

      {forced && (
        <div role="status" className="mb-6 flex items-start gap-2 p-3 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm">
          <AlertCircle className="size-4 mt-0.5 flex-shrink-0" />
          <div>
            Your role (<span className="font-mono">{user?.role}</span>) requires two-factor
            authentication. Set it up to continue using Awamer.
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-md bg-accent/10 border border-accent/30 grid place-items-center">
          <ShieldCheck className="size-5 text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Two-factor authentication</h1>
          <p className="text-sm text-fg-muted mt-0.5">
            Add an extra layer of security with a TOTP authenticator.
          </p>
        </div>
      </div>

      {phase === "intro" && (
        <div className="card p-6">
          <h2 className="font-medium mb-2">Before you start</h2>
          <ul className="text-sm text-fg-muted space-y-1.5 list-disc pl-5 mb-6">
            <li>Install an authenticator app: 1Password, Authy, Google Authenticator, Bitwarden.</li>
            <li>Have your phone or password manager open and ready.</li>
            <li>You'll scan a QR code, then enter a 6-digit code to confirm.</li>
          </ul>
          <form onSubmit={handleStart} className="space-y-3">
            <div>
              <label htmlFor="su-password" className="block text-sm font-medium mb-1.5">
                Confirm with your current password
              </label>
              <div className="relative">
                <Lock className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted" />
                <input
                  id="su-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input pl-9"
                  placeholder="Password"
                  required
                  autoFocus
                />
              </div>
            </div>
            <button type="submit" disabled={busy || !password} className="btn-primary">
              {busy ? <><Loader2 className="size-4 animate-spin" /> Starting…</> : "Begin enrollment"}
            </button>
            {forced && (
              <div>
                <button type="button" onClick={() => void logout().then(() => navigate("/login", { replace: true }))} className="btn-ghost text-xs -ml-3">
                  Sign out instead
                </button>
              </div>
            )}
          </form>
          {error && (
            <div
              role="alert"
              className="mt-4 flex items-start gap-2 p-3 rounded-md bg-danger/10 border border-danger/30 text-danger text-sm"
            >
              <AlertCircle className="size-4 mt-0.5" /> <span>{error}</span>
            </div>
          )}
        </div>
      )}

      {phase === "scanning" && enrollment && (
        <div className="card p-6 space-y-6">
          <div>
            <h2 className="font-medium mb-2">Scan this QR code</h2>
            <div className="flex justify-center my-4">
              <div className="p-3 bg-white rounded-md">
                <img
                  src={`data:image/png;base64,${btoa(
                    String.fromCharCode(...new Uint8Array(base64ToBytes(enrollment.qr_code_png)))
                  )}`}
                  alt="MFA QR code"
                  className="size-48"
                />
              </div>
            </div>
            <p className="text-xs text-fg-muted text-center">
              Or enter the secret manually:
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="input font-mono flex-1 select-all">{enrollment.secret}</code>
              <button onClick={copySecret} className="btn-secondary px-3" type="button">
                {secretCopied ? <CheckCircle2 className="size-4 text-accent" /> : <Copy className="size-4" />}
              </button>
            </div>
          </div>

          <form onSubmit={handleConfirm} className="space-y-4 pt-4 border-t border-border">
            <div>
              <label htmlFor="code" className="label">Enter the 6-digit code from your app</label>
              <input
                id="code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="input text-center text-2xl font-mono tracking-[0.4em] py-3"
                placeholder="000000"
                required
                autoFocus
              />
            </div>
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 p-3 rounded-md bg-danger/10 border border-danger/30 text-danger text-sm"
              >
                <AlertCircle className="size-4 mt-0.5" /> <span>{error}</span>
              </div>
            )}
            <button type="submit" disabled={busy || code.length !== 6} className="btn-primary w-full">
              {busy ? <><Loader2 className="size-4 animate-spin" /> Confirming…</> : "Confirm and enable"}
            </button>
          </form>
        </div>
      )}

      {phase === "done" && (
        <div className="card p-6 flex items-center gap-3 animate-fade-in">
          <CheckCircle2 className="size-5 text-accent flex-shrink-0" />
          <div>
            <div className="font-medium">MFA enabled</div>
            <div className="text-sm text-fg-muted">Signing you out — sign in again with a code from your app.</div>
          </div>
        </div>
      )}

      {phase === "disable_confirm" && (
        <div className="card p-6 animate-fade-in">
          <div className="flex items-start gap-3 mb-4">
            <ShieldCheck className="size-5 text-accent flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-medium">Two-factor authentication is enabled</div>
              <div className="text-sm text-fg-muted mt-0.5">
                Your account is protected by a TOTP authenticator. Disabling this
                will weaken your account's security — only do it if you've lost
                access to your authenticator or are switching devices.
              </div>
            </div>
          </div>

          <div className="border-t border-border my-4" />

          {policyRequired ? (
            <div className="text-sm text-fg-muted">
              Your role (<span className="font-mono">{user?.role}</span>) requires two-factor
              authentication, so it can't be turned off here. If you lost your authenticator,
              ask an administrator to reset it; you'll then set up a new one at sign-in.
            </div>
          ) : (<>
          <div className="flex items-start gap-2 p-3 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs mb-4">
            <AlertCircle className="size-4 mt-0.5 flex-shrink-0" />
            <div>
              After disabling, anyone with your password can sign in. We
              recommend setting up MFA again on the new device as soon as
              possible.
            </div>
          </div>

          <form onSubmit={handleDisable} className="space-y-3">
            <div>
              <label htmlFor="dis-password" className="block text-sm font-medium mb-1.5">
                Confirm with your current password
              </label>
              <div className="relative">
                <Lock className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted" />
                <input
                  id="dis-password"
                  type="password"
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                  className="input pl-9"
                  placeholder="Password"
                  required
                  autoFocus
                />
              </div>
            </div>
            <div>
              <label htmlFor="dis-code" className="block text-sm font-medium mb-1.5">
                Current 6-digit code from your app
              </label>
              <input
                id="dis-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, ""))}
                className="input font-mono tracking-[0.3em]"
                placeholder="000000"
                required
              />
            </div>
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 p-3 rounded-md bg-danger/10 border border-danger/30 text-danger text-sm"
              >
                <AlertCircle className="size-4 mt-0.5" /> <span>{error}</span>
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={busy || !disablePassword || disableCode.length !== 6}
                className="btn-primary bg-red-500 hover:bg-red-600 border-red-500 flex-1"
              >
                {busy ? <><Loader2 className="size-4 animate-spin" /> Disabling…</> : "Disable two-factor authentication"}
              </button>
              <button
                type="button"
                onClick={() => navigate("/settings")}
                className="btn-ghost"
              >
                Cancel
              </button>
            </div>
          </form>
          </>)}
        </div>
      )}

      {phase === "disabled" && (
        <div className="card p-6 flex items-center gap-3 animate-fade-in">
          <ShieldOff className="size-5 text-amber-400 flex-shrink-0" />
          <div>
            <div className="font-medium">MFA disabled</div>
            <div className="text-sm text-fg-muted">
              Your authenticator has been removed and you are being signed out.
              Set it up again from Settings when you're ready.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Map step-up / MFA API errors to a short, user-facing message. */
function stepUpMessage(err: unknown, fallback: string): string {
  const code = err instanceof ApiError
    ? (err.payload as { error?: { code?: string } } | undefined)?.error?.code
    : undefined;
  switch (code) {
    case "invalid_credentials": return "Wrong password — try again";
    case "mfa_required": return "Enter the current code from your authenticator";
    case "invalid_mfa_code": return "Incorrect authenticator code — try again";
    case "mfa_required_by_policy": return "Your role requires two-factor authentication";
    default: return err instanceof Error ? err.message : fallback;
  }
}

// Helper: backend returns qr_code_png as a base64 string in the JSON body.
// Some Go encoders emit raw bytes (which become a JSON-array of numbers) — handle both.
function base64ToBytes(input: string | number[]): Uint8Array {
  if (Array.isArray(input)) return new Uint8Array(input);
  const bin = atob(input);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
