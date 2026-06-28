import { Routes, Route, Navigate } from "react-router-dom";
import { useEffect } from "react";

import { useAuthStore } from "@/modules/auth/store/authStore";
import { LoginPage } from "@/modules/auth/components/LoginPage";
import { MFAChallengePage } from "@/modules/auth/components/MFAChallengePage";
import { ChangePasswordPage } from "@/modules/auth/components/ChangePasswordPage";
import { MFASetupPage } from "@/modules/auth/components/MFASetupPage";
import { ProtectedRoute } from "@/modules/auth/components/ProtectedRoute";
import { DashboardLayout } from "@/modules/dashboard/DashboardLayout";
import { DashboardHome } from "@/modules/dashboard/DashboardHome";
import { SettingsPage } from "@/modules/settings/SettingsPage";
import { UsersPage } from "@/modules/users/UsersPage";
import { RolesPage } from "@/modules/users/RolesPage";

// Phase 2 — Session Management
import { HostsPage } from "@/modules/sessions/components/HostsPage";
import { HostFormPage } from "@/modules/sessions/components/HostFormPage";
import { HostDetailPage } from "@/modules/sessions/components/HostDetailPage";
import { CredentialsPage } from "@/modules/sessions/components/CredentialsPage";
import { TagsPage } from "@/modules/sessions/components/TagsPage";
import { FoldersPage } from "@/modules/sessions/components/FoldersPage";
// Phase 3 (1.3.0) — multi-tab SSH terminal
import { TerminalWorkspace } from "@/modules/sessions/components/TerminalWorkspace";
// Phase 4 (1.5.0) — SFTP file browser
import { SftpPage } from "@/modules/sessions/components/SftpPage";
import { WebSftpPage } from "@/modules/sessions/components/WebSftpPage";
import { isTauri } from "@/shared/lib/tauri";

export default function App() {
  const restore = useAuthStore((s) => s.restore);

  // Restore session from secure keyring on first mount.
  useEffect(() => {
    void restore();
  }, [restore]);

  return (
    <Routes>
      {/* Public auth routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/login/mfa" element={<MFAChallengePage />} />

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
        <Route path="/hosts/:id/terminal" element={<TerminalWorkspace />} />
        <Route path="/hosts/:id/sftp" element={isTauri ? <SftpPage /> : <WebSftpPage />} />
        <Route path="/terminal" element={<TerminalWorkspace />} />
        <Route path="/credentials" element={<CredentialsPage />} />
        <Route path="/tags" element={<TagsPage />} />
        <Route path="/folders" element={<FoldersPage />} />

        <Route path="/users" element={<UsersPage />} />
        <Route path="/roles" element={<RolesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/security/password" element={<ChangePasswordPage />} />
        <Route path="/settings/security/mfa" element={<MFASetupPage />} />
      </Route>

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
