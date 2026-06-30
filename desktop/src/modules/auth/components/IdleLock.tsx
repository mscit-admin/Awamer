/**
 * Idle auto-lock. Tracks user activity; after the configured idle timeout it
 * locks the app with a password prompt — without disconnecting open terminals
 * (the lock is an overlay, the app stays mounted). Unlock verifies the current
 * user's password.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Lock, Loader2, AlertCircle, LogOut } from "lucide-react";
import { useLockStore } from "../store/lockStore";
import { useAuthStore } from "../store/authStore";
import { lockApi } from "../api/lockApi";
import { Logo, useAppName } from "@/shared/branding";
import { ApiError } from "@/shared/lib/api";

const ACTIVITY = ["mousemove", "mousedown", "keydown", "touchstart", "wheel", "scroll"] as const;

export function IdleLock() {
  const idleTimeoutMin = useLockStore((s) => s.idleTimeoutMin);
  const locked = useLockStore((s) => s.locked);
  const lock = useLockStore((s) => s.lock);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Idle timer — reset on any activity; fire lock() when it elapses.
  useEffect(() => {
    if (locked || idleTimeoutMin <= 0) return;
    const reset = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => lock(), idleTimeoutMin * 60_000);
    };
    ACTIVITY.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      ACTIVITY.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [idleTimeoutMin, locked, lock]);

  if (!locked) return null;
  return <LockScreen />;
}

function LockScreen() {
  const appName = useAppName();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const unlock = useLockStore((s) => s.unlock);

  const [username, setUsername] = useState(user?.username ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (username.trim() && user?.username && username.trim().toLowerCase() !== user.username.toLowerCase()) {
      setError("This account is locked — sign in as " + user.username + ".");
      return;
    }
    setBusy(true);
    try {
      await lockApi.verifyPassword(password);
      setPassword("");
      unlock();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "Incorrect password." : err instanceof Error ? err.message : "Unlock failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] bg-bg/95 backdrop-blur-md grid place-items-center px-6 animate-fade-in">
      <div className="w-full max-w-sm card p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="size-9 rounded-md bg-bg-elevated border border-border-strong grid place-items-center"><Logo className="size-5" /></div>
          <div>
            <div className="font-display font-semibold tracking-tight leading-none">{appName}</div>
            <div className="text-2xs text-fg-subtle font-mono uppercase tracking-widest mt-1 flex items-center gap-1"><Lock className="size-2.5" /> locked</div>
          </div>
        </div>

        <h1 className="text-lg font-semibold mb-1">Screen locked</h1>
        <p className="text-sm text-fg-muted mb-6">Your session is still running. Enter your password to continue.</p>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" className="input w-full" />
          </div>
          <div>
            <label className="label">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus required className="input w-full" />
          </div>
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-danger/10 border border-danger/30 text-danger text-sm">
              <AlertCircle className="size-4 mt-0.5 shrink-0" /> <span>{error}</span>
            </div>
          )}
          <button type="submit" disabled={busy || !password} className="btn-primary w-full">
            {busy ? <><Loader2 className="size-4 animate-spin" /> Unlocking…</> : "Unlock"}
          </button>
        </form>

        <button onClick={() => { unlock(); void logout(); }} className="btn-ghost text-xs mt-4 inline-flex gap-1">
          <LogOut className="size-3.5" /> Sign out instead
        </button>
      </div>
    </div>
  );
}
