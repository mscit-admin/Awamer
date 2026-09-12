/**
 * SEC-INFRA-001 — backend-side client for the privileged `awamer-vpn-helper`.
 *
 * The backend has NO NET_ADMIN, NO /dev/net/tun and never spawns OpenVPN. All
 * privileged VPN lifecycle work goes through this authenticated Unix-socket
 * client. If the helper is unreachable, operations FAIL CLOSED — there is
 * deliberately no local-OpenVPN fallback (that would defeat the isolation).
 */
import net from "node:net";
import { randomUUID } from "node:crypto";
import {
  signRequest, verifyResponse, PROTOCOL_VERSION, type HelperOp,
} from "./helperProtocol.js";

export class VpnHelperUnavailable extends Error {
  readonly code = "vpn_helper_unavailable";
  constructor(message = "the VPN helper is unavailable") { super(message); this.name = "VpnHelperUnavailable"; }
}
export class VpnHelperError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "VpnHelperError"; }
}

export interface VpnHelperClientOptions {
  socketPath: string;
  secret: string;
  timeoutMs?: number;
}

export class VpnHelperClient {
  private readonly socketPath: string;
  private readonly secret: string;
  private readonly timeoutMs: number;

  constructor(opts: VpnHelperClientOptions) {
    this.socketPath = opts.socketPath;
    this.secret = opts.secret;
    this.timeoutMs = opts.timeoutMs ?? 35_000;
  }

  /** True if the helper answers a signed health check. Never throws. */
  async isHealthy(): Promise<boolean> {
    try {
      const r = await this.request("health", {});
      return r.ready === true;
    } catch {
      return false;
    }
  }

  /**
   * Send one authenticated request and return the helper's result. Throws
   * VpnHelperUnavailable if the socket cannot be reached (fail-closed), or
   * VpnHelperError with the helper's code if the operation itself failed.
   */
  request(op: HelperOp, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = randomUUID();
    const req = signRequest(this.secret, { v: PROTOCOL_VERSION, op, id, ts: Date.now(), payload });
    const line = JSON.stringify(req) + "\n";

    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      let buf = "";
      let settled = false;
      const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch { /* ignore */ } fn(); };
      const timer = setTimeout(() => done(() => reject(new VpnHelperUnavailable("VPN helper request timed out"))), this.timeoutMs);

      sock.on("connect", () => { try { sock.write(line); } catch (e) { done(() => reject(new VpnHelperUnavailable(String(e)))); } });
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const respLine = buf.slice(0, nl);
        done(() => {
          try {
            const res = verifyResponse(this.secret, JSON.parse(respLine), id);
            if (res.ok) return resolve(res.result ?? {});
            reject(new VpnHelperError(res.error?.code ?? "helper_error", res.error?.message ?? "helper error"));
          } catch (e) {
            reject(new VpnHelperUnavailable(`invalid helper response: ${e instanceof Error ? e.message : String(e)}`));
          }
        });
      });
      // A missing socket / refused connection / reset is FAIL-CLOSED.
      sock.on("error", (e) => done(() => reject(new VpnHelperUnavailable(e.message))));
      sock.on("close", () => done(() => reject(new VpnHelperUnavailable("VPN helper closed the connection"))));
    });
  }
}
