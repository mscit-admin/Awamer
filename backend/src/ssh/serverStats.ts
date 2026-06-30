/**
 * Lightweight remote server metrics for the terminal status bar.
 *
 * A single, fast, dependency-free shell command reads a handful of /proc files
 * and `df`; the output is parsed here. CPU and network are rates, so they need
 * the previous sample (kept per connection). Everything is best-effort — any
 * field that can't be read is simply omitted (works across most Linux hosts;
 * silently degrades elsewhere).
 */

// Marker-delimited so parsing is robust regardless of locale/format.
export const STATS_CMD = [
  'echo ===H===; hostname 2>/dev/null',
  'echo ===U===; cat /proc/uptime 2>/dev/null',
  'echo ===N===; nproc 2>/dev/null',
  'echo ===L===; cat /proc/loadavg 2>/dev/null',
  'echo ===C===; head -1 /proc/stat 2>/dev/null',
  'echo ===M===; grep -E "^(MemTotal|MemAvailable):" /proc/meminfo 2>/dev/null',
  'echo ===D===; df -kP / 2>/dev/null | tail -1',
  'echo ===X===; grep -vE "lo:|Inter-|face" /proc/net/dev 2>/dev/null | head -1',
  'echo ===E===',
].join("; ");

export interface PrevSample {
  cpu?: { idle: number; total: number };
  net?: { rx: number; tx: number; t: number };
}

export interface ServerStats {
  host?: string;
  nproc?: number;
  uptime_sec?: number;      // server uptime
  load1?: number;
  cpu?: number;             // 0..100 (%)
  mem?: number;             // 0..100 (% used)
  mem_used_mb?: number;
  mem_total_mb?: number;
  disk?: number;            // 0..100 (% used, root fs)
  rx_bps?: number;          // bytes/sec received
  tx_bps?: number;          // bytes/sec sent
}

function sections(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /===([A-Z])===\n?([\s\S]*?)(?=\n===[A-Z]===|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) out[m[1]!] = m[2]!.trim();
  return out;
}

export function parseStats(raw: string, prev: PrevSample, now: number): { stats: ServerStats; prev: PrevSample } {
  const s = sections(raw);
  const stats: ServerStats = {};
  const next: PrevSample = {};

  if (s.H) stats.host = s.H.split("\n")[0]!.trim();
  if (s.U) { const u = parseFloat(s.U.split(/\s+/)[0]!); if (Number.isFinite(u)) stats.uptime_sec = Math.round(u); }
  if (s.N) { const n = parseInt(s.N, 10); if (Number.isFinite(n)) stats.nproc = n; }
  if (s.L) { const l = parseFloat(s.L.split(/\s+/)[0]!); if (Number.isFinite(l)) stats.load1 = l; }

  // CPU — delta vs previous sample.
  if (s.C) {
    const p = s.C.trim().split(/\s+/).slice(1).map(Number).filter((x) => Number.isFinite(x));
    if (p.length >= 4) {
      const total = p.reduce((a, b) => a + b, 0);
      const idle = (p[3] ?? 0) + (p[4] ?? 0); // idle + iowait
      next.cpu = { idle, total };
      if (prev.cpu) {
        const dt = total - prev.cpu.total;
        const di = idle - prev.cpu.idle;
        if (dt > 0) stats.cpu = Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100)));
      }
    }
  }

  // Memory.
  if (s.M) {
    let totalKb = 0, availKb = 0;
    for (const line of s.M.split("\n")) {
      const mm = /^(MemTotal|MemAvailable):\s+(\d+)/.exec(line.trim());
      if (mm) { if (mm[1] === "MemTotal") totalKb = Number(mm[2]); else availKb = Number(mm[2]); }
    }
    if (totalKb > 0) {
      stats.mem_total_mb = Math.round(totalKb / 1024);
      stats.mem_used_mb = Math.round((totalKb - availKb) / 1024);
      stats.mem = Math.max(0, Math.min(100, Math.round(((totalKb - availKb) / totalKb) * 100)));
    }
  }

  // Disk (root fs): "Filesystem 1024-blocks Used Available Capacity Mounted".
  if (s.D) {
    const f = s.D.trim().split(/\s+/);
    const cap = f.find((x) => /^\d+%$/.test(x));
    if (cap) stats.disk = Math.max(0, Math.min(100, parseInt(cap, 10)));
  }

  // Network — first non-loopback interface, rate vs previous sample.
  if (s.X) {
    // "eth0: rxbytes rxpk ... txbytes ..."  (fields after the colon)
    const cleaned = s.X.replace(/^[^:]*:/, " ").trim().split(/\s+/).map(Number);
    const rx = cleaned[0], tx = cleaned[8];
    if (Number.isFinite(rx) && Number.isFinite(tx)) {
      next.net = { rx: rx!, tx: tx!, t: now };
      if (prev.net) {
        const dts = (now - prev.net.t) / 1000;
        if (dts > 0) {
          stats.rx_bps = Math.max(0, Math.round((rx! - prev.net.rx) / dts));
          stats.tx_bps = Math.max(0, Math.round((tx! - prev.net.tx) / dts));
        }
      }
    }
  }

  return { stats, prev: next };
}
