import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
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
  Shield,
  Activity,
  Users,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";

import { useAuthStore } from "@/modules/auth/store/authStore";
import { roleCan } from "@/shared/lib/permissions";
import { cn } from "@/shared/lib/cn";

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  /** Phase 1+ availability — disabled items show as "soon". */
  available?: boolean;
}

const PRIMARY_NAV: NavItem[] = [
  { to: "/", label: "Dashboard", icon: <Home className="size-4" />, available: true },
  { to: "/hosts", label: "Assets", icon: <Server className="size-4" />, available: true },
  { to: "/terminal", label: "Terminal", icon: <TerminalIcon className="size-4" />, available: true },
  { to: "/credentials", label: "Credentials", icon: <KeyRound className="size-4" />, available: true },
  { to: "/files", label: "Files", icon: <FolderTree className="size-4" />, available: true },
  { to: "/network", label: "Network", icon: <Network className="size-4" />, available: true },
  { to: "/folders", label: "Folders", icon: <Folder className="size-4" />, available: true },
  { to: "/tags", label: "Tags", icon: <Tag className="size-4" />, available: true },
];

const SECONDARY_NAV: NavItem[] = [
  { to: "/settings", label: "Settings", icon: <Settings className="size-4" />, available: true },
  { to: "/settings/security/mfa", label: "Security", icon: <Shield className="size-4" />, available: true },
];

// Shown only to admin / super_admin.
const ADMIN_NAV: NavItem[] = [
  { to: "/users", label: "Users", icon: <Users className="size-4" />, available: true },
  { to: "/roles", label: "Roles & Permissions", icon: <Shield className="size-4" />, available: true },
];

export function DashboardLayout() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";
  const canAudit = roleCan(user?.role, "audit:read");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="h-full flex md:grid md:grid-cols-[220px_1fr] bg-bg">
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
          <Link to="/" onClick={() => setSidebarOpen(false)} className="flex items-center gap-2">
            <div className="size-7 rounded bg-bg-elevated border border-border-strong grid place-items-center">
              <svg viewBox="0 0 24 24" fill="none" className="size-4">
                <path
                  d="M12 2L3 7l9 5 9-5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5"
                  stroke="rgb(125 211 160)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="font-display font-semibold text-sm">NetSphere</div>
          </Link>
          <button onClick={() => setSidebarOpen(false)} className="btn-ghost md:hidden -mr-2" aria-label="Close menu">
            <X className="size-4" />
          </button>
        </div>

        <nav onClick={() => setSidebarOpen(false)} className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
          <div className="text-2xs uppercase tracking-widest text-fg-subtle px-2 py-1.5 font-mono">
            Workspace
          </div>
          {PRIMARY_NAV.map((item) => (
            <NavItemLink key={item.to} item={item} />
          ))}

          {(isAdmin || canAudit) && (
            <>
              <div className="text-2xs uppercase tracking-widest text-fg-subtle px-2 py-1.5 mt-4 font-mono">
                Administration
              </div>
              {isAdmin && ADMIN_NAV.map((item) => (
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
          {SECONDARY_NAV.map((item) => (
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
          <button onClick={handleLogout} className="btn-ghost w-full justify-start text-xs">
            <LogOut className="size-3.5" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 min-w-0 flex flex-col h-full">
        {/* Mobile top bar with hamburger */}
        <div className="md:hidden flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-surface">
          <button onClick={() => setSidebarOpen(true)} className="btn-ghost" aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <span className="font-display font-semibold text-sm">NetSphere</span>
        </div>
        <main className="flex-1 min-h-0 overflow-y-auto">
          <Outlet />
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
