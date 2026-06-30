import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Loader2, Mail, ArrowLeft, CheckCircle2 } from "lucide-react";
import { passwordResetApi } from "../api/passwordResetApi";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try { await passwordResetApi.forgot(email.trim()); } catch { /* ignore — never reveal */ }
    finally { setBusy(false); setSent(true); }
  }

  return (
    <div className="h-full grid place-items-center px-6 animate-fade-in">
      <div className="w-full max-w-sm card p-8">
        <h1 className="text-xl font-semibold mb-1">Reset password</h1>
        <p className="text-sm text-fg-muted mb-6">Enter your account email and we'll send a reset link.</p>

        {sent ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2 p-3 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm">
              <CheckCircle2 className="size-4 mt-0.5 shrink-0" />
              <span>If an account exists for that email, a reset link is on its way. The link is valid for 1 hour.</span>
            </div>
            <Link to="/login" className="btn-ghost text-xs inline-flex"><ArrowLeft className="size-3.5" /> Back to sign in</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <div>
              <label htmlFor="email" className="label">Email</label>
              <div className="relative">
                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none"><Mail className="size-4" /></div>
                <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus className="input pl-10" />
              </div>
            </div>
            <button type="submit" disabled={busy || !email} className="btn-primary w-full">
              {busy ? <><Loader2 className="size-4 animate-spin" /> Sending…</> : "Send reset link"}
            </button>
            <Link to="/login" className="btn-ghost text-xs inline-flex"><ArrowLeft className="size-3.5" /> Back to sign in</Link>
          </form>
        )}
      </div>
    </div>
  );
}
