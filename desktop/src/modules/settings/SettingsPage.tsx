import { Link } from "react-router-dom";
import { ChevronRight, KeyRound, Shield, User as UserIcon } from "lucide-react";

import { useAuthStore } from "@/modules/auth/store/authStore";

export function SettingsPage() {
  const user = useAuthStore((s) => s.user);

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

      <Section title="About">
        <Row label="Version" value="1.0.0" mono />
        <Row label="Phase" value="1 — Foundation" />
        <Row label="Build" value="dev" mono small last />
      </Section>
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
