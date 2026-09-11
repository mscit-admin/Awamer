/**
 * SSH host-key pinning (TOFU + change detection) shared by every ssh2 connect
 * site (interactive SSH, SFTP, WS tunnel, tunnel manager).
 *
 * Previously each gateway used `hostVerifier: () => true`, accepting any key on
 * every connection and never noticing a change — a MITM presenting a different
 * key was trusted silently. Here we pin the first key seen per (hostname, port)
 * and, on later connections, trust only a matching fingerprint; a mismatch is
 * refused. Re-pinning after a legitimate key rotation = delete the stored row.
 */
import { createHash } from "node:crypto";
import type { Pool } from "../db/index.js";
import type { Logger } from "../logger/index.js";

export type HostKeyVerdict = "new" | "match" | "mismatch";

/** OpenSSH-style SHA256 fingerprint of a raw server key blob. */
export function fingerprint(key: Buffer): string {
  return "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

export interface HostKeyStore {
  verify(hostname: string, port: number, fp: string, keyType?: string | null): Promise<HostKeyVerdict>;
}

export class HostKeyRepository implements HostKeyStore {
  constructor(private readonly pool: Pool) {}

  async verify(hostname: string, port: number, fp: string, keyType: string | null = null): Promise<HostKeyVerdict> {
    const existing = await this.pool.query<{ key_hash: string }>(
      `SELECT key_hash FROM host_keys WHERE hostname = $1 AND port = $2`,
      [hostname, port],
    );
    const row = existing.rows[0];
    if (!row) {
      // First sighting → pin it (TOFU). ON CONFLICT guards a concurrent race:
      // if another connection pinned it first, fall through to a comparison.
      const ins = await this.pool.query(
        `INSERT INTO host_keys (hostname, port, key_hash, key_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (hostname, port) DO NOTHING
         RETURNING id`,
        [hostname, port, fp, keyType],
      );
      if ((ins.rowCount ?? 0) > 0) return "new";
      // Lost the race — re-read and compare.
      const again = await this.pool.query<{ key_hash: string }>(
        `SELECT key_hash FROM host_keys WHERE hostname = $1 AND port = $2`,
        [hostname, port],
      );
      return again.rows[0]?.key_hash === fp ? "match" : "mismatch";
    }
    if (row.key_hash === fp) {
      await this.pool.query(
        `UPDATE host_keys SET last_seen = NOW() WHERE hostname = $1 AND port = $2`,
        [hostname, port],
      );
      return "match";
    }
    return "mismatch";
  }
}

/**
 * Build an ssh2 `hostVerifier` (async callback form) backed by the pin store.
 * Trusts a matching or newly-pinned key; refuses a changed key. On a store
 * error it fails OPEN with a warning — a pinning-DB outage must not take down
 * all remote access, and a definite mismatch (the actual attack signal) is
 * still caught whenever the store is reachable.
 */
export function makeHostVerifier(
  store: HostKeyStore,
  log: Logger,
  hostname: string,
  port: number,
): (key: Buffer, cb: (ok: boolean) => void) => void {
  return (key, cb) => {
    const fp = fingerprint(key);
    store.verify(hostname, port, fp)
      .then((verdict) => {
        if (verdict === "mismatch") {
          log.warn({ hostname, port, fingerprint: fp }, "SECURITY: SSH host key changed — refusing connection (possible MITM or unexpected key rotation; delete the host_keys row to re-pin)");
          cb(false);
          return;
        }
        if (verdict === "new") {
          log.info({ hostname, port, fingerprint: fp }, "ssh: pinned new host key (trust on first use)");
        }
        cb(true);
      })
      .catch((err) => {
        log.warn({ err: (err as Error)?.message, hostname, port }, "ssh: host-key pin check failed — allowing (store unavailable)");
        cb(true);
      });
  };
}
