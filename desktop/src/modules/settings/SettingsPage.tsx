import { Link } from "react-router-dom";
import { ChevronRight, KeyRound, Shield, User as UserIcon, Clock, Loader2, CheckCircle2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useAuthStore } from "@/modules/auth/store/authStore";
import { sessionSettingsApi } from "./sessionSettingsApi";
import { useTerminalUi } from "@/modules/sessions/store/terminalUiStore";
import { useTerminalPaste, type PasteButton } from "@/modules/sessions/store/terminalPastePref";
import { useLockStore } from "@/modules/auth/store/lockStore";
import { ApiError } from "@/shared/lib/api";
import { hasPerm } from "@/shared/lib/permissions";

export function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  // Instance-wide SSH policy: settings:manage (Super Admin), not "any admin".
  const canInstanceSettings = Array.isArray(user?.permissions)
    ? hasPerm(user?.permissions, "settings:manage")
    : user?.role === "super_admin";

  return (
    <div className="px-8 py-8 max-w-3xl mx-auto animate-fade-in">
      <h1 className="text-xl font-semibold tracking-tight mb-1">Settings</h1>
      <p className="text-sm text-fg-muted mb-8">
        Manage your account, security, and preferences.
      </p>

      <Section title="Profile">
        <Row label="Username" value={user?.username ?? "—"} />
        <Row label="Email" value={user?.email ?? "—"} />
        <Row label="Full name" value={user?.full_name || "—"} />
        <Row label="Role" value={user?.role ?? "—"} mono />
        <Row label="User ID" value={user?.id ?? "—"} mono small last />
      </Section>

      <Section title="Security" icon={<Shield className="size-4" />}>
        <SettingLink
          to="/settings/security/password"
          icon={<KeyRound className="size-4" />}
          title="Change password"
          desc="Update your account password. Sign-out from all devices."
        />
        <SettingLink
          to="/settings/security/mfa"
          icon={<Shield className="size-4" />}
          title="Two-factor authentication"
          desc={user?.mfa_enabled ? "Enabled — manage your authenticator." : "Not enabled — set up TOTP now."}
          last
        />
      </Section>

      <Section title="Auto-lock" icon={<Shield className="size-4" />}>
        <AutoLockSettings />
      </Section>

      <Section title="Terminal">
        <TerminalUiSettings />
      </Section>

      {canInstanceSettings && (
        <Section title="SSH sessions" icon={<Clock className="size-4" />}>
          <AdminSessionSettings />
        </Section>
      )}

      <Section title="About">
        <Row label="Version" value="1.0.0" mono />
        <Row label="Phase" value="1 — Foundation" />
        <Row label="Build" value="dev" mono small last />
      </Section>
    </div>
  );
}

function AutoLockSettings() {
  const idleTimeoutMin = useLockStore((s) => s.idleTimeoutMin);
  const setIdleTimeout = useLockStore((s) => s.setIdleTimeout);
  const lock = useLockStore((s) => s.lock);
  return (
    <div className="px-4 py-4 space-y-3">
      <div>
        <label className="block text-xs text-fg-muted mb-1">Lock after inactivity (minutes)</label>
        <div className="flex items-center gap-2">
          <input type="number" min={0} max={480} value={idleTimeoutMin}
            onChange={(e) => setIdleTimeout(Number(e.target.value))} className="input w-24" />
          <button onClick={lock} className="btn-ghost text-sm"><Shield className="size-3.5" /> Lock now</button>
        </div>
        <p className="text-2xs text-fg-muted mt-1">
          After this many idle minutes the screen locks and asks for your password — your open
          terminals stay connected behind it. <span className="font-medium">0 = never</span>. Saved in this browser.
        </p>
      </div>
    </div>
  );
}

