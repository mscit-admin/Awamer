import { useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Navigate, useLocation, useNavigate, Link } from "react-router-dom";
import { Loader2, Lock, User as UserIcon, AlertCircle, GripVertical } from "lucide-react";

import { useAuthStore } from "@/modules/auth/store/authStore";
import { Logo, useAppName, useLoginImage } from "@/shared/branding";

export function LoginPage() {
  const navigate = useNavigate();
  const appName = useAppName();
  const loginImage = useLoginImage();
  const location = useLocation();
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const login = useAuthStore((s) => s.login);
  const clearError = useAuthStore((s) => s.clearError);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Draggable card: offset from the centered position.
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  function onHandleDown(e: ReactPointerEvent) {
    drag.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function onHandleMove(e: ReactPointerEvent) {
    if (!drag.current) return;
    setPos({ x: drag.current.ox + (e.clientX - drag.current.sx), y: drag.current.oy + (e.clientY - drag.current.sy) });
  }
  function onHandleUp(e: ReactPointerEvent) {
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }

  if (status === "authenticated") {
    const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? "/";
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    clearError();
    setSubmitting(true);
    try {
      const { mfaRequired } = await login(username, password);
      if (mfaRequired) navigate("/login/mfa");
    } catch {
      /* error already in store */
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative h-full overflow-hidden animate-fade-in">
      {/* Background image (from Branding) */}
      {loginImage && (
        <>
          <img src={loginImage} alt="" className="absolute inset-0 size-full object-cover" />
          <div className="absolute inset-0 bg-bg/70 backdrop-blur-sm" />
        </>
      )}

      <div className="absolute inset-0 grid place-items-center px-6">
        <div
          className="w-full max-w-sm card p-8 shadow-2xl"
          style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
        >
        {/* Brand mark — also the drag handle */}
        <div
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          className="flex items-center gap-3 mb-10 cursor-move select-none touch-none"
          title="Drag to move"
        >
          <BrandMark />
          <div className="flex-1">
            <div className="font-display font-semibold tracking-tight text-lg leading-none">{appName}</div>
            <div className="text-2xs text-fg-subtle font-mono uppercase tracking-widest mt-1">terminal</div>
          </div>
          <GripVertical className="size-4 text-fg-subtle" />
        </div>

        <h1 className="text-xl font-semibold mb-1">Sign in</h1>
        <p className="text-sm text-fg-muted mb-8">
          Enter your credentials to access the platform.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <Field
            id="username"
            label="Username"
            icon={<UserIcon className="size-4" />}
            value={username}
            onChange={setUsername}
            autoComplete="username"
            autoFocus
            required
          />
          <Field
            id="password"
            label="Password"
            icon={<Lock className="size-4" />}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            required
          />

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 p-3 rounded-md bg-danger/10 border border-danger/30 text-danger text-sm"
            >
              <AlertCircle className="size-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" disabled={submitting} className="btn-primary w-full">
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Signing in…
              </>
            ) : (
              "Sign in"
            )}
          </button>

          <div className="text-center">
            <Link to="/forgot-password" className="text-xs text-fg-muted hover:text-accent">Forgot password?</Link>
          </div>
        </form>

        <div className="mt-10 pt-6 border-t border-border">
          <p className="text-xs text-fg-subtle font-mono">
            v1.0.0 · phase 1 foundation
          </p>
        </div>
        </div>
      </div>
    </div>
  );
}

interface FieldProps {
  id: string;
  label: string;
  icon?: React.ReactNode;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  autoFocus?: boolean;
  required?: boolean;
}

function Field({ id, label, icon, type = "text", value, onChange, autoComplete, autoFocus, required }: FieldProps) {
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      <div className="relative">
        {icon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none">
            {icon}
          </div>
        )}
        <input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          required={required}
          className={`input ${icon ? "pl-10" : ""}`}
        />
      </div>
    </div>
  );
}

function BrandMark() {
  return (
    <div className="size-9 rounded-md bg-bg-elevated border border-border-strong grid place-items-center shadow-glow">
      <Logo className="size-5" />
    </div>
  );
}
