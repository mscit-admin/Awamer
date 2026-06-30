/**
 * Network — diagnostic tools (ping, traceroute, DNS, TCP port check).
 * Runs server-side via the network API. Requires sessions:connect.
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Network, Loader2, Activity, Route as RouteIcon, Globe, Plug, Radar, Server, Plus } from "lucide-react";
import { networkApi, type NetResult, type ScanResult, type ScanDevice } from "../api/networkApi";

type Tool = "ping" | "traceroute" | "dns" | "port" | "discover";

const TOOLS: { id: Tool; label: string; icon: React.ReactNode; needsPort?: boolean }[] = [
  { id: "discover", label: "Discover", icon: <Radar className="size-4" /> },
  { id: "ping", label: "Ping", icon: <Activity className="size-4" /> },
  { id: "traceroute", label: "Traceroute", icon: <RouteIcon className="size-4" /> },
  { id: "dns", label: "DNS lookup", icon: <Globe className="size-4" /> },
  { id: "port", label: "Port check", icon: <Plug className="size-4" />, needsPort: true },
];

export function NetworkPage() {
  const [tool, setTool] = useState<Tool>("discover");
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
    <div className="max-w-4xl mx-auto py-6 px-4 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-md bg-bg-elevated border border-border grid place-items-center">
          <Network className="size-5 text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Network tools</h1>
          <p className="text-sm text-fg-muted mt-0.5">Diagnostics run from the server.</p>
        </div>
      </div>

      <div className="flex gap-1.5 mb-4 flex-wrap">
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

      {tool === "discover" && <DiscoverPanel />}

      {tool !== "discover" && (
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
      )}

      {tool !== "discover" && result && (
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

// --- Local network device discovery ---------------------------------

const PROTO_FOR_PORT: Record<number, string> = { 22: "ssh", 5900: "vnc", 3389: "rdp", 80: "http", 443: "https" };

function DiscoverPanel() {
  const navigate = useNavigate();
  const [cidr, setCidr] = useState("192.168.1.0/24");
  const [scanning, setScanning] = useState(false);
  const [res, setRes] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function scan(e: FormEvent) {
    e.preventDefault();
    setScanning(true);
    setError(null);
    setRes(null);
    try {
      setRes(await networkApi.scan(cidr.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "scan failed");
    } finally {
      setScanning(false);
    }
  }

  function addAsAsset(d: ScanDevice) {
    // Suggest a protocol/port from the open ports.
    let protocol = "ssh";
    let port = 22;
    for (const p of d.open) {
      if (PROTO_FOR_PORT[p]) { protocol = PROTO_FOR_PORT[p]; port = p; break; }
    }
    navigate("/hosts/new", {
      state: { prefill: { name: d.hostname || d.ip, hostname: d.ip, protocol, port } },
    });
  }

  return (
    <div>
      <form onSubmit={scan} className="card p-4 flex items-end gap-2 mb-4 flex-wrap">
        <div className="flex-1 min-w-[180px]">
          <label className="block text-xs text-fg-muted mb-1">Network range (CIDR)</label>
          <input value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="192.168.1.0/24" className="input w-full font-mono" />
        </div>
        <button type="submit" disabled={scanning} className="btn-primary">
          {scanning ? <><Loader2 className="size-4 animate-spin" /> Scanning…</> : <><Radar className="size-4" /> Scan</>}
        </button>
      </form>

      <p className="text-2xs text-fg-muted mb-3">
        Scans from the server. Use a /24 or smaller (max 256 addresses). A device shows up if it
        answers on a common port (SSH, HTTP/S, SMB, RDP, VNC, 8080).
      </p>

      {error && (
        <div className="mb-4 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded">{error}</div>
      )}

      {res && (
        <div className="card overflow-x-auto">
          <div className="px-4 py-2 text-xs text-fg-muted border-b border-border">
            Found <span className="text-fg font-medium">{res.found}</span> of {res.scanned} scanned
          </div>
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase text-fg-muted border-b border-border">
              <tr>
                <th className="text-left font-medium px-4 py-2">IP</th>
                <th className="text-left font-medium px-4 py-2">Hostname</th>
                <th className="text-left font-medium px-4 py-2">Open ports</th>
                <th className="px-4 py-2 w-28"></th>
              </tr>
            </thead>
            <tbody>
              {res.devices.map((d) => (
                <tr key={d.ip} className="border-b border-border/50 hover:bg-bg-elevated/40">
                  <td className="px-4 py-2 font-mono flex items-center gap-2"><Server className="size-3.5 text-accent" />{d.ip}</td>
                  <td className="px-4 py-2 text-fg-muted truncate">{d.hostname ?? "—"}</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      {d.open.length === 0 && <span className="text-fg-subtle text-xs">—</span>}
                      {d.open.map((p) => (
                        <span key={p} className="text-2xs px-1.5 py-0.5 rounded bg-bg-elevated border border-border font-mono">{p}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => addAsAsset(d)} className="btn-ghost text-xs"><Plus className="size-3.5" /> Add</button>
                  </td>
                </tr>
              ))}
              {res.devices.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-fg-muted text-sm">No devices responded.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
