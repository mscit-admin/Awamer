/**
 * One-time connection tickets for the VNC WebSocket (SEC-018).
 *
 * noVNC's RFB client speaks the raw RFB protocol from the first byte, so it
 * cannot send a JSON auth frame the way the SSH/telnet gateways do, and putting
 * the JWT in the WS URL is forbidden. Instead the client first calls an
 * Authorization-header-authenticated REST endpoint to mint a short-lived,
 * single-use, opaque ticket, then opens `…/vnc/connect?ticket=<opaque>`. The
 * ticket is not a JWT/password/secret: it is useless after one use or ~30s, and
 * carries no standing authority.
 */
import { randomBytes } from "node:crypto";

export interface TicketData {
  userId: string;
  hostId: string;
}

interface Entry extends TicketData {
  expiresAt: number;
}

export class VncTicketStore {
  private readonly map = new Map<string, Entry>();

  constructor(private readonly ttlMs = 30_000) {}

  issue(data: TicketData): string {
    this.sweep();
    const ticket = randomBytes(32).toString("hex");
    this.map.set(ticket, { ...data, expiresAt: Date.now() + this.ttlMs });
    return ticket;
  }

  /** Consume a ticket: returns its data once, then invalidates it. */
  consume(ticket: string): TicketData | null {
    const e = this.map.get(ticket);
    if (!e) return null;
    this.map.delete(ticket); // single use
    if (e.expiresAt < Date.now()) return null;
    return { userId: e.userId, hostId: e.hostId };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.map) if (v.expiresAt < now) this.map.delete(k);
  }
}
