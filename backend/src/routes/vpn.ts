/**
 * OpenVPN client profiles (migration 017) — gated by `vpn:manage`.
 *
 *   GET    /api/v1/vpn/profiles              list the caller's profiles
 *   POST   /api/v1/vpn/profiles              create a profile
 *   GET    /api/v1/vpn/profiles/:id          one profile (secrets stripped)
 *   PATCH  /api/v1/vpn/profiles/:id          update a profile
 *   DELETE /api/v1/vpn/profiles/:id          delete a profile
 *   GET    /api/v1/vpn/profiles/:id/config   reveal launchable config + auth
 *   GET    /api/v1/vpn/resolve?host_id=      effective profile for an asset
 *
 *   GET    /api/v1/vpn/connections           backend-runtime live connections
 *   POST   /api/v1/vpn/connections           bring up a backend tunnel
 *   DELETE /api/v1/vpn/connections/:id       stop a backend tunnel
 *
 * All routes are self-scoped to the authenticated user. Secret material is
 * only ever returned by `/config` (analogous to revealing a credential).
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { JwtService } from "../jwt/index.js";
import type { AuditRepository } from "../repos/otherRepos.js";
import type { VpnProfileRepository } from "../repos/vpnRepo.js";
import type { VpnManager } from "../vpn/vpnManager.js";
import { makeAuthMiddleware, requirePermission } from "../middleware/auth.js";
import { can } from "../domain/permissions.js";
import { DomainError } from "../domain/index.js";
import {
  VPN_RUNTIMES, VPN_SOURCES, VPN_PROTOS, VPN_AUTH_MODES,
  assembleOvpnConfig, assertSafeOvpnConfig, toVpnProfilePublic, type VpnSecret, VpnErrors,
  type VpnRuntime, type VpnSource, type VpnProto, type VpnAuthMode,
} from "../domain/vpn.js";

// Admin roles may open a backend-runtime tunnel (openvpn runs on the server).
const ADMIN_ROLES = new Set(["admin", "super_admin"]);
// Hostname/IPv4 charset — no whitespace or newlines, so a manual profile's
// remote can't inject extra OpenVPN config lines.
const REMOTE_HOST_RE = /^[a-zA-Z0-9._:-]+$/;

interface Deps {
  vpn: VpnProfileRepository;
  manager: VpnManager;
  audit: AuditRepository;
  jwt: JwtService;
  users: import("../repos/userRepo.js").UserRepository;
}

const runtimeEnum = z.enum(VPN_RUNTIMES as unknown as [VpnRuntime, ...VpnRuntime[]]);
const sourceEnum = z.enum(VPN_SOURCES as unknown as [VpnSource, ...VpnSource[]]);
const protoEnum = z.enum(VPN_PROTOS as unknown as [VpnProto, ...VpnProto[]]);
const authModeEnum = z.enum(VPN_AUTH_MODES as unknown as [VpnAuthMode, ...VpnAuthMode[]]);
const remoteHostSchema = z.string().max(253).regex(REMOTE_HOST_RE, "invalid remote host").nullable().optional();

// Secret material accepted on create/update. Any field omitted on update keeps
// its stored value; passing "" clears it.
const secretShape = {
  config: z.string().max(512 * 1024).optional(),
  ca: z.string().max(256 * 1024).optional(),
  cert: z.string().max(256 * 1024).optional(),
  key: z.string().max(256 * 1024).optional(),
  tls_auth: z.string().max(256 * 1024).optional(),
  username: z.string().max(256).optional(),
  password: z.string().max(1024).optional(),
};

function pickSecret(body: Record<string, unknown>): Partial<VpnSecret> {
  const s: Partial<VpnSecret> = {};
  if (body.config !== undefined) s.ovpn = body.config as string;
  if (body.ca !== undefined) s.ca = body.ca as string;
  if (body.cert !== undefined) s.cert = body.cert as string;
  if (body.key !== undefined) s.key = body.key as string;
  if (body.tls_auth !== undefined) s.tlsAuth = body.tls_auth as string;
  if (body.username !== undefined) s.username = body.username as string;
  if (body.password !== undefined) s.password = body.password as string;
  return s;
}

function domainStatus(code: string): number {
  switch (code) {
    case "vpn_profile_not_found":
    case "vpn_connection_not_found":
      return 404;
    case "vpn_profile_name_taken":
      return 409;
    case "vpn_too_many":
      return 409;
    default:
      return 400;
  }
}

export function makeVpnRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt, deps.users));
    app.addHook("preHandler", requirePermission("vpn:manage"));

    const fail = (reply: import("fastify").FastifyReply, e: unknown) => {
      if (e instanceof DomainError) {
        return reply.code(domainStatus(e.code)).send({ error: { code: e.code, message: e.message } });
      }
      throw e;
    };

    // --- List -----------------------------------------------------------
    app.get("/profiles", async (req, reply) => {
      const list = await deps.vpn.listForUser(req.auth!.sub);
      return reply.send({ data: list.map(toVpnProfilePublic) });
    });

    // --- Create ---------------------------------------------------------
    const createSchema = z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(1000).nullable().optional(),
      runtime: runtimeEnum.optional(),
      source: sourceEnum.optional(),
      remote_host: remoteHostSchema,
      remote_port: z.number().int().min(1).max(65535).nullable().optional(),
      proto: protoEnum.optional(),
      auth_mode: authModeEnum.optional(),
      auto_connect: z.boolean().optional(),
      ...secretShape,
    });

    app.post("/profiles", async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      const d = parsed.data;
      try {
        if (d.config) assertSafeOvpnConfig(d.config); // reject dangerous configs on save
        const profile = await deps.vpn.create(req.auth!.sub, {
          name: d.name,
          description: d.description ?? null,
          runtime: d.runtime,
          source: d.source,
          remoteHost: d.remote_host ?? null,
          remotePort: d.remote_port ?? null,
          proto: d.proto,
          authMode: d.auth_mode,
          autoConnect: d.auto_connect,
          secret: pickSecret(d as Record<string, unknown>) as VpnSecret,
        });
        await deps.audit.log({ userId: req.auth!.sub, action: "vpn_profile_create", success: true, resourceType: "vpn_profile", resourceId: profile.id });
        return reply.code(201).send(toVpnProfilePublic(profile));
      } catch (e) {
        return fail(reply, e);
      }
    });

    // --- Get ------------------------------------------------------------
    app.get("/profiles/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const profile = await deps.vpn.getById(req.auth!.sub, id);
        return reply.send(toVpnProfilePublic(profile));
      } catch (e) {
        return fail(reply, e);
      }
    });

    // --- Update ---------------------------------------------------------
    const updateSchema = z.object({
      name: z.string().min(1).max(100).optional(),
      description: z.string().max(1000).nullable().optional(),
      runtime: runtimeEnum.optional(),
      source: sourceEnum.optional(),
      remote_host: remoteHostSchema,
      remote_port: z.number().int().min(1).max(65535).nullable().optional(),
      proto: protoEnum.optional(),
      auth_mode: authModeEnum.optional(),
      auto_connect: z.boolean().optional(),
      ...secretShape,
    });

    app.patch("/profiles/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      const d = parsed.data;
      try {
        if (d.config) assertSafeOvpnConfig(d.config); // reject dangerous configs on save
        // Merge partial secret edits onto the stored bundle so omitted fields
        // survive; an explicit "" clears a field.
        const partial = pickSecret(d as Record<string, unknown>);
        let mergedSecret: VpnSecret | undefined;
        if (Object.keys(partial).length > 0) {
          const existing = await deps.vpn.getById(req.auth!.sub, id);
          mergedSecret = { ...existing.secret, ...partial };
        }
        const profile = await deps.vpn.update(req.auth!.sub, id, {
          name: d.name,
          description: d.description,
          runtime: d.runtime,
          source: d.source,
          remoteHost: d.remote_host,
          remotePort: d.remote_port,
          proto: d.proto,
          authMode: d.auth_mode,
          autoConnect: d.auto_connect,
          secret: mergedSecret,
        });
        await deps.audit.log({ userId: req.auth!.sub, action: "vpn_profile_update", success: true, resourceType: "vpn_profile", resourceId: profile.id });
        return reply.send(toVpnProfilePublic(profile));
      } catch (e) {
        return fail(reply, e);
      }
    });

    // --- Delete ---------------------------------------------------------
    app.delete("/profiles/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        await deps.vpn.delete(req.auth!.sub, id);
        await deps.audit.log({ userId: req.auth!.sub, action: "vpn_profile_delete", success: true, resourceType: "vpn_profile", resourceId: id });
        return reply.code(204).send();
      } catch (e) {
        return fail(reply, e);
      }
    });

    // --- Reveal launchable config --------------------------------------
    // The payload the openvpn client (desktop or backend) needs to bring the
    // tunnel up. Sensitive — treated like a credential reveal and audited.
    app.get("/profiles/:id/config", async (req, reply) => {
      const { id } = req.params as { id: string };
      // Reading the decrypted config + credentials is a separate capability from
      // managing profiles — mirror the credential-reveal split.
      if (!can(req.auth!.role, "vpn:reveal")) {
        return reply.code(403).send({ error: { code: "forbidden", message: "your role cannot reveal VPN configs" } });
      }
      try {
        const profile = await deps.vpn.getById(req.auth!.sub, id);
        const config = assembleOvpnConfig(profile).trim();
        if (!config) throw VpnErrors.ConfigMissing();
        await deps.audit.log({ userId: req.auth!.sub, action: "vpn_config_reveal", success: true, resourceType: "vpn_profile", resourceId: id });
        return reply.send({
          id: profile.id,
          name: profile.name,
          runtime: profile.runtime,
          auth_mode: profile.authMode,
          config,
          username: profile.authMode === "userpass" ? (profile.secret.username ?? "") : null,
          password: profile.authMode === "userpass" ? (profile.secret.password ?? "") : null,
        });
      } catch (e) {
        return fail(reply, e);
      }
    });

    // --- Resolve effective profile for an asset ------------------------
    app.get("/resolve", async (req, reply) => {
      const hostId = (req.query as { host_id?: string }).host_id;
      if (!hostId) return reply.code(400).send({ error: { code: "missing_param", message: "host_id is required" } });
      const profile = await deps.vpn.resolveForHost(req.auth!.sub, hostId);
      return reply.send({ profile: profile ? toVpnProfilePublic(profile) : null });
    });

    // =================================================================
    // Backend-runtime live connections
    // =================================================================

    app.get("/connections", async (req, reply) => {
      return reply.send({ data: deps.manager.list(req.auth!.sub) });
    });

    const connectSchema = z.object({ profile_id: z.string().uuid() });
    app.post("/connections", async (req, reply) => {
      // A backend-runtime tunnel spawns openvpn on the shared server host, so
      // restrict it to admins even though every vpn:manage holder can create
      // profiles. Desktop-runtime tunnels (per user's own machine) are unaffected.
      if (!ADMIN_ROLES.has(req.auth!.role)) {
        return reply.code(403).send({ error: { code: "forbidden", message: "only admins may open a backend-runtime VPN tunnel" } });
      }
      const parsed = connectSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      try {
        const profile = await deps.vpn.getById(req.auth!.sub, parsed.data.profile_id);
        if (profile.runtime !== "backend") throw VpnErrors.BackendOnly();
        const conn = await deps.manager.connect(req.auth!.sub, profile);
        await deps.audit.log({ userId: req.auth!.sub, action: "vpn_connect", success: true, resourceType: "vpn_profile", resourceId: profile.id });
        return reply.code(201).send(conn);
      } catch (e) {
        if (e instanceof DomainError) return fail(reply, e);
        return reply.code(502).send({ error: { code: "vpn_connect_failed", message: e instanceof Error ? e.message : "connect failed" } });
      }
    });

    app.delete("/connections/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const ok = deps.manager.remove(req.auth!.sub, id);
      if (!ok) return reply.code(404).send({ error: { code: "vpn_connection_not_found", message: "connection not found" } });
      return reply.send({ ok: true });
    });
  };
}
