/**
 * Repository for the built-in OpenVPN server (migration 019).
 *
 * Owns PKI issuance (via `vpn/pki`), encrypts every private key + password at
 * rest with SecretBox, and hashes client passwords with Argon2 for the
 * auth-verify step. All queries are owner-scoped to the requesting user.
 */
import type { Pool } from "../db/index.js";
import type { SecretBox } from "../crypto/secretBox.js";
import type { Argon2Service } from "../crypto/argon2.js";
import { generateCa, generateServerCert, generateClientCert } from "../vpn/pki.js";
import {
  type VpnServer, type VpnServerClient, type VpnProto, VpnServerErrors,
} from "../domain/vpnServer.js";

function seal(box: SecretBox, pem: string): string {
  return JSON.stringify(box.seal({ pem }));
}
function open(box: SecretBox, enc: Record<string, unknown> | null): string {
  const v = box.open(enc ?? {}) as { pem?: unknown };
  return typeof v.pem === "string" ? v.pem : "";
}

interface ServerRow {
  id: string; user_id: string; name: string; description: string | null;
  public_host: string; port: number; proto: string; subnet: string; dns: string | null;
  client_to_client: boolean; internet_access: boolean; cipher: string;
  ca_cert: string; ca_key_enc: Record<string, unknown>;
  server_cert: string; server_key_enc: Record<string, unknown>;
  tls_crypt_enc: Record<string, unknown>;
  created_at: Date; updated_at: Date;
}

const S_COLS = `id, user_id, name, description, public_host, port, proto, subnet, dns,
                client_to_client, internet_access, cipher, ca_cert, ca_key_enc, server_cert, server_key_enc,
                tls_crypt_enc, created_at, updated_at`;

interface ClientRow {
  id: string; server_id: string; name: string; username: string;
  password_hash: string; password_enc: Record<string, unknown>;
  cert: string; key_enc: Record<string, unknown>;
  revoked: boolean; revoked_at: Date | null; internet_access: boolean; created_at: Date;
}

const C_COLS = `id, server_id, name, username, password_hash, password_enc, cert, key_enc,
                revoked, revoked_at, internet_access, created_at`;

export interface CreateServerInput {
  name: string; description?: string | null; publicHost: string; port?: number;
  proto?: VpnProto; subnet?: string; dns?: string | null; clientToClient?: boolean;
  internetAccess?: boolean; cipher?: string;
}

function wrapUnique(e: unknown, mk: () => Error): Error {
  if ((e as { code?: string }).code === "23505") return mk();
  return e instanceof Error ? e : new Error(String(e));
}

export class VpnServerRepository {
  constructor(
    private readonly pool: Pool,
    private readonly box: SecretBox,
    private readonly argon2: Argon2Service,
  ) {}

