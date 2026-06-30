/**
 * Route target for /terminal and /hosts/:id/terminal.
 *
 * The actual terminal workspace is mounted persistently in DashboardLayout (so
 * sessions survive navigation). This component only handles the side-effect of
 * opening/focusing a tab when arriving via /hosts/:id/terminal, then redirects
 * to /terminal. It renders nothing — the layout shows the live workspace.
 */
import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTerminalTabs } from "../store/terminalTabsStore";
import { hostsApi } from "../api/sessionsApi";

export function TerminalRoute() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const openTab = useTerminalTabs((s) => s.openTab);
  const setActive = useTerminalTabs((s) => s.setActive);

  useEffect(() => {
    if (!id) return; // bare /terminal — just show the workspace
    void (async () => {
      let label = id.slice(0, 8);
      try { label = (await hostsApi.get(id)).name; } catch { /* fallback to short id */ }
      const tabId = openTab(id, label);
      setActive(tabId);
      navigate("/terminal", { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return null;
}
