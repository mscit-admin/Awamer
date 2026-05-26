import { ShieldAlert, ShieldCheck, KeyRound } from "lucide-react";
import { Link } from "react-router-dom";

import { useAuthStore } from "@/modules/auth/store/authStore";

export function DashboardHome() {
  const user = useAuthStore((s) => s.user);

  return (
    <div className="px-8 py-8 max-w-5xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="mb-8 pb-6 border-b border-border">
        <div className="text-2xs font-mono uppercase tracking-widest text-fg-subtle mb-2">
          Welcome back
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {user?.full_name || user?.username || "—"}
        </h1>
        <p className="text-sm text-fg-muted mt-1">
          Phase 1 foundation is online. Protocol modules will appear here as they ship.
        </p>
      </div>

      {/* Security posture */}
      <section className="mb-8">
        <h2 className="text-sm font-medium uppercase tracking-wider text-fg-muted mb-3">
          Security
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <SecurityCard
            ok={user?.mfa_enabled ?? false}
            label="Two-factor auth"
            okText="Enabled"
            warnText="Not enabled"
            actionTo="/settings/security/mfa"
            actionLabel={user?.mfa_enabled ? "Manage" : "Enable now"}
            icon={<ShieldCheck className="size-4" />}
            warnIcon={<ShieldAlert className="size-4" />}
          />
          <SecurityCard
            ok
            label="Password"
            okText="Strong (Argon2id)"
            warnText=""
            actionTo="/settings/security/password"
            actionLabel="Change"
            icon={<KeyRound className="size-4" />}
            warnIcon={<KeyRound className="size-4" />}
          />
        </div>
      </section>

      {/* Roadmap teaser */}
      <section>
        <h2 className="text-sm font-medium uppercase tracking-wider text-fg-muted mb-3">
          Roadmap
        </h2>
        <div className="card p-5">
          <RoadmapItem phase={2} title="Sessions & Connections" desc="Profile management, tags, organisation tree." />
          <RoadmapItem phase={3} title="SSH" desc="Full terminal emulation with xterm.js, key & password auth." />
          <RoadmapItem phase={4} title="SFTP" desc="Browse, upload, download, edit remote files." />
          <RoadmapItem phase={5} title="Tunnels" desc="Local, remote and dynamic SSH port forwarding." />
          <RoadmapItem phase={6} title="RDP & VNC" desc="Graphical session support." />
          <RoadmapItem phase={7} title="Serial console" desc="USB & physical serial device support." last />
        </div>
      </section>
    </div>
  );
}

interface SecurityCardProps {
  ok: boolean;
  label: string;
  okText: string;
  warnText: string;
  actionTo: string;
  actionLabel: string;
  icon: React.ReactNode;
  warnIcon: React.ReactNode;
}

function SecurityCard({ ok, label, okText, warnText, actionTo, actionLabel, icon, warnIcon }: SecurityCardProps) {
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between mb-2">
        <div className={ok ? "text-accent" : "text-warning"}>{ok ? icon : warnIcon}</div>
        <Link to={actionTo} className="text-xs text-fg-muted hover:text-accent">
          {actionLabel} →
        </Link>
      </div>
      <div className="text-xs text-fg-subtle uppercase tracking-wider font-mono mb-1">
        {label}
      </div>
      <div className={`text-sm font-medium ${ok ? "text-fg" : "text-warning"}`}>
        {ok ? okText : warnText}
      </div>
    </div>
  );
}

function RoadmapItem({ phase, title, desc, last }: { phase: number; title: string; desc: string; last?: boolean }) {
  return (
    <div className={`flex items-start gap-4 py-3 ${last ? "" : "border-b border-border"}`}>
      <div className="size-8 rounded-md bg-bg-elevated border border-border grid place-items-center font-mono text-xs text-fg-subtle flex-shrink-0">
        P{phase}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-fg-muted mt-0.5">{desc}</div>
      </div>
    </div>
  );
}