  private rowToServer(r: ServerRow): VpnServer {
    return {
      id: r.id, userId: r.user_id, name: r.name, description: r.description,
      publicHost: r.public_host, port: r.port, proto: r.proto as VpnProto, subnet: r.subnet,
      dns: r.dns, clientToClient: r.client_to_client, internetAccess: r.internet_access, cipher: r.cipher,
      caCert: r.ca_cert, caKey: open(this.box, r.ca_key_enc),
      serverCert: r.server_cert, serverKey: open(this.box, r.server_key_enc),
      tlsCrypt: open(this.box, r.tls_crypt_enc),
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  private rowToClient(r: ClientRow): VpnServerClient {
    const pw = this.box.open(r.password_enc ?? {}) as { p?: unknown };
    return {
      id: r.id, serverId: r.server_id, name: r.name, username: r.username,
      passwordHash: r.password_hash, password: typeof pw.p === "string" ? pw.p : "",
      cert: r.cert, key: open(this.box, r.key_enc),
      revoked: r.revoked, revokedAt: r.revoked_at, internetAccess: r.internet_access, createdAt: r.created_at,
    };
  }

  // ---- servers ------------------------------------------------------

  async createServer(userId: string, input: CreateServerInput): Promise<VpnServer> {
    const ca = generateCa(`${input.name} CA`);
    const server = generateServerCert("server", ca.certPem, ca.keyPem);
    try {
      const { rows } = await this.pool.query<ServerRow>(
        `INSERT INTO vpn_servers
           (user_id, name, description, public_host, port, proto, subnet, dns,
            client_to_client, internet_access, cipher, ca_cert, ca_key_enc, server_cert, server_key_enc, tls_crypt_enc)
         VALUES ($1,$2,$3,$4,COALESCE($5,1194),COALESCE($6,'udp'),COALESCE($7,'10.8.0.0/24'),$8,
                 COALESCE($9,TRUE),COALESCE($10,FALSE),COALESCE($11,'AES-256-GCM'),$12,$13::jsonb,$14,$15::jsonb,$16::jsonb)
         RETURNING ${S_COLS}`,
        [
          userId, input.name, input.description ?? null, input.publicHost,
          input.port ?? null, input.proto ?? null, input.subnet ?? null, input.dns ?? null,
          input.clientToClient ?? null, input.internetAccess ?? null, input.cipher ?? null,
          ca.certPem, seal(this.box, ca.keyPem),
          server.certPem, seal(this.box, server.keyPem),
          seal(this.box, ca.tlsCrypt),
        ],
      );
      return this.rowToServer(rows[0]!);
    } catch (e) {
      throw wrapUnique(e, VpnServerErrors.ServerNameTaken);
    }
  }

  async listServers(userId: string): Promise<VpnServer[]> {
    const { rows } = await this.pool.query<ServerRow>(
      `SELECT ${S_COLS} FROM vpn_servers WHERE user_id = $1 ORDER BY name`, [userId]);
    return rows.map((r) => this.rowToServer(r));
  }

  async getServer(userId: string, id: string): Promise<VpnServer> {
    const { rows } = await this.pool.query<ServerRow>(
      `SELECT ${S_COLS} FROM vpn_servers WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (!rows[0]) throw VpnServerErrors.ServerNotFound();
    return this.rowToServer(rows[0]);
  }

  async updateServer(userId: string, id: string, patch: Partial<Pick<CreateServerInput,
    "description" | "publicHost" | "port" | "proto" | "subnet" | "dns" | "clientToClient" | "internetAccess" | "cipher">>): Promise<VpnServer> {
    const s = await this.getServer(userId, id);
    const m = { ...s, ...patch } as VpnServer & CreateServerInput;
    const { rows } = await this.pool.query<ServerRow>(
      `UPDATE vpn_servers SET description=$3, public_host=$4, port=$5, proto=$6, subnet=$7,
         dns=$8, client_to_client=$9, internet_access=$10, cipher=$11, updated_at=NOW()
       WHERE id=$1 AND user_id=$2 RETURNING ${S_COLS}`,
      [id, userId, patch.description ?? s.description, m.publicHost, m.port, m.proto,
       m.subnet, patch.dns !== undefined ? patch.dns : s.dns, m.clientToClient,
       patch.internetAccess ?? s.internetAccess, m.cipher]);
    if (!rows[0]) throw VpnServerErrors.ServerNotFound();
    return this.rowToServer(rows[0]);
  }

  async deleteServer(userId: string, id: string): Promise<void> {
    const r = await this.pool.query(`DELETE FROM vpn_servers WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (r.rowCount === 0) throw VpnServerErrors.ServerNotFound();
  }

  async clientCounts(serverIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (serverIds.length === 0) return map;
    const { rows } = await this.pool.query<{ server_id: string; c: string }>(
      `SELECT server_id, COUNT(*)::text c FROM vpn_server_clients
       WHERE server_id = ANY($1::uuid[]) AND NOT revoked GROUP BY server_id`, [serverIds]);
    for (const r of rows) map.set(r.server_id, Number(r.c));
    return map;
  }

  // ---- clients ------------------------------------------------------

  async createClient(userId: string, serverId: string, input: { name: string; username: string; password: string; internetAccess?: boolean }): Promise<VpnServerClient> {
    const server = await this.getServer(userId, serverId); // ownership + CA material
    const leaf = generateClientCert(input.username, server.caCert, server.caKey);
    const passwordHash = await this.argon2.hash(input.password);
    try {
      const { rows } = await this.pool.query<ClientRow>(
        `INSERT INTO vpn_server_clients
           (server_id, name, username, password_hash, password_enc, cert, key_enc, internet_access)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,COALESCE($8,FALSE)) RETURNING ${C_COLS}`,
        [serverId, input.name, input.username, passwordHash,
         JSON.stringify(this.box.seal({ p: input.password })), leaf.certPem, seal(this.box, leaf.keyPem),
         input.internetAccess ?? null]);
      return this.rowToClient(rows[0]!);
    } catch (e) {
      throw wrapUnique(e, VpnServerErrors.ClientNameTaken);
    }
  }

  async setClientInternet(userId: string, serverId: string, clientId: string, internetAccess: boolean): Promise<void> {
    await this.getServer(userId, serverId);
    const r = await this.pool.query(
      `UPDATE vpn_server_clients SET internet_access = $3 WHERE id = $1 AND server_id = $2`,
      [clientId, serverId, internetAccess]);
    if (r.rowCount === 0) throw VpnServerErrors.ClientNotFound();
  }

  async listClients(userId: string, serverId: string): Promise<VpnServerClient[]> {
    await this.getServer(userId, serverId); // ownership
    const { rows } = await this.pool.query<ClientRow>(
      `SELECT ${C_COLS} FROM vpn_server_clients WHERE server_id = $1 ORDER BY name`, [serverId]);
    return rows.map((r) => this.rowToClient(r));
  }

  async getClient(userId: string, serverId: string, clientId: string): Promise<VpnServerClient> {
    await this.getServer(userId, serverId);
    const { rows } = await this.pool.query<ClientRow>(
      `SELECT ${C_COLS} FROM vpn_server_clients WHERE id = $1 AND server_id = $2`, [clientId, serverId]);
    if (!rows[0]) throw VpnServerErrors.ClientNotFound();
    return this.rowToClient(rows[0]);
  }

  async setClientRevoked(userId: string, serverId: string, clientId: string, revoked: boolean): Promise<void> {
    await this.getServer(userId, serverId);
    const r = await this.pool.query(
      `UPDATE vpn_server_clients SET revoked = $3, revoked_at = CASE WHEN $3 THEN NOW() ELSE NULL END
       WHERE id = $1 AND server_id = $2`, [clientId, serverId, revoked]);
    if (r.rowCount === 0) throw VpnServerErrors.ClientNotFound();
  }

  async deleteClient(userId: string, serverId: string, clientId: string): Promise<void> {
    await this.getServer(userId, serverId);
    const r = await this.pool.query(`DELETE FROM vpn_server_clients WHERE id = $1 AND server_id = $2`, [clientId, serverId]);
    if (r.rowCount === 0) throw VpnServerErrors.ClientNotFound();
  }
}