function TerminalUiSettings() {
  const bottomGapPx = useTerminalUi((s) => s.bottomGapPx);
  const setBottomGapPx = useTerminalUi((s) => s.setBottomGapPx);
  const quickButton = useTerminalPaste((s) => s.quickButton);
  const editButton = useTerminalPaste((s) => s.editButton);
  const setQuickButton = useTerminalPaste((s) => s.setQuickButton);
  const setEditButton = useTerminalPaste((s) => s.setEditButton);
  return (
    <div className="px-4 py-4">
      <label className="block text-xs text-fg-muted mb-1">Bottom spacing (px)</label>
      <div className="flex items-center gap-3">
        <input type="range" min={0} max={120} step={4} value={bottomGapPx}
          onChange={(e) => setBottomGapPx(Number(e.target.value))} className="flex-1 max-w-xs accent-accent" />
        <input type="number" min={0} max={200} value={bottomGapPx}
          onChange={(e) => setBottomGapPx(Number(e.target.value))} className="input w-20" />
      </div>
      <p className="text-2xs text-fg-muted mt-1">
        Extra space between the terminal prompt and the status bar, in case the bottom line is hidden behind the
        OS taskbar. The status bar stays flush at the bottom. <span className="font-medium">0 = none</span>.
        Applies live; saved in this browser.
      </p>

      <div className="mt-5 pt-4 border-t border-border">
        <label className="block text-xs text-fg-muted mb-2">Mouse paste</label>
        <div className="grid grid-cols-2 gap-3 max-w-md">
          <PasteButtonSelect
            label="Paste immediately"
            value={quickButton}
            onChange={setQuickButton}
          />
          <PasteButtonSelect
            label="Paste with edit popup"
            value={editButton}
            onChange={setEditButton}
          />
        </div>
        <p className="text-2xs text-fg-muted mt-2">
          Bind a mouse button to paste the clipboard into the terminal. <span className="font-medium">Immediately</span> pastes
          the clipboard as-is; <span className="font-medium">edit popup</span> opens a box to review/edit the text first.
          The two actions use different buttons. The toolbar <span className="font-medium">Paste</span> button always opens
          the edit popup. Left-click stays for selecting text. Saved in this browser.
        </p>
      </div>
    </div>
  );
}

function PasteButtonSelect({ label, value, onChange }: { label: string; value: PasteButton; onChange: (b: PasteButton) => void }) {
  return (
    <div>
      <span className="block text-2xs text-fg-muted mb-1">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as PasteButton)} className="input w-full text-sm">
        <option value="none">Off</option>
        <option value="middle">Middle-click</option>
        <option value="right">Right-click</option>
      </select>
    </div>
  );
}

function AdminSessionSettings() {
  const [minutes, setMinutes] = useState<number | "">(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sessionSettingsApi.get()
      .then((r) => setMinutes(r.ssh_idle_timeout_minutes || 0))
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      const r = await sessionSettingsApi.update(minutes === "" ? 0 : Number(minutes));
      setMinutes(r.ssh_idle_timeout_minutes || 0);
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="px-4 py-4 text-sm text-fg-muted flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading…</div>;
  }
  return (
    <div className="px-4 py-4 space-y-3">
      <div>
        <label className="block text-xs text-fg-muted mb-1">Idle timeout (minutes)</label>
        <div className="flex items-center gap-2">
          <input type="number" min={0} max={1440} value={minutes}
            onChange={(e) => setMinutes(e.target.value === "" ? "" : Number(e.target.value))}
            className="input w-32" />
          <button onClick={save} disabled={busy} className="btn-primary">
            {busy ? <><Loader2 className="size-4 animate-spin" /> Saving…</> : "Save"}
          </button>
          {saved && <span className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle2 className="size-3.5" /> Saved</span>}
        </div>
        <p className="text-2xs text-fg-muted mt-1">
          Auto-disconnect a browser SSH terminal after this many minutes with no activity.
          <span className="font-medium"> 0 = never</span>. Sessions also use TCP keepalive so they don't drop on network idle.
        </p>
      </div>
      {error && <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded">{error}</div>}
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-fg-muted mb-3 font-mono">
        {icon}
        {title}
      </h2>
      <div className="card divide-y divide-border">{children}</div>
    </section>
  );
}

function Row({
  label,
  value,
  mono,
  small,
  last,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
  last?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between px-4 py-3 ${last ? "" : ""}`}>
      <div className="text-sm text-fg-muted">{label}</div>
      <div className={`${mono ? "font-mono" : ""} ${small ? "text-xs" : "text-sm"} text-fg`}>{value}</div>
    </div>
  );
}

function SettingLink({
  to,
  icon,
  title,
  desc,
  last,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  desc: string;
  last?: boolean;
}) {
  return (
    <Link
      to={to}
      className={`flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-bg-elevated/50 ${last ? "" : ""}`}
    >
      <div className="size-8 rounded-md bg-bg-elevated grid place-items-center text-fg-muted">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-fg-muted mt-0.5">{desc}</div>
      </div>
      <ChevronRight className="size-4 text-fg-subtle" />
    </Link>
  );
}

// Suppress unused-import if UserIcon ends up not used after refactor
void UserIcon;
