/**
 * In-terminal AI assistant. Uses the server AI proxy with a provider the user
 * may use (org or personal). Turns natural language into a shell command,
 * explains commands, and analyzes errors. Commands are inserted into the
 * terminal (never auto-run) so the user reviews before pressing Enter.
 */
import { useEffect, useMemo, useState } from "react";
import { Bot, Loader2, X, CornerDownLeft, Wand2, HelpCircle, Bug, AlertTriangle } from "lucide-react";
import { aiApi, type AiProvider } from "./aiApi";
import { ApiError } from "@/shared/lib/api";

type Mode = "suggest" | "explain" | "error";

/** Extract the first fenced code block (or the first non-empty line) as a command. */
function firstCommand(text: string): string | null {
  const fence = /```(?:[a-zA-Z]*)\n([\s\S]*?)```/.exec(text);
  if (fence) return fence[1]!.trim().split("\n")[0]!.trim() || null;
  const line = text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  return line ?? null;
}

export function AiAssistPanel({ hostLabel, onInsert, onClose }: { hostLabel: string; onInsert: (cmd: string) => void; onClose: () => void }) {
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [providerId, setProviderId] = useState<string>("");
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("suggest");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingProviders, setLoadingProviders] = useState(true);

  useEffect(() => {
    aiApi.available()
      .then((ps) => { setProviders(ps); setProviderId((ps.find((p) => p.is_default) ?? ps[0])?.id ?? ""); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "failed to load AI providers"))
      .finally(() => setLoadingProviders(false));
  }, []);

  const danger = useMemo(() => result != null && /⚠\s*DANGER/i.test(result), [result]);
  const suggested = useMemo(() => (result ? firstCommand(result) : null), [result]);

  async function run(m: Mode) {
    if (!providerId || !input.trim()) return;
    setMode(m); setBusy(true); setError(null); setResult(null);
    try {
      setResult(await aiApi.chat({ provider_id: providerId, mode: m, input: input.trim() }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "AI request failed");
    } finally { setBusy(false); }
  }

  return (
    <div className="absolute inset-y-0 right-0 z-40 w-full max-w-md bg-bg border-l border-border shadow-2xl flex flex-col animate-slide-in-right">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Bot className="size-4 text-accent" />
        <div className="text-sm font-semibold flex-1">AI assistant <span className="text-fg-muted font-normal">· {hostLabel}</span></div>
        <button onClick={onClose} className="p-1 hover:bg-bg-elevated rounded text-fg-muted"><X className="size-4" /></button>
      </div>

      <div className="p-4 space-y-3 overflow-y-auto flex-1">
        {loadingProviders ? (
          <div className="text-sm text-fg-muted flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading providers…</div>
        ) : providers.length === 0 ? (
          <div className="text-sm text-fg-muted">
            No AI provider is available to you. Add one under <span className="font-medium">AI Providers</span>, or ask an admin to configure an organization provider.
          </div>
        ) : (
          <>
            <div>
              <label className="block text-2xs text-fg-muted mb-1 uppercase tracking-wide">Provider</label>
              <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className="input w-full text-sm">
                {providers.map((p) => <option key={p.id} value={p.id}>{p.label} · {p.model}{p.scope === "org" ? " (org)" : ""}</option>)}
              </select>
            </div>

            <textarea
              value={input} onChange={(e) => setInput(e.target.value)} rows={4}
              placeholder={mode === "error" ? "Paste an error message…" : "Describe what you want to do, or paste a command to explain…"}
              className="input w-full text-sm font-mono resize-y"
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run(mode); } }}
            />
            <div className="flex flex-wrap gap-2">
              <button onClick={() => void run("suggest")} disabled={busy || !input.trim()} className="btn-primary text-xs inline-flex gap-1"><Wand2 className="size-3.5" /> Suggest command</button>
              <button onClick={() => void run("explain")} disabled={busy || !input.trim()} className="btn-ghost text-xs inline-flex gap-1"><HelpCircle className="size-3.5" /> Explain</button>
              <button onClick={() => void run("error")} disabled={busy || !input.trim()} className="btn-ghost text-xs inline-flex gap-1"><Bug className="size-3.5" /> Analyze error</button>
            </div>

            {busy && <div className="text-sm text-fg-muted flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Thinking…</div>}
            {error && <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded">{error}</div>}

            {result && (
              <div className="space-y-2">
                {danger && (
                  <div className="px-3 py-2 bg-amber-500/10 border border-amber-500/40 text-amber-300 text-xs rounded flex items-center gap-2">
                    <AlertTriangle className="size-3.5 shrink-0" /> This suggestion looks destructive — review carefully before running.
                  </div>
                )}
                <pre className="text-xs whitespace-pre-wrap bg-bg-elevated border border-border rounded p-3 leading-relaxed">{result}</pre>
                {suggested && (
                  <button onClick={() => onInsert(suggested)} className="btn-primary text-xs inline-flex gap-1 w-full justify-center">
                    <CornerDownLeft className="size-3.5" /> Insert into terminal (won't run)
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <div className="px-4 py-2 border-t border-border text-2xs text-fg-muted">Commands are inserted, not executed — press Enter yourself. Ctrl/Cmd+Enter to ask.</div>
    </div>
  );
}
