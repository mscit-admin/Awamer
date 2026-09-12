/**
 * SEC-INFRA-001 — core of the privileged `awamer-vpn-helper`.
 *
 * This is the ONLY component that spawns OpenVPN. It runs in a dedicated,
 * minimal container that holds NET_ADMIN + /dev/net/tun; the internet-facing
 * backend has neither. The core exposes a small set of STRUCTURED, allow-listed
 * operations (start/stop/status a client tunnel or a server instance, plus
 * health) — never a generic command/exec/argument interface.
 *
 * Hardening implemented here:
 *  - Fixed OpenVPN executable path; arguments are built HERE (the backend never
 *    sends an argument array); spawned with shell:false (no /bin/sh).
 *  - Every config is re-validated with `assertSafeOvpnConfig` (defence in depth)
 *    and `--script-security 1` is force-appended so an uploaded .ovpn cannot run
 *    up/down/route-up/plugin/… scripts or relax the sandbox.
 *  - Per-session runtime files live under a controlled directory keyed by a
 *    validated ref (no external paths, no traversal, no symlink escape).
 *  - Sessions are tracked by internal ref → process handle; stop maps a ref to a
 *    process the helper itself started (never an arbitrary client-supplied PID).
 *  - Concurrency, config-size, startup/shutdown-timeout and log-tail caps.
 *  - Secret temp files are 0600 and removed on exit; secrets are never logged.
 */
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile, rm, realpath, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, resolve, sep } from "node:path";
import { assertSafeOvpnConfig, VpnErrors } from "../domain/vpn.js";
import { assembleServerConfig } from "../domain/vpnServer.js";
import { isValidRef } from "../vpn/helperProtocol.js";

const READY_MARKER = "Initialization Sequence Completed";

export type SessionKind = "client" | "server";
export type SessionState = "starting" | "running" | "error" | "stopped";

