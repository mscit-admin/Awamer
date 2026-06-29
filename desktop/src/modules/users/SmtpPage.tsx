/**
 * SMTP configuration (Administration). Configure the mail server used for the
 * forgot-password flow, and send a test email. Admin / super_admin only.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Mail, Loader2, AlertCircle, CheckCircle2, Send } from "lucide-react";
import { smtpApi, type SmtpConfig } from "./smtpApi";
import { ApiError } from "@/shared/lib/api";

export function SmtpPage() {
  const [cfg, setCfg] = useState<SmtpConfig | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number | "">(587);
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [allowInvalid, setAllowInvalid] = useState(false);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function fill(c: SmtpConfig) {
    setCfg(c);
    setHost(c.host); setPort(c.port || 587); setSecure(c.secure);
    setUser(c.user); setFrom(c.from); setBaseUrl(c.base_url); setAllowInvalid(c.allow_invalid_certs);
  }

  useEffect(() => {
    smtpApi.get().then(fill).catch((e) => setError(e instanceof Error ? e.message : "failed to load")).finally(() => setLoading(false));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setSaved(false);
    try {
      const c = await smtpApi.update({
        host: host.trim() || null,
        port: port === "" ? 587 : Number(port),
        secure,
        user: user.trim() || null,
        from: from.trim() || null,
        base_url: baseUrl.trim() || null,
        allow_invalid_certs: allowInvalid,
        // Only send the password when changed; blank keeps the stored one.
        ...(password ? { password } : {}),
      });
      fill(c);
      setPassword("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    if (!testTo) return;
    setTesting(true); setTestMsg(null);
    try {
      await smtpApi.test(testTo.trim());
      setTestMsg({ ok: true, text: `Test email sent to ${testTo}.` });
    } catch (err) {
      setTestMsg({ ok: false, text: err instanceof ApiError ? err.message : err instanceof Error ? err.message : "send failed" });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="max-w-xl mx-auto py-6 px-4 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-md bg-bg-elevated border border-border grid place-items-center"><Mail className="size-5 text-accent" /></div>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Email (SMTP)</h1>
          <p className="text-sm text-fg-muted mt-0.5">Mail server for password-reset emails.</p>
        </div>
      </div>

      {loading ? (
        <div className="card p-8 text-center text-fg-muted text-sm flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : (
        <>
          <form onSubmit={save} className="card p-5 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-xs text-fg-muted mb-1">SMTP host</label>
                <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" className="input w-full" />
              </div>
              <div>
                <label className="block text-xs text-fg-muted mb-1">Port</label>
                <input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value === "" ? "" : Number(e.target.value))} className="input w-full" />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} className="accent-accent" />
              Use TLS on connect (port 465). Leave off for STARTTLS (587).
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={allowInvalid} onChange={(e) => setAllowInvalid(e.target.checked)} className="accent-accent" />
              Allow self-signed / invalid TLS certificate
              <span className="text-2xs text-amber-300/80">(only for trusted self-hosted servers)</span>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-fg-muted mb-1">Username</label>
                <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" className="input w-full" />
              </div>
              <div>
                <label className="block text-xs text-fg-muted mb-1">Password {cfg?.has_password && <span className="text-fg-subtle">(saved — leave blank to keep)</span>}</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={cfg?.has_password ? "••••••••" : ""} autoComplete="new-password" className="input w-full" />
              </div>
            </div>

            <div>
              <label className="block text-xs text-fg-muted mb-1">From address</label>
              <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder='Awamer <no-reply@example.com>' className="input w-full" />
            </div>

            <div>
              <label className="block text-xs text-fg-muted mb-1">App base URL (for reset links)</label>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://161.97.78.116.nip.io:6655" className="input w-full" />
              <p className="text-2xs text-fg-muted mt-1">Reset links are built from this. If empty, the request's origin is used.</p>
            </div>

            {error && <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded flex items-center gap-2"><AlertCircle className="size-3.5" /> {error}</div>}
            {saved && <div className="px-3 py-2 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs rounded flex items-center gap-2"><CheckCircle2 className="size-3.5" /> Saved.</div>}

            <div className="flex justify-end">
              <button type="submit" disabled={busy} className="btn-primary">{busy ? <><Loader2 className="size-4 animate-spin" /> Saving…</> : "Save settings"}</button>
            </div>
          </form>

          <div className="card p-5 mt-4">
            <h2 className="text-sm font-semibold mb-2">Send a test email</h2>
            <div className="flex items-end gap-2 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <label className="block text-xs text-fg-muted mb-1">Recipient</label>
                <input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" className="input w-full" />
              </div>
              <button onClick={sendTest} disabled={testing || !testTo} className="btn-ghost text-sm">
                {testing ? <><Loader2 className="size-4 animate-spin" /> Sending…</> : <><Send className="size-3.5" /> Send test</>}
              </button>
            </div>
            {testMsg && (
              <div className={"mt-3 px-3 py-2 text-xs rounded flex items-center gap-2 " + (testMsg.ok ? "bg-emerald-500/10 border border-emerald-500/30 text-emerald-300" : "bg-red-500/10 border border-red-500/30 text-red-300")}>
                {testMsg.ok ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />} {testMsg.text}
              </div>
            )}
            <p className="text-2xs text-fg-muted mt-3">Save your settings before sending a test.</p>
          </div>
        </>
      )}
    </div>
  );
}
