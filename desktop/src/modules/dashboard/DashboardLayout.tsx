import { Link, NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import {
  Home,
  Settings,
  LogOut,
  Server,
  KeyRound,
  Folder,
  Tag,
  Terminal as TerminalIcon,
  FolderTree,
  Network,
  Cable,
  DatabaseBackup,
  Mail,
  StickyNote,
  Shield,
  Activity,
  Users,
  Menu,
  X,
  Sun,
  Moon,
  Palette,
  Loader2,
} from "lucide-react";
import { useState, useEffect, lazy, Suspense } from "react";
import { Logo, useAppName } from "@/shared/branding";
import { currentTheme, setTheme, type Theme } from "@/shared/lib/theme";

import { useAuthStore } from "@/modules/auth/store/authStore";

// The terminal workspace is mounted once (lazily, on first visit) and kept
// alive across navigation so its SSH sessions survive switching screens.
const TerminalWorkspace = lazy(() =>
  import("@/modules/sessions/components/TerminalWorkspace").then((m) => ({ default: m.TerminalWorkspace })),
);
const isTerminalPath = (p: string) => /^\/terminal(\/|$)/.test(p) || /^\/hosts\/[^/]+\/terminal$/.test(p);
import { hasPerm, type Permission } from "@/shared/lib/permissions";
import { cn } from "@/shared/lib/cn";

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  /** Phase 1+ availability — disabled items show as "soon". */
  available?: boolean;
  /** If set, the item is only shown to roles holding this permission. */
  perm?: Permission;
}

const PRIMARY_NAV: NavItem[] = [
  { to: "/", label: "Dashboard", icon: <Home className="size-4" />, available: true },
  { to: "/hosts", label: "Assets", icon: <Server className="size-4" />, available: true },
  { to: "/terminal", label: "Terminal", icon: <TerminalIcon className="size-4" />, available: true },
  { to: "/credentials", label: "Credentials", icon: <KeyRound className="size-4" />, available: true },
  { to: "/files", label: "Files", icon: <FolderTree className="size-4" />, available: true },
  { to: "/network", label: "Network", icon: <Network className="size-4" />, available: true },
  { to: "/tunnels", label: "Tunnels", icon: <Cable className="size-4" />, available: true, perm: "tunnels:manage" },
  { to: "/folders", label: "Folders", icon: <Folder className="size-4" />, available: true },
  { to: "/tags", label: "Tags", icon: <Tag className="size-4" />, available: true },
  { to: "/notes", label: "Notes", icon: <StickyNote className="size-4" />, available: true },
];

const SECONDARY_NAV: NavItem[] = [
  { to: "/backup", label: "Backup & Restore", icon: <DatabaseBackup className="size-4" />, available: true, perm: "backup:manage" },
  { to: "/settings", label: "Settings", icon: <Settings className="size-4" />, available: true },
  { to: "/settings/security/mfa", label: "Security", icon: <Shield className="size-4" />, available: true },
];

// Shown only to admin / super_admin.
const ADMIN_NAV: NavItem[] = [
  { to: "/users", label: "Users", icon: <Users className="size-4" />, available: true, perm: "users:manage" },
  { to: "/roles", label: "Roles & Permissions", icon: <Shield className="size-4" />, available: true, perm: "users:manage" },
];
// Branding & SMTP are gated by the admin role (server enforces requireRole), not a permission.
const ADMIN_ROLE_NAV: NavItem[] = [
  { to: "/branding", label: "Branding", icon: <Palette className="size-4" />, available: true },
  { to: "/smtp", label: "Email (SMTP)", icon: <Mail className="size-4" />, available: true },
];

