import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  MoreVertical, Copy, Timer, QrCode, Settings2, Edit3, Trash2,
  KeyRound, User, X, Check,
} from "lucide-react";
import { credentialsApi, type CredentialPublic } from "../api/sessionsApi";
import { computeTotp, type TotpAlgorithm } from "../lib/totp";

/** How long after copying the password we auto-copy the TOTP (KeePass-style). */
const PASSWORD_THEN_TOTP_DELAY_MS = 12000;

function fmtCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/**
 * KeePass-style per-entry action menu: copy username/password, copy or show the
 * live TOTP, show a QR of the seed, or jump to setup. OTP actions appear only
 * when the credential has an OTP and the user holds `credentials:reveal`.
 */
export function CredentialActions({ c, canReveal, onEdit, onDelete, notify }: {
  c: CredentialPublic;
  canReveal: boolean;
  onEdit: () => void;
  onDelete: () => void;
  notify: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<null | "totp" | "qr">(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); notify(`${label} copied`); }
    catch { notify("Copy failed"); }
  }

  async function revealPassword(): Promise<string | null> {
    const full = await credentialsApi.get(c.id, true);
    const pw = (full.secret_data as Record<string, unknown> | undefined)?.["password"];
    return typeof pw === "string" ? pw : null;
  }

  async function currentTotp(): Promise<string> {
    const t = await credentialsApi.revealTotp(c.id);
    if (!t.secret) throw new Error("no OTP secret");
    const r = await computeTotp(t.secret, { algorithm: t.algorithm as TotpAlgorithm, digits: t.digits, period: t.period });
    return r.code;
  }

  async function run(fn: () => Promise<void>) {
    setOpen(false);
    try { await fn(); } catch (e) { notify(e instanceof Error ? e.message : "Action failed"); }
  }

  async function copyPassword() {
    const pw = await revealPassword();
    if (pw == null) { notify("No password set"); return; }
    await copy(pw, "Password");
  }

  async function copyPasswordAndTotp() {
    const pw = await revealPassword();
    if (pw != null) await copy(pw, "Password");
    notify(`Password copied — TOTP in ${PASSWORD_THEN_TOTP_DELAY_MS / 1000}s`);
    setTimeout(() => {
      void (async () => {
        try {
          const code = await currentTotp();
          if (code) await copy(code, "TOTP");
        } catch { /* ignore */ }
      })();
    }, PASSWORD_THEN_TOTP_DELAY_MS);
  }

  const otpActions = c.hasTotp && canReveal;

  return (
    <div className="relative" ref={rootRef}>
      <button onClick={() => setOpen((o) => !o)} className="btn-icon" title="Actions"><MoreVertical className="size-4" /></button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-56 bg-bg-surface border border-border rounded-lg shadow-xl py-1 text-sm">
          {c.username && <MenuItem icon={<User className="size-3.5" />} label="Copy username" onClick={() => run(() => copy(c.username!, "Username"))} />}
          {canReveal && <MenuItem icon={<KeyRound className="size-3.5" />} label="Copy password" onClick={() => run(copyPassword)} />}
          {otpActions && <Divider />}
          {otpActions && <MenuItem icon={<Copy className="size-3.5" />} label="Copy TOTP" onClick={() => run(async () => copy(await currentTotp(), "TOTP"))} />}
          {otpActions && <MenuItem icon={<Copy className="size-3.5" />} label="Copy password & TOTP" onClick={() => run(copyPasswordAndTotp)} />}
          {otpActions && <MenuItem icon={<Timer className="size-3.5" />} label="Show TOTP" onClick={() => { setOpen(false); setModal("totp"); }} />}
          {otpActions && <MenuItem icon={<QrCode className="size-3.5" />} label="Show QR code" onClick={() => { setOpen(false); setModal("qr"); }} />}
          <Divider />
          <MenuItem icon={<Settings2 className="size-3.5" />} label={c.hasTotp ? "Manage OTP…" : "Set up TOTP…"} onClick={() => { setOpen(false); onEdit(); }} />
          <MenuItem icon={<Edit3 className="size-3.5" />} label="Edit entry" onClick={() => { setOpen(false); onEdit(); }} />
          <MenuItem icon={<Trash2 className="size-3.5" />} label="Delete entry" danger onClick={() => { setOpen(false); onDelete(); }} />
        </div>
      )}
      {modal === "totp" && <ShowTotpModal c={c} onClose={() => setModal(null)} notify={notify} />}
      {modal === "qr" && <ShowQrModal c={c} onClose={() => setModal(null)} />}
    </div>
  );
}

