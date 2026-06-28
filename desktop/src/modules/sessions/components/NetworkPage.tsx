/**
 * Network — diagnostic tools (ping, traceroute, DNS, TCP port check).
 * Runs server-side via the network API. Requires sessions:connect.
 */
import { useState, type FormEvent } from "react";
import { Network, Loader2, Activity, Route as RouteIcon, Globe, Plug } from "lucide-react";
import { networkApi, type NetResult } from "../api/networkApi";

type Tool = "ping" | "traceroute" | "dns" | "port";

const TOOLS: { id: Tool; label: string; icon: React.ReactNode; needsPort?: boolean }[] = [
  { id: "ping", label: "Ping", icon: <Activity className="size-4" /> },
  { id: "traceroute", label: "Traceroute", icon: <RouteIcon className="size-4" /> },
  { id: "dns", label: "DNS lookup", icon: <Globe className="size-4" /> },
  { id: "port", label: "Port check", icon: <Plug className="size-4" />, needsPort: true },
];

export function NetworkPage() {
  const [tool, setTool] = useState<Tool>("ping");
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<NetResult | null>(null);

  const active = TOOLS.find((t) => t.id === tool)!;

  async function run(e: FormEvent) {
    e.preventDefault();
    if (!host.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      let r: NetResult;
      const h = host.trim();
      if (tool === "ping") r = await networkApi.ping(h);
      else if (tool === "traceroute") r = await networkApi.traceroute(h);
      else if (tool === "dns") r = await networkApi.dns(h);
      else r = await networkApi.portCheck(h, Number(port) || 0);
      setResult(r);
    } catch (err) {
      setResult({ ok: false, output: "", error: err instanceof Error ? err.message : "request failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto py-6 px-4 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-md bg-bg-elevated border border-border grid place-items-center">
          <Network className="size-5 text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Network tools</h1>
          <p className="text-sm text-fg-muted mt-0.5">Diagnostics run from the server.</p>
        </div>
      </div>

      <div className="flex gap-1.5 mb-4">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => { setTool(t.id); setResult(null); }}
            className={
              "flex items-center gap-1.5 px-3 py-1.5 rounded text-sm border " +
              (tool === t.id ? "bg-accent/15 border-accent/40 text-accent" : "border-border text-fg-muted hover:bg-bg-elevated")
            }
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      <form onSubmit={run} className="card p-4 flex items-end gap-2 mb-4">
        <div className="flex-1">
          <label className="block text-xs text-fg-muted mb-1">Host or IP</label>
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="example.com or 10.0.0.5"
            className="input w-full"
            autoFocus
          />
        </div>
        {active.needsPort && (
          <div className="w-28">
            <label className="block text-xs text-fg-muted mb-1">Port</label>
            <input
              type="number" min={1} max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value === "" ? "" : Number(e.target.value))}
              placeholder="22"
              className="input w-full"
            />
          </div>
        )}
        <button type="submit" disabled={busy || !host.trim() || (active.needsPort && !port)} className="btn-primary">
          {busy ? <><Loader2 className="size-4 animate-spin" /> Running…</> : "Run"}
        </button>
      </form>

      {result && (
        <div className="card overflow-hidden">
          <div className={"px-4 py-2 text-xs font-medium border-b border-border " + (result.ok ? "text-emerald-300" : "text-red-300")}>
            {result.ok ? "Success" : (result.error ?? "Failed")}
          </div>
          {(result.output || result.error) && (
            <pre className="p-4 text-xs font-mono whitespace-pre-wrap overflow-x-auto bg-[#0b0e14] max-h-[50vh] overflow-y-auto">
              {result.output || result.error}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