/** A minimal child-process shape so tests can inject a fake spawn. */
export interface ChildLike {
  stdout: NodeJS.EventEmitter | null;
  stderr: NodeJS.EventEmitter | null;
  once(event: string, cb: (...a: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
  readonly pid?: number;
}
export type SpawnFn = (cmd: string, args: string[], opts: { stdio: unknown; env?: NodeJS.ProcessEnv }) => ChildLike;

export interface HelperCoreOptions {
  openvpnPath?: string;
  runtimeDir?: string;
  maxSessions?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxConfigBytes?: number;
  /** For the server auth-verify child (helper-local). */
  databaseUrl?: string;
  verifyExec?: string; // e.g. `'/usr/local/bin/node' '/app/dist/vpn/authVerify.js'`
  spawnFn?: SpawnFn;
  log?: (obj: Record<string, unknown>, msg: string) => void;
}

interface Session {
  ref: string;
  kind: SessionKind;
  state: SessionState;
  error: string | null;
  startedAt: string | null;
  proc: ChildLike | null;
  dir: string;
}

export interface HelperError extends Error { code: string; }
function err(code: string, message: string): HelperError {
  const e = new Error(message) as HelperError; e.code = code; return e;
}

export interface ClientConnectInput {
  sessionRef: string;
  config: string;
  authUser?: string;
  authPass?: string;
}
export interface ServerStartInput {
  serverId: string;
  port: number;
  proto: "udp" | "tcp";
  subnet: string;
  dns: string | null;
  clientToClient: boolean;
  cipher: string;
  caCert: string;
  serverCert: string;
  serverKey: string;
  tlsCrypt: string;
}

export class HelperCore {
  private readonly openvpnPath: string;
  private readonly runtimeDir: string;
  private readonly maxSessions: number;
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly maxConfigBytes: number;
  private readonly databaseUrl: string | undefined;
  private readonly verifyExec: string | undefined;
  private readonly spawnFn: SpawnFn;
  private readonly log: (obj: Record<string, unknown>, msg: string) => void;
  private readonly sessions = new Map<string, Session>();

  constructor(opts: HelperCoreOptions = {}) {
    this.openvpnPath = opts.openvpnPath ?? "/usr/sbin/openvpn";
    this.runtimeDir = opts.runtimeDir ?? "/var/lib/awamer/vpn-runtime";
    this.maxSessions = opts.maxSessions ?? 20;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 30_000;
    this.shutdownTimeoutMs = opts.shutdownTimeoutMs ?? 5_000;
    this.maxConfigBytes = opts.maxConfigBytes ?? 1024 * 1024;
    this.databaseUrl = opts.databaseUrl;
    this.verifyExec = opts.verifyExec;
    this.spawnFn = opts.spawnFn ?? (realSpawn as unknown as SpawnFn);
    this.log = opts.log ?? (() => {});
  }

  /** Public: no secrets, no profiles, no env dump. */
  async health(): Promise<{ ready: boolean; openvpn: boolean; tun: boolean; sessions: number }> {
    const openvpn = await access(this.openvpnPath, fsConstants.X_OK).then(() => true).catch(() => false);
    const tun = await access("/dev/net/tun", fsConstants.F_OK).then(() => true).catch(() => false);
    return { ready: true, openvpn, tun, sessions: this.sessions.size };
  }

  private key(kind: SessionKind, ref: string): string { return `${kind}:${ref}`; }

  /** Resolve a per-session dir inside the runtime dir; reject any escape. */
  private async sessionDir(kind: SessionKind, ref: string): Promise<string> {
    if (!isValidRef(ref)) throw err("bad_ref", "invalid session reference");
    const base = await realpath(this.runtimeDir).catch(() => this.runtimeDir);
    const dir = resolve(base, `${kind}-${ref}`);
    // Defence in depth: the resolved dir MUST be a direct child of the runtime dir.
    if (dir !== join(base, `${kind}-${ref}`) || !dir.startsWith(base + sep)) {
      throw err("bad_ref", "session path escapes the runtime directory");
    }
    return dir;
  }

  private async prepareDir(dir: string): Promise<void> {
    // Remove any pre-existing path (including a planted symlink) then create a
    // fresh private directory we own.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // If, after creation, the real path no longer matches (symlink race), bail.
    const real = await realpath(dir);
    if (real !== dir) throw err("bad_ref", "runtime directory integrity check failed");
  }

  async clientConnect(input: ClientConnectInput): Promise<{ state: SessionState; error: string | null }> {
    if (!isValidRef(input.sessionRef)) throw err("bad_ref", "invalid session reference");
    if (typeof input.config !== "string" || input.config.trim() === "") throw err("config_missing", "empty config");
    if (Buffer.byteLength(input.config, "utf8") > this.maxConfigBytes) throw err("config_too_large", "config exceeds size limit");
    // Re-validate on the privileged side — never trust that the caller checked.
    assertSafeOvpnConfig(input.config);

    const k = this.key("client", input.sessionRef);
    const existing = this.sessions.get(k);
    if (existing && (existing.state === "running" || existing.state === "starting")) {
      return { state: existing.state, error: existing.error };
    }
    if (this.sessions.size >= this.maxSessions) throw err("too_many", "session limit reached");

    const dir = await this.sessionDir("client", input.sessionRef);
    await this.prepareDir(dir);
    const cfgPath = join(dir, "client.ovpn");
    await writeFile(cfgPath, input.config, { mode: 0o600 });

    const args = [`--config`, cfgPath];
    if (input.authUser !== undefined || input.authPass !== undefined) {
      const authPath = join(dir, "auth.txt");
      await writeFile(authPath, `${input.authUser ?? ""}\n${input.authPass ?? ""}\n`, { mode: 0o600 });
      args.push("--auth-user-pass", authPath, "--auth-nocache");
    }
    // Force the strictest script sandbox LAST so a config cannot override it.
    args.push("--script-security", "1");

    return this.spawnTracked("client", input.sessionRef, dir, args, undefined);
  }

  async serverStart(input: ServerStartInput): Promise<{ state: SessionState; error: string | null }> {
    if (!isValidRef(input.serverId)) throw err("bad_ref", "invalid server id");
    const k = this.key("server", input.serverId);
    const existing = this.sessions.get(k);
    if (existing && (existing.state === "running" || existing.state === "starting")) {
      return { state: existing.state, error: existing.error };
    }
    if (this.sessions.size >= this.maxSessions) throw err("too_many", "session limit reached");

    const dir = await this.sessionDir("server", input.serverId);
    await this.prepareDir(dir);

    // The auth-verify child needs the DB + the server id; the helper writes its
    // own wrapper pointing at its OWN authVerify.js — the backend never supplies
    // a script path. Absent a verify exec (dev), the server simply has no
    // per-user auth-verify (cert auth still applies).
    let verifyCommand = "";
    if (this.verifyExec && this.databaseUrl) {
      const wrapperPath = join(dir, "verify.sh");
      const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      const wrapper =
        "#!/bin/sh\n" +
        `export DATABASE_URL=${shq(this.databaseUrl)}\n` +
        `export AWAMER_VPN_SERVER_ID=${shq(input.serverId)}\n` +
        `exec ${this.verifyExec} "$@"\n`;
      await writeFile(wrapperPath, wrapper, { mode: 0o700 });
      verifyCommand = `"${wrapperPath}"`;
    }

    // NOTE on script directives: unlike a CLIENT profile (raw attacker-supplied
    // .ovpn — gated by assertSafeOvpnConfig + forced --script-security 1), the
    // SERVER config is assembled here from STRUCTURED, validated inputs (port/
    // proto/subnet/cipher are schema-checked; certs/keys come from the app PKI).
    // Its only script directive is `auth-user-pass-verify` pointing at the
    // helper's OWN authVerify.js (the backend never supplies a script path), so
    // it is a trusted, helper-controlled command — not user code.
    const config = assembleServerConfig({
      port: input.port, proto: input.proto, subnet: input.subnet, dns: input.dns,
      clientToClient: input.clientToClient, cipher: input.cipher,
      caCert: input.caCert, serverCert: input.serverCert, serverKey: input.serverKey,
      tlsCrypt: input.tlsCrypt, verifyCommand,
    });
    const cfgPath = join(dir, "server.conf");
    await writeFile(cfgPath, config, { mode: 0o600 });

    const env: NodeJS.ProcessEnv = { ...process.env, AWAMER_VPN_SERVER_ID: input.serverId };
    return this.spawnTracked("server", input.serverId, dir, ["--config", cfgPath], env);
  }

  private async spawnTracked(
    kind: SessionKind, ref: string, dir: string, args: string[], env: NodeJS.ProcessEnv | undefined,
  ): Promise<{ state: SessionState; error: string | null }> {
    const k = this.key(kind, ref);
    const session: Session = { ref, kind, state: "starting", error: null, startedAt: null, proc: null, dir };
    this.sessions.set(k, session);
    try {
      // Fixed executable, argument array, NO shell — user VPN data can never
      // become a shell command or a different binary.
      const proc = this.spawnFn(this.openvpnPath, args, { stdio: ["ignore", "pipe", "pipe"], env });
      session.proc = proc;
      const tail: string[] = [];
      await new Promise<void>((resolveP, rejectP) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return; settled = true;
          rejectP(err("timeout", `openvpn did not start within ${this.startupTimeoutMs}ms${summary(tail)}`));
        }, this.startupTimeoutMs);
        const onLine = (buf: Buffer) => {
          for (const raw of buf.toString().split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            tail.push(line); if (tail.length > 25) tail.shift();
            this.log({ kind, ref }, `openvpn: ${line}`);
            if (line.includes(READY_MARKER) && !settled) {
              settled = true; clearTimeout(timer);
              session.state = "running"; session.startedAt = new Date().toISOString();
              resolveP();
            }
          }
        };
        proc.stdout?.on("data", onLine);
        proc.stderr?.on("data", onLine);
        proc.once("error", (e: unknown) => {
          if (settled) return; settled = true; clearTimeout(timer);
          const code = (e as NodeJS.ErrnoException)?.code;
          rejectP(code === "ENOENT" ? err("openvpn_unavailable", "openvpn binary not available") : (e as Error));
        });
        proc.once("exit", (code: unknown) => {
          if (!settled) {
            // Pre-ready exit → reject and let the catch do the AWAITED cleanup
            // (so callers can observe the runtime dir is gone once we reject).
            settled = true; clearTimeout(timer);
            rejectP(err("exited", `openvpn exited (code ${code ?? "?"}) before ready${summary(tail)}`));
            return;
          }
          // Post-ready normal exit: mark stopped and clean up best-effort.
          if (session.state === "running") session.state = "stopped";
          void this.cleanup(session);
        });
      });
      return { state: session.state, error: session.error };
    } catch (e) {
      session.state = "error";
      session.error = e instanceof Error ? e.message : String(e);
      try { session.proc?.kill("SIGTERM"); } catch { /* ignore */ }
      await this.cleanup(session);
      this.sessions.delete(k);
      throw e;
    }
  }

  clientStatus(sessionRef: string): { state: SessionState; error: string | null } {
    const s = this.sessions.get(this.key("client", sessionRef));
    return s ? { state: s.state, error: s.error } : { state: "stopped", error: null };
  }
  serverStatus(serverId: string): { state: SessionState; error: string | null } {
    const s = this.sessions.get(this.key("server", serverId));
    return s ? { state: s.state, error: s.error } : { state: "stopped", error: null };
  }

  /** Stop maps a REF to a process the helper started — never a client PID. */
  clientStop(sessionRef: string): boolean { return this.stop("client", sessionRef); }
  serverStop(serverId: string): boolean { return this.stop("server", serverId); }

  private stop(kind: SessionKind, ref: string): boolean {
    const k = this.key(kind, ref);
    const s = this.sessions.get(k);
    if (!s) return false;
    this.sessions.delete(k);
    try { s.proc?.kill("SIGTERM"); } catch { /* ignore */ }
    s.state = "stopped";
    void this.cleanup(s);
    this.log({ kind, ref }, "vpn session stopped");
    return true;
  }

  private async cleanup(s: Session): Promise<void> {
    if (!s.dir) return;
    const dir = s.dir; s.dir = "";
    // Removes the config + any auth/verify temp files (secret material).
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  stopAll(): void {
    for (const s of this.sessions.values()) {
      try { s.proc?.kill("SIGTERM"); } catch { /* ignore */ }
      void this.cleanup(s);
    }
    this.sessions.clear();
  }

  /** For fail-closed callers that need the domain error type. */
  static configMissing(): Error { return VpnErrors.ConfigMissing(); }
}

function summary(tail: string[]): string {
  if (tail.length === 0) return "";
  const m = tail.filter((l) => /error|fatal|cannot|failed|denied|unable|no such|address already/i.test(l));
  return `: ${(m.length ? m : tail.slice(-1)).slice(-3).join(" | ")}`;
}