function Divider() { return <div className="my-1 border-t border-border" />; }

function MenuItem({ icon, label, onClick, danger }: {
  icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 hover:bg-bg-elevated text-left ${danger ? "text-red-400" : ""}`}
    >
      <span className={danger ? "" : "text-fg-muted"}>{icon}</span>
      <span className="flex-1">{label}</span>
    </button>
  );
}

// =====================================================================
// Show TOTP — a read-only live code panel (KeePass "Show TOTP")
// =====================================================================

function ShowTotpModal({ c, onClose, notify }: { c: CredentialPublic; onClose: () => void; notify: (m: string) => void }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [cfg, setCfg] = useState<{ algorithm?: TotpAlgorithm; digits?: number; period?: number } | null>(null);
  const [live, setLive] = useState<{ code: string; secondsRemaining: number; period: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const t = await credentialsApi.revealTotp(c.id);
        if (!active) return;
        setSecret(t.secret ?? null);
        setCfg({ algorithm: t.algorithm, digits: t.digits, period: t.period });
      } catch (e) { if (active) setErr(e instanceof Error ? e.message : "Failed to load OTP"); }
    })();
    return () => { active = false; };
  }, [c.id]);

  useEffect(() => {
    if (!secret || !cfg) return;
    let active = true;
    const tick = async () => {
      try {
        const r = await computeTotp(secret, { algorithm: cfg.algorithm, digits: cfg.digits, period: cfg.period });
        if (active) setLive(r);
      } catch { /* ignore */ }
    };
    void tick();
    const iv = setInterval(tick, 1000);
    return () => { active = false; clearInterval(iv); };
  }, [secret, cfg]);

  return (
    <Overlay onClose={onClose} title={`OTP — ${c.name}`}>
      {err && <div className="text-sm text-red-500">{err}</div>}
      {!err && (
        <div className="text-center py-2">
          <div className="text-4xl font-mono tracking-widest tabular-nums">{live ? fmtCode(live.code) : "······"}</div>
          {live && (
            <>
              <div className="h-1.5 bg-bg-elevated rounded overflow-hidden mt-3 mx-auto max-w-xs">
                <div className="h-full bg-sky-400 transition-all" style={{ width: `${(live.secondsRemaining / live.period) * 100}%` }} />
              </div>
              <div className="text-xs text-fg-muted mt-1">refreshes in {live.secondsRemaining}s</div>
              <button
                onClick={() => { void navigator.clipboard.writeText(live.code); setCopied(true); notify("TOTP copied"); setTimeout(() => setCopied(false), 1200); }}
                className="btn-primary mt-4 inline-flex"
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />} Copy code
              </button>
            </>
          )}
        </div>
      )}
    </Overlay>
  );
}

// =====================================================================
// Show QR — render the otpauth URI so it can be scanned into an app
// =====================================================================

function ShowQrModal({ c, onClose }: { c: CredentialPublic; onClose: () => void }) {
  const [uri, setUri] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const t = await credentialsApi.revealTotp(c.id);
        if (!t.secret) throw new Error("this credential has no OTP");
        const issuer = "Awamer";
        const account = c.username || c.name;
        const params = new URLSearchParams({
          secret: t.secret,
          issuer,
          algorithm: t.algorithm ?? "SHA1",
          digits: String(t.digits ?? 6),
          period: String(t.period ?? 30),
        });
        if (active) setUri(`otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${params.toString()}`);
      } catch (e) { if (active) setErr(e instanceof Error ? e.message : "Failed to load OTP"); }
    })();
    return () => { active = false; };
  }, [c.id]);

  return (
    <Overlay onClose={onClose} title={`OTP QR — ${c.name}`}>
      {err && <div className="text-sm text-red-500">{err}</div>}
      {!err && uri && (
        <div className="flex flex-col items-center gap-3 py-2">
          <div className="bg-white p-3 rounded">
            <QRCodeSVG value={uri} size={200} level="M" />
          </div>
          <p className="text-2xs text-fg-muted text-center max-w-xs">
            Scan with an authenticator app (Google Authenticator, Aegis, 1Password…) to copy this OTP to your phone.
          </p>
        </div>
      )}
      {!err && !uri && <div className="text-sm text-fg-muted">Loading…</div>}
    </Overlay>
  );
}

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-[60] animate-fade-in p-4" onMouseDown={onClose}>
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-sm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold truncate">{title}</h3>
          <button onClick={onClose} className="btn-icon"><X className="size-4" /></button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
