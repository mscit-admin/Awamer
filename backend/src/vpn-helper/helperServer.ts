/**
 * SEC-INFRA-001 — the Unix-socket server for `awamer-vpn-helper`.
 *
 * Speaks the newline-delimited, HMAC-authenticated protocol in
 * `vpn/helperProtocol.ts`. Each request is authenticated + freshness-checked +
 * replay-checked before it reaches the (structured, allow-listed) dispatcher.
 * There is deliberately NO generic command/exec/argument operation.
 */
import net from "node:net";
import { chmod } from "node:fs/promises";
import type { HelperCore } from "./helperCore.js";
import {
  verifyRequest, signResponse, NonceCache, HelperAuthError,
  type HelperRequest, type HelperResponse, isValidRef,
} from "../vpn/helperProtocol.js";

const MAX_LINE_BYTES = 2 * 1024 * 1024; // oversized-payload guard

type Log = (obj: Record<string, unknown>, msg: string) => void;

/** Dispatch a verified request to the core. Pure of transport; unit-testable. */
export async function dispatch(core: HelperCore, req: HelperRequest): Promise<Record<string, unknown>> {
  const p = req.payload;
  const ref = (key: string): string => {
    const v = p[key];
    if (!isValidRef(v)) { const e = new Error("invalid reference") as Error & { code: string }; e.code = "bad_ref"; throw e; }
    return v;
  };
  const str = (key: string, required = true): string | undefined => {
    const v = p[key];
    if (v === undefined || v === null) { if (required) { const e = new Error(`missing ${key}`) as Error & { code: string }; e.code = "bad_request"; throw e; } return undefined; }
    if (typeof v !== "string") { const e = new Error(`bad ${key}`) as Error & { code: string }; e.code = "bad_request"; throw e; }
    return v;
  };
  switch (req.op) {
    case "health":
      return await core.health();
    case "client_connect":
      return await core.clientConnect({
        sessionRef: ref("sessionRef"), config: str("config")!,
        authUser: str("authUser", false), authPass: str("authPass", false),
      });
    case "client_stop":
      return { stopped: core.clientStop(ref("sessionRef")) };
    case "client_status":
      return core.clientStatus(ref("sessionRef"));
    case "server_start": {
      const num = (key: string): number => { const v = p[key]; if (typeof v !== "number" || !Number.isFinite(v)) { const e = new Error(`bad ${key}`) as Error & { code: string }; e.code = "bad_request"; throw e; } return v; };
      const proto = str("proto")!;
      if (proto !== "udp" && proto !== "tcp") { const e = new Error("bad proto") as Error & { code: string }; e.code = "bad_request"; throw e; }
      return await core.serverStart({
        serverId: ref("serverId"), port: num("port"), proto,
        subnet: str("subnet")!, dns: (str("dns", false) ?? null),
        clientToClient: p.clientToClient === true, cipher: str("cipher")!,
        caCert: str("caCert")!, serverCert: str("serverCert")!, serverKey: str("serverKey")!, tlsCrypt: str("tlsCrypt")!,
      });
    }
    case "server_stop":
      return { stopped: core.serverStop(ref("serverId")) };
    case "server_status":
      return core.serverStatus(ref("serverId"));
    case "firewall_allow":
    case "firewall_remove": {
      const num = (key: string): number => { const v = p[key]; if (typeof v !== "number" || !Number.isFinite(v)) { const e = new Error(`bad ${key}`) as Error & { code: string }; e.code = "bad_request"; throw e; } return v; };
      const proto = str("proto")!;
      const serverId = ref("serverId");
      const port = num("port");
      const r = req.op === "firewall_allow"
        ? await core.firewallAllow(serverId, port, proto)
        : await core.firewallRemove(serverId, port, proto);
      return { ...r };
    }
    default: {
      const e = new Error("unknown operation") as Error & { code: string }; e.code = "unknown_op"; throw e;
    }
  }
}

export interface HelperServerOptions {
  core: HelperCore;
  secret: string;
  socketPath: string;
  log?: Log;
  nonceCache?: NonceCache;
  skewMs?: number;
}

/** Create (but do not listen on) the helper's Unix-socket server. */
export function createHelperServer(opts: HelperServerOptions): net.Server {
  const log = opts.log ?? (() => {});
  const nonce = opts.nonceCache ?? new NonceCache();

  const server = net.createServer((sock) => {
    let buf = "";
    let closed = false;
    const closeBad = (reason: string) => { if (closed) return; closed = true; log({ reason }, "helper: closing connection"); sock.destroy(); };

    const replyErr = (id: string, code: string, message: string) => {
      const res = signResponse(opts.secret, { ok: false, error: { code, message }, id, ts: Date.now() });
      try { sock.write(JSON.stringify(res) + "\n"); } catch { /* ignore */ }
    };
    const replyOk = (id: string, result: Record<string, unknown>) => {
      const res: HelperResponse = signResponse(opts.secret, { ok: true, result, id, ts: Date.now() });
      try { sock.write(JSON.stringify(res) + "\n"); } catch { /* ignore */ }
    };

    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE_BYTES) return closeBad("oversized");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        void handleLine(line);
      }
    });
    sock.on("error", () => closeBad("socket_error"));

    async function handleLine(line: string): Promise<void> {
      if (line.trim() === "") return;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { return closeBad("bad_json"); }
      let req: HelperRequest;
      try {
        req = verifyRequest(opts.secret, parsed, { skewMs: opts.skewMs });
      } catch (e) {
        // Do not reveal which check failed beyond a generic code; log the reason.
        const reason = e instanceof HelperAuthError ? e.reason : "auth_failed";
        log({ reason }, "helper: request authentication failed");
        const id = typeof (parsed as { id?: unknown })?.id === "string" ? (parsed as { id: string }).id : "";
        return replyErr(id, "unauthenticated", "request authentication failed");
      }
      // Replay protection (nonce). Authenticated but replayed → reject.
      if (!nonce.check(req.id)) {
        log({ op: req.op }, "helper: replayed request rejected");
        return replyErr(req.id, "replayed", "request already processed");
      }
      try {
        const result = await dispatch(opts.core, req);
        replyOk(req.id, result);
      } catch (e) {
        const code = (e as { code?: string })?.code ?? "helper_error";
        const message = e instanceof Error ? e.message : "helper error";
        log({ op: req.op, code }, "helper: operation failed");
        replyErr(req.id, code, message);
      }
    }
  });
  return server;
}

/** Listen on the Unix socket and lock down its permissions (0600). */
export async function listenHelper(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  // The containing directory should already be 0700 (created by bootstrap); make
  // the socket itself owner-only so only processes sharing the uid can connect.
  await chmod(socketPath, 0o600).catch(() => {});
}