export function DashboardLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const onTerminal = isTerminalPath(location.pathname);
  // Mount the terminal on first visit, then keep it mounted forever so SSH
  // sessions persist while the user works on other screens.
  const [terminalMounted, setTerminalMounted] = useState(false);
  useEffect(() => { if (onTerminal) setTerminalMounted(true); }, [onTerminal]);
  // When the terminal becomes visible again, nudge xterm to refit — it can't
  // measure its container while hidden (display:none).
  useEffect(() => {
    if (!onTerminal) return;
    const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 60);
    return () => clearTimeout(t);
  }, [onTerminal]);

  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";
  // Admins always pass; if the server hasn't sent a permissions list (older
  // session / backend), don't hide anything — fall back to showing it.
  const can = (perm: Permission) =>
    isAdmin || !Array.isArray(user?.permissions) || hasPerm(user?.permissions, perm);
  const canManageUsers = can("users:manage");
  const canAudit = can("audit:read");
  const appName = useAppName();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setThemeState] = useState<Theme>(() => currentTheme());
  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  };

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="h-full flex md:grid md:grid-cols-[220px_1fr] md:grid-rows-1 md:overflow-hidden bg-bg">
      {/* Backdrop (mobile only, when drawer is open) */}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/50 z-30 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar — drawer on mobile, fixed column on md+ */}
      <aside
        className={cn(
          "fixed md:static inset-y-0 left-0 z-40 w-[220px] h-full border-r border-border flex flex-col bg-bg-surface",
          "transition-transform md:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="px-4 py-4 border-b border-border flex items-center justify-between">
          <Link to="/" onClick={() => setSidebarOpen(false)} className="flex items-center gap-2 min-w-0">
            <div className="size-7 rounded bg-bg-elevated border border-border-strong grid place-items-center shrink-0">
              <Logo className="size-4" />
            </div>
            <div className="font-display font-semibold text-sm truncate">{appName}</div>
          </Link>
          <button onClick={() => setSidebarOpen(false)} className="btn-ghost md:hidden -mr-2" aria-label="Close menu">
            <X className="size-4" />
          </button>
        </div>

        <nav onClick={() => setSidebarOpen(false)} className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
          <div className="text-2xs uppercase tracking-widest text-fg-subtle px-2 py-1.5 font-mono">
            Workspace
          </div>
          {PRIMARY_NAV.filter((i) => !i.perm || can(i.perm)).map((item) => (
            <NavItemLink key={item.to} item={item} />
          ))}

          {(isAdmin || canManageUsers || canAudit) && (
            <>
              <div className="text-2xs uppercase tracking-widest text-fg-subtle px-2 py-1.5 mt-4 font-mono">
                Administration
              </div>
              {ADMIN_NAV.filter((i) => !i.perm || can(i.perm)).map((item) => (
                <NavItemLink key={item.to} item={item} />
              ))}
              {isAdmin && ADMIN_ROLE_NAV.map((item) => (
                <NavItemLink key={item.to} item={item} />
              ))}
              {canAudit && (
                <NavItemLink item={{ to: "/audit", label: "Audit", icon: <Activity className="size-4" />, available: true }} />
              )}
            </>
          )}

          <div className="text-2xs uppercase tracking-widest text-fg-subtle px-2 py-1.5 mt-4 font-mono">
            Account
          </div>
          {SECONDARY_NAV.filter((i) => !i.perm || can(i.perm)).map((item) => (
            <NavItemLink key={item.to} item={item} />
          ))}
        </nav>

        {/* User strip */}
        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2 mb-2">
            <div className="size-7 rounded-full bg-accent/20 border border-accent/30 grid place-items-center text-xs font-mono text-accent">
              {(user?.username ?? "?")[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{user?.username ?? "—"}</div>
              <div className="text-2xs text-fg-subtle font-mono uppercase tracking-wider">
                {user?.role ?? ""}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleLogout} className="btn-ghost flex-1 justify-start text-xs">
              <LogOut className="size-3.5" />
              Sign out
            </button>
            <button
              onClick={toggleTheme}
              className="btn-ghost text-xs"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              aria-label="Toggle theme"
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col h-full">
        {/* Mobile top bar with hamburger */}
        <div className="md:hidden flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-surface">
          <button onClick={() => setSidebarOpen(true)} className="btn-ghost" aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <Logo className="size-5" />
          <span className="font-display font-semibold text-sm truncate">{appName}</span>
        </div>
        <main className="flex-1 min-h-0 relative">
          {/* Routed pages */}
          <div className="absolute inset-0 overflow-y-auto" style={{ display: onTerminal ? "none" : "block" }}>
            <Outlet />
          </div>
          {/* Persistent terminal workspace — kept alive across navigation. */}
          {terminalMounted && (
            <div className="absolute inset-0" style={{ display: onTerminal ? "block" : "none" }}>
              <Suspense fallback={<div className="h-full grid place-items-center text-fg-muted"><Loader2 className="size-5 animate-spin" /></div>}>
                <TerminalWorkspace />
              </Suspense>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function NavItemLink({ item }: { item: NavItem }) {
  if (!item.available) {
    return (
      <div
        className={cn(
          "flex items-center gap-2.5 px-2.5 py-1.5 rounded text-sm",
          "text-fg-subtle cursor-not-allowed",
        )}
      >
        {item.icon}
        <span className="flex-1">{item.label}</span>
        <span className="text-2xs font-mono uppercase tracking-wider opacity-60">soon</span>
      </div>
    );
  }
  return (
    <NavLink
      to={item.to}
      end
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 px-2.5 py-1.5 rounded text-sm transition-colors",
          isActive
            ? "bg-bg-elevated text-fg border border-border"
            : "text-fg-muted hover:text-fg hover:bg-bg-elevated/50 border border-transparent",
        )
      }
    >
      {item.icon}
      <span>{item.label}</span>
    </NavLink>
  );
}
