/**
 * Built-in OpenVPN server management (migration 019) — gated by
 * `vpn_server:manage` (admin). Create server instances (which mint a CA +
 * server cert), manage their users, download per-user `.ovpn` files, and
 * start/stop the running openvpn process.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { JwtService } from "../jwt/index.js";
import type { AuditRepository } from "../repos/otherRepos.js";
import type { VpnServerRepository } from "../repos/vpnServerRepo.js";
import type { VpnServerManager } from "../vpn/vpnServerManager.js";
import { makeAuthMiddleware, requirePermission } from "../middleware/auth.js";
import { DomainError } from "../domain/index.js";
import {
  assembleClientOvpn, toVpnServerPublic, toVpnServerClientPublic,
} from "../domain/vpnServer.js";

interface Deps {
  servers: VpnServerRepository;
  manager: VpnServerManager;
  audit: AuditRepository;
  jwt: JwtService;
  users: import("../repos/userRepo.js").UserRepository;
}

const protoEnum = z.enum(["udp", "tcp"]);
const HOST_RE = /^[a-zA-Z0-9._:-]+$/;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

function status(code: string): number {
  if (code.endsWith("_not_found")) return 404;
  if (code.endsWith("_taken") || code.endsWith("_in_use")) return 409;
  return 400;
}

export function makeVpnServerRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt, deps.users));
    app.addHook("preHandler", requirePermission("vpn_server:manage"));

    const fail = (reply: FastifyReply, e: unknown) => {
      if (e instanceof DomainError) return reply.code(status(e.code)).send({ error: { code: e.code, message: e.message } });
      throw e;
    };
    const uid = (req: { auth?: { sub: string } }) => req.auth!.sub;

    // ---- servers ----------------------------------------------------
    app.get("/servers", async (req, reply) => {
      const list = await deps.servers.listServers(uid(req));
      const counts = await deps.servers.clientCounts(list.map((s) => s.id));
      return reply.send({ data: list.map((s) => ({ ...toVpnServerPublic(s, counts.get(s.id) ?? 0), status: deps.manager.status(s.id) })) });
    });

    const createSchema = z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(1000).nullable().optional(),
      public_host: z.string().max(253).regex(HOST_RE, "invalid host"),
      port: z.number().int().min(1).max(65535).optional(),
      proto: protoEnum.optional(),
      subnet: z.string().regex(CIDR_RE, "subnet must be CIDR, e.g. 10.8.0.0/24").optional(),
      dns: z.string().max(253).regex(HOST_RE).nullable().optional(),
      client_to_client: z.boolean().optional(),
      cipher: z.string().max(40).optional(),
    });

    app.post("/servers", async (req, reply) => {
      const p = createSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: { code: "validation_failed", message: p.error.message } });
      const d = p.data;
      try {
        const s = await deps.servers.createServer(uid(req), {
          name: d.name, description: d.description ?? null, publicHost: d.public_host,
          port: d.port, proto: d.proto, subnet: d.subnet, dns: d.dns ?? null,
          clientToClient: d.client_to_client, cipher: d.cipher,
        });
        await deps.audit.log({ userId: uid(req), action: "vpn_server_create", success: true, resourceType: "vpn_server", resourceId: s.id });
        return reply.code(201).send(toVpnServerPublic(s));
      } catch (e) { return fail(reply, e); }
    });

    app.get("/servers/:id", async (req, reply) => {
      try {
        const s = await deps.servers.getServer(uid(req), (req.params as { id: string }).id);
        return reply.send({ ...toVpnServerPublic(s), status: deps.manager.status(s.id) });
      } catch (e) { return fail(reply, e); }
    });

    const updateSchema = createSchema.partial().omit({ name: true });
    app.patch("/servers/:id", async (req, reply) => {
      const p = updateSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: { code: "validation_failed", message: p.error.message } });
      const d = p.data;
      try {
        const s = await deps.servers.updateServer(uid(req), (req.params as { id: string }).id, {
          description: d.description, publicHost: d.public_host, port: d.port, proto: d.proto,
          subnet: d.subnet, dns: d.dns, clientToClient: d.client_to_client, cipher: d.cipher,
        });
        return reply.send(toVpnServerPublic(s));
      } catch (e) { return fail(reply, e); }
    });

    app.delete("/servers/:id", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      try {
        deps.manager.stop(id);
        await deps.servers.deleteServer(uid(req), id);
        await deps.audit.log({ userId: uid(req), action: "vpn_server_delete", success: true, resourceType: "vpn_server", resourceId: id });
        return reply.code(204).send();
      } catch (e) { return fail(reply, e); }
    });

    // ---- runtime ----------------------------------------------------
    app.post("/servers/:id/start", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      try {
        const s = await deps.servers.getServer(uid(req), id);
        const st = await deps.manager.start(s);
        await deps.audit.log({ userId: uid(req), action: "vpn_server_start", success: true, resourceType: "vpn_server", resourceId: id });
        return reply.send(st);
      } catch (e) {
        if (e instanceof DomainError) return fail(reply, e);
        return reply.code(502).send({ error: { code: "vpn_server_start_failed", message: e instanceof Error ? e.message : "start failed" } });
      }
    });

    app.post("/servers/:id/stop", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      try {
        await deps.servers.getServer(uid(req), id); // ownership
        deps.manager.stop(id);
        return reply.send({ ok: true });
      } catch (e) { return fail(reply, e); }
    });

    // ---- clients ----------------------------------------------------
    app.get("/servers/:id/clients", async (req, reply) => {
      try {
        const list = await deps.servers.listClients(uid(req), (req.params as { id: string }).id);
        return reply.send({ data: list.map(toVpnServerClientPublic) });
      } catch (e) { return fail(reply, e); }
    });

    const clientSchema = z.object({
      name: z.string().min(1).max(100),
      username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/, "invalid username"),
      password: z.string().min(8).max(128).optional(),
    });
    app.post("/servers/:id/clients", async (req, reply) => {
      const serverId = (req.params as { id: string }).id;
      const p = clientSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: { code: "validation_failed", message: p.error.message } });
      const password = p.data.password ?? randomBytes(12).toString("base64url");
      try {
        const c = await deps.servers.createClient(uid(req), serverId, { name: p.data.name, username: p.data.username, password });
        await deps.audit.log({ userId: uid(req), action: "vpn_server_client_create", success: true, resourceType: "vpn_server", resourceId: serverId, details: { client: c.id } });
        // Return the password once so the admin can hand it over (also stored, reveal-gated).
        return reply.code(201).send({ ...toVpnServerClientPublic(c), password });
      } catch (e) { return fail(reply, e); }
    });

    const revokeSchema = z.object({ revoked: z.boolean() });
    app.post("/servers/:id/clients/:cid/revoke", async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string };
      const p = revokeSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: { code: "validation_failed", message: p.error.message } });
      try {
        await deps.servers.setClientRevoked(uid(req), id, cid, p.data.revoked);
        await deps.audit.log({ userId: uid(req), action: p.data.revoked ? "vpn_server_client_revoke" : "vpn_server_client_unrevoke", success: true, resourceType: "vpn_server", resourceId: id, details: { client: cid } });
        return reply.send({ ok: true, revoked: p.data.revoked });
      } catch (e) { return fail(reply, e); }
    });

    app.delete("/servers/:id/clients/:cid", async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string };
      try {
        await deps.servers.deleteClient(uid(req), id, cid);
        return reply.code(204).send();
      } catch (e) { return fail(reply, e); }
    });

    /** Reveal a client's username/password (audited). */
    app.get("/servers/:id/clients/:cid/credentials", async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string };
      try {
        const c = await deps.servers.getClient(uid(req), id, cid);
        await deps.audit.log({ userId: uid(req), action: "vpn_server_client_reveal", success: true, resourceType: "vpn_server", resourceId: id, details: { client: cid } });
        return reply.send({ username: c.username, password: c.password });
      } catch (e) { return fail(reply, e); }
    });

    /** Download the unified .ovpn for a client. */
    app.get("/servers/:id/clients/:cid/ovpn", async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string };
      try {
        const s = await deps.servers.getServer(uid(req), id);
        const c = await deps.servers.getClient(uid(req), id, cid);
        const ovpn = assembleClientOvpn({
          proto: s.proto, publicHost: s.publicHost, port: s.port, cipher: s.cipher,
          caCert: s.caCert, clientCert: c.cert, clientKey: c.key, tlsCrypt: s.tlsCrypt,
        });
        await deps.audit.log({ userId: uid(req), action: "vpn_server_client_download", success: true, resourceType: "vpn_server", resourceId: id, details: { client: cid } });
        const safe = c.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        return reply
          .header("Content-Type", "application/x-openvpn-profile")
          .header("Content-Disposition", `attachment; filename="${safe}.ovpn"`)
          .send(ovpn);
      } catch (e) { return fail(reply, e); }
    });
  };
}
