/**
 * Audit log viewer (admin / auditor — requires audit:read).
 * Read-only table of recorded security & resource events, with filters.
 */
import { useEffect, useState } from "react";
import { Activity, Loader2, AlertCircle, CheckCircle2, XCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { auditApi, type AuditEntry } from "./auditApi";

const PAGE = 50;

const ACTIONS = [
  "", "login_success", "login_failed", "logout", "password_change",
  "mfa_enroll", "mfa_disable", "token_reuse_detected",
  "user_create", "user_update", "user_delete",
  "credential_create", "credential_read", "credential_update", "credential_delete",
  "host_create", "host_update", "host_delete",
];

export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState("");
  const [success, setSuccess] = useState<"" | "true" | "false">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    auditApi.list({ limit: PAGE, offset, action: action || undefined, success: success || undefined })
      .then((r) => { setEntries(r.data); setTotal(r.total); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [offset, action, success]);

  // Reset to first page when filters change.
  useEffect(() => { setOffset(0); }, [action, success]);

  return (
    <div className="max-w-5xl mx-auto py-6 px-4 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-md bg-bg-elevated border border-border grid place-items-center">
          <Activity className="size-5 text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Audit log</h1>
          <p className="text-sm text-fg-muted mt-0.5">Recorded security and resource events.</p>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <select value={action} onChange={(e) => setAction(e.target.value)} className="input text-xs py-1">
          {ACTIONS.map((a) => <option key={a} value={a}>{a === "" ? "All actions" : a}</option>)}
        </select>
        <select value={success} onChange={(e) => setSuccess(e.target.value as "" | "true" | "false")} className="input text-xs py-1">
          <option value="">All outcomes</option>
          <option value="true">Success</option>
          <option value="false">Failed</option>
        </select>
        <div className="flex-1" />
        <span className="text-xs text-fg-muted">{total} events</span>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded flex items-center gap-2">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}

      <div className="card overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-fg-muted text-sm flex items-center justify-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase text-fg-muted border-b border-border">
              <tr>
                <th className="text-left font-medium px-3 py-2 w-44">Time</th>
                <th className="text-left font-medium px-3 py-2 w-32">User</th>
                <th className="text-left font-medium px-3 py-2">Action</th>
                <th className="text-left font-medium px-3 py-2 w-40">Resource</th>
                <th className="text-left font-medium px-3 py-2 w-32">IP</th>
                <th className="px-3 py-2 w-16 text-center">OK</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-border/50 hover:bg-bg-elevated/40">
                  <td className="px-3 py-1.5 text-xs text-fg-muted font-mono whitespace-nowrap">
                    {new Date(e.timestamp).toLocaleString()}
                  </td>
                  <td className="px-3 py-1.5 truncate">{e.username ?? <span className="text-fg-subtle">—</span>}</td>
                  <td className="px-3 py-1.5"><span className="font-mono text-xs">{e.action}</span></td>
                  <td className="px-3 py-1.5 text-xs text-fg-muted truncate">
                    {e.resource_type ? `${e.resource_type}${e.resource_id ? " · " + e.resource_id.slice(0, 8) : ""}` : ""}
                  </td>
                  <td className="px-3 py-1.5 text-xs font-mono text-fg-muted">{e.ip_address ?? ""}</td>
                  <td className="px-3 py-1.5 text-center">
                    {e.success
                      ? <CheckCircle2 className="size-4 text-emerald-400 inline" />
                      : <XCircle className="size-4 text-red-400 inline" />}
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-fg-muted text-sm">No events</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 mt-4">
        <button
          onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
          disabled={offset === 0}
          className="btn-ghost text-xs disabled:opacity-40"
        >
          <ChevronLeft className="size-3.5" /> Prev
        </button>
        <span className="text-xs text-fg-muted">
          {total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, total)} of {total}
        </span>
        <button
          onClick={() => setOffset((o) => o + PAGE)}
          disabled={offset + PAGE >= total}
          className="btn-ghost text-xs disabled:opacity-40"
        >
          Next <ChevronRight className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
