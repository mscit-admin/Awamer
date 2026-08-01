import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { useEffect, lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";

import { useAuthStore } from "@/modules/auth/store/authStore";
// Auth shell stays eager so the login screen paints instantly.
import { LoginPage } from "@/modules/auth/components/LoginPage";
import { MFAChallengePage } from "@/modules/auth/components/MFAChallengePage";
import { ForgotPasswordPage } from "@/modules/auth/components/ForgotPasswordPage";
import { ResetPasswordPage } from "@/modules/auth/components/ResetPasswordPage";
import { MFASetupPage } from "@/modules/auth/components/MFASetupPage";
import { ChangePasswordPage } from "@/modules/auth/components/ChangePasswordPage";
import { ProtectedRoute } from "@/modules/auth/components/ProtectedRoute";
import { DashboardLayout } from "@/modules/dashboard/DashboardLayout";
import { DashboardHome } from "@/modules/dashboard/DashboardHome";
import { TerminalRoute } from "@/modules/sessions/components/TerminalRoute";
import { isTauri } from "@/shared/lib/tauri";

// Everything below is code-split: heavy libraries (xterm, noVNC, Monaco,
// kdbxweb, hash-wasm) only download when their page is actually opened.
const lz = <T extends Record<string, unknown>, K extends keyof T>(
  factory: () => Promise<T>, key: K,
) => lazy(() => factory().then((m) => ({ default: m[key] as unknown as React.ComponentType })));

const SettingsPage = lz(() => import("@/modules/settings/SettingsPage"), "SettingsPage");
const UsersPage = lz(() => import("@/modules/users/UsersPage"), "UsersPage");
const RolesPage = lz(() => import("@/modules/users/RolesPage"), "RolesPage");
const OrganizationPage = lz(() => import("@/modules/org/OrganizationPage"), "OrganizationPage");
const AiProvidersPage = lz(() => import("@/modules/ai/AiProvidersPage"), "AiProvidersPage");
const AuditPage = lz(() => import("@/modules/users/AuditPage"), "AuditPage");
const BrandingPage = lz(() => import("@/modules/users/BrandingPage"), "BrandingPage");
const SmtpPage = lz(() => import("@/modules/users/SmtpPage"), "SmtpPage");
const KeepassImportPage = lz(() => import("@/modules/users/KeepassImportPage"), "KeepassImportPage");

const HostsPage = lz(() => import("@/modules/sessions/components/HostsPage"), "HostsPage");
const HostFormPage = lazy(() => import("@/modules/sessions/components/HostFormPage").then((m) => ({ default: m.HostFormPage })));
const HostDetailPage = lz(() => import("@/modules/sessions/components/HostDetailPage"), "HostDetailPage");
const CredentialsPage = lz(() => import("@/modules/sessions/components/CredentialsPage"), "CredentialsPage");
const TagsPage = lz(() => import("@/modules/sessions/components/TagsPage"), "TagsPage");
const FoldersPage = lz(() => import("@/modules/sessions/components/FoldersPage"), "FoldersPage");
const SftpPage = lz(() => import("@/modules/sessions/components/SftpPage"), "SftpPage");
const WebSftpPage = lz(() => import("@/modules/sessions/components/WebSftpPage"), "WebSftpPage");
const VncPage = lz(() => import("@/modules/sessions/components/VncPage"), "VncPage");
const TelnetPage = lz(() => import("@/modules/sessions/components/TelnetPage"), "TelnetPage");
const FilesPage = lz(() => import("@/modules/sessions/components/FilesPage"), "FilesPage");
const NetworkPage = lz(() => import("@/modules/sessions/components/NetworkPage"), "NetworkPage");
const TunnelsPage = lz(() => import("@/modules/sessions/components/TunnelsPage"), "TunnelsPage");
const VpnPage = lz(() => import("@/modules/sessions/components/VpnPage"), "VpnPage");
const BackupPage = lz(() => import("@/modules/sessions/components/BackupPage"), "BackupPage");
const NotesPage = lz(() => import("@/modules/notes/NotesPage"), "NotesPage");

function RouteFallback() {
  return (
    <div className="h-full grid place-items-center text-fg-muted">
      <Loader2 className="size-5 animate-spin" />
    </div>
  );
}

export default function App() {
  const restore = useAuthStore((s) => s.restore);
  const navigate = useNavigate();

  // Restore session from secure keyring on first mount.
  useEffect(() => {
    void restore();
  }, [restore]);

  // Password-reset links land on the root with ?reset_token=… (so they work
  // even without server-side SPA deep-link fallback). Forward to the reset
  // screen client-side and strip the param.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const token = sp.get("reset_token");
    if (token) navigate(`/reset-password?token=${encodeURIComponent(token)}`, { replace: true });
  }, [navigate]);

  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* Public auth routes */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/login/mfa" element={<MFAChallengePage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />

        {/* Protected app shell */}
        <Route
          element={
            <ProtectedRoute>
              <DashboardLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<DashboardHome />} />

          {/* Phase 2 — Session Management */}
          <Route path="/hosts" element={<HostsPage />} />
          <Route path="/hosts/new" element={<HostFormPage mode="create" />} />
          <Route path="/hosts/:id" element={<HostDetailPage />} />
          <Route path="/hosts/:id/edit" element={<HostFormPage mode="edit" />} />
          <Route path="/hosts/:id/terminal" element={<TerminalRoute />} />
          <Route path="/hosts/:id/sftp" element={isTauri ? <SftpPage /> : <WebSftpPage />} />
          <Route path="/hosts/:id/vnc" element={<VncPage />} />
          <Route path="/hosts/:id/telnet" element={<TelnetPage />} />
          <Route path="/terminal" element={<TerminalRoute />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/network" element={<NetworkPage />} />
          <Route path="/tunnels" element={<TunnelsPage />} />
          <Route path="/vpn" element={<VpnPage />} />
          <Route path="/backup" element={<BackupPage />} />
          <Route path="/credentials" element={<CredentialsPage />} />
          <Route path="/credentials/import/keepass" element={<KeepassImportPage />} />
          <Route path="/tags" element={<TagsPage />} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="/folders" element={<FoldersPage />} />

          <Route path="/users" element={<UsersPage />} />
          <Route path="/roles" element={<RolesPage />} />
          <Route path="/organization" element={<OrganizationPage />} />
          <Route path="/ai-providers" element={<AiProvidersPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/branding" element={<BrandingPage />} />
          <Route path="/smtp" element={<SmtpPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/security/password" element={<ChangePasswordPage />} />
          <Route path="/settings/security/mfa" element={<MFASetupPage />} />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
