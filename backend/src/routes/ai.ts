/**
 * AI provider management + AI proxy.
 *
 *   GET    /providers               org providers (if ai:manage) + own personal (if ai:use_personal)
 *   POST   /providers               create — body {scope, provider, label, model, api_key, base_url?, is_default?}
 *   PUT    /providers/:id           update
 *   DELETE /providers/:id           delete
 *   GET    /available               providers usable in this session (no keys), for the picker
 *   POST   /chat                    { provider_id, mode, input, context? } → { text }
 *
 * Org providers are managed by ai:manage (company-scoped); personal providers
 * by ai:use_personal. Using AI (chat) needs ai:use. Keys are never returned.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { can } from "../domain/permissions.js";
import { makeAuthMiddleware, requirePermission } from "../middleware/auth.js";
import type { JwtService } from "../jwt/index.js";
import type { UserRepository } from "../repos/userRepo.js";
import type { AiProviderRepository, AiProvider } from "../repos/aiRepo.js";
import { callAi, AiError } from "../ai/providers.js";

interface Deps {
  ai: AiProviderRepository;
  users: UserRepository;
  jwt: JwtService;
}

const err = (reply: FastifyReply, code: number, k: string, m: string) => reply.code(code).send({ error: { code: k, message: m } });

// SSRF guard for the configurable provider `base_url`: the server fetch()es
// this origin from its own network position, so an internal address would let a
// tenant admin probe/reach services behind the firewall (cloud metadata, DBs,
// other tenants' backends). Reject loopback / private / link-local literals.
// A hostname (DNS name) is allowed — resolution-time rebinding is out of scope
// here and belongs to egress firewalling; this stops the obvious literal cases.
export function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host === "" || host === "0.0.0.0" || host === "::" || host === "::1") return false;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return false;
    const a = o[0] ?? 0, b = o[1] ?? 0;
    if (a === 0 || a === 127 || a === 10) return false;             // this-net / loopback / private
    if (a === 172 && b >= 16 && b <= 31) return false;              // private
    if (a === 192 && b === 168) return false;                       // private
    if (a === 169 && b === 254) return false;                       // link-local (incl. cloud metadata)
    if (a === 100 && b >= 64 && b <= 127) return false;             // CGNAT
    return true;
  }
  if (host.includes(":")) {                                        // IPv6 literal
    if (host.startsWith("fe80") || host.startsWith("fc") || host.startsWith("fd")) return false; // link-local / ULA
    const mapped = host.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // ::ffff:127.0.0.1 etc
    if (mapped) return isPublicHttpUrl(`http://${mapped[1]}`);
    return true;
  }
  return true; // DNS name
}

const baseUrlSchema = z.string().url().max(300).refine(isPublicHttpUrl, "base_url must be a public http(s) URL (loopback/private/link-local addresses are not allowed)");

// Public view — never includes the key.
const view = (p: AiProvider) => ({
  id: p.id, scope: p.scope, provider: p.provider, label: p.label, model: p.model,
  base_url: p.baseUrl, is_default: p.isDefault, is_active: p.isActive, has_key: p.hasKey,
  allow_roles: p.allowRoles, allow_users: p.allowUsers,
});

// System prompts per assist mode.
function systemPrompt(mode: string, os: string): string {
  const base = `You are a careful Linux/server operations assistant embedded in an SSH terminal. Target OS: ${os || "Linux"}. Be concise.`;
  switch (mode) {
    case "suggest":
      return `${base}\nThe user describes a task in natural language. Reply with:\n1) a single recommended shell command in a fenced code block,\n2) one short line explaining it,\n3) if it is destructive/irreversible (rm -rf, mkfs, chmod 777, dd, firewall/user changes, etc.) start that line with "⚠ DANGER:". Never invent hostnames or secrets.`;
    case "explain":
      return `${base}\nExplain what the given shell command does, step by step and briefly. Flag anything destructive with "⚠ DANGER:".`;
    case "error":
      return `${base}\nThe user pastes terminal output/errors. Explain the likely cause and give a concrete fix (commands in fenced code blocks). Flag destructive fixes with "⚠ DANGER:".`;
    default:
      return base;
  }
}

export function makeAiRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt));

    const scope = async (req: FastifyRequest) => {
      const me = await deps.users.getById(req.auth!.sub);
      return {
        userId: me.id,
        companyId: me.companyId,
        role: req.auth!.role,
        canManage: can(req.auth!.role, "ai:manage"),
        canPersonal: can(req.auth!.role, "ai:use_personal"),
        canUse: can(req.auth!.role, "ai:use"),
      };
    };

    // ---- list (management) --------------------------------------------
    app.get("/providers", async (req, reply) => {
      const s = await scope(req);
      const org = s.canManage && s.companyId ? await deps.ai.listOrg(s.companyId) : [];
      const personal = s.canPersonal ? await deps.ai.listPersonal(s.userId) : [];
      return reply.send({ org: org.map(view), personal: personal.map(view), can_manage: s.canManage, can_personal: s.canPersonal });
    });

    // ---- available for the picker (no keys) ---------------------------
    app.get("/available", async (req, reply) => {
      const s = await scope(req);
      if (!s.canUse) return reply.send({ providers: [] });
      const providers = await deps.ai.available(s.companyId, s.userId, s.role, s.canPersonal);
      return reply.send({ providers: providers.map(view) });
    });

    const createSchema = z.object({
      scope: z.enum(["org", "user"]),
      provider: z.enum(["anthropic", "openai", "google", "azure", "custom"]),
      label: z.string().min(1).max(80),
      model: z.string().min(1).max(120),
      api_key: z.string().min(1).max(400),
      base_url: baseUrlSchema.nullable().optional(),
      is_default: z.boolean().optional(),
      allow_roles: z.array(z.string().max(48)).max(30).optional(),
      allow_users: z.array(z.string().uuid()).max(500).optional(),
    });

    app.post("/providers", async (req, reply) => {
      const p = createSchema.safeParse(req.body);
      if (!p.success) return err(reply, 400, "validation_failed", p.error.message);
      const s = await scope(req);
      if (p.data.scope === "org") {
        if (!s.canManage) return err(reply, 403, "forbidden", "you cannot manage org AI providers");
        if (!s.companyId) return err(reply, 400, "no_company", "your account is not attached to a company");
      } else {
        if (!s.canPersonal) return err(reply, 403, "forbidden", "personal AI is not permitted for your role");
      }
      const created = await deps.ai.create({
        scope: p.data.scope,
        companyId: p.data.scope === "org" ? s.companyId : null,
        userId: p.data.scope === "user" ? s.userId : null,
        provider: p.data.provider,
        label: p.data.label.trim(),
        model: p.data.model.trim(),
        baseUrl: p.data.base_url ?? null,
        apiKey: p.data.api_key,
        isDefault: p.data.is_default ?? false,
        // Allowlists only apply to org providers.
        allowRoles: p.data.scope === "org" ? (p.data.allow_roles ?? []) : [],
        allowUsers: p.data.scope === "org" ? (p.data.allow_users ?? []) : [],
      });
      return reply.code(201).send({ provider: view(created) });
    });

    // Guard: the caller may only touch a provider they own (org→company+manage, user→self).
    async function ownGuard(req: FastifyRequest, reply: FastifyReply): Promise<AiProvider | null> {
      const id = (req.params as { id: string }).id;
      const prov = await deps.ai.getById(id);
      if (!prov) { err(reply, 404, "not_found", "provider not found"); return null; }
      const s = await scope(req);
      const ok = prov.scope === "org"
        ? s.canManage && prov.companyId === s.companyId
        : s.canPersonal && prov.userId === s.userId;
      if (!ok) { err(reply, 404, "not_found", "provider not found"); return null; }
      return prov;
    }

    const updateSchema = z.object({
      label: z.string().min(1).max(80).optional(),
      model: z.string().min(1).max(120).optional(),
      api_key: z.string().min(1).max(400).optional(),
      base_url: baseUrlSchema.nullable().optional(),
      is_active: z.boolean().optional(),
      is_default: z.boolean().optional(),
      allow_roles: z.array(z.string().max(48)).max(30).optional(),
      allow_users: z.array(z.string().uuid()).max(500).optional(),
    });

    app.put("/providers/:id", async (req, reply) => {
      const prov = await ownGuard(req, reply);
      if (!prov) return;
      const p = updateSchema.safeParse(req.body);
      if (!p.success) return err(reply, 400, "validation_failed", p.error.message);
      const updated = await deps.ai.update((req.params as { id: string }).id, {
        label: p.data.label, model: p.data.model, apiKey: p.data.api_key,
        baseUrl: p.data.base_url, isActive: p.data.is_active, isDefault: p.data.is_default,
        // Allowlists apply to org providers only.
        allowRoles: prov.scope === "org" ? p.data.allow_roles : undefined,
        allowUsers: prov.scope === "org" ? p.data.allow_users : undefined,
      });
      return reply.send({ provider: updated ? view(updated) : null });
    });

    app.delete("/providers/:id", async (req, reply) => {
      if (!(await ownGuard(req, reply))) return;
      await deps.ai.delete((req.params as { id: string }).id);
      return reply.code(204).send();
    });

    // ---- chat proxy ----------------------------------------------------
    const chatSchema = z.object({
      provider_id: z.string().uuid(),
      mode: z.enum(["suggest", "explain", "error", "chat"]).default("chat"),
      input: z.string().min(1).max(8000),
      os: z.string().max(80).optional(),
    });

    app.post("/chat", { preHandler: requirePermission("ai:use") }, async (req, reply) => {
      const p = chatSchema.safeParse(req.body);
      if (!p.success) return err(reply, 400, "validation_failed", p.error.message);
      const s = await scope(req);
      // The provider must be in the caller's available set (tenant + permission scoped).
      const usable = await deps.ai.available(s.companyId, s.userId, s.role, s.canPersonal);
      const chosen = usable.find((x) => x.id === p.data.provider_id);
      if (!chosen) return err(reply, 403, "forbidden", "that AI provider is not available to you");
      const apiKey = await deps.ai.getApiKey(chosen.id);
      if (!apiKey) return err(reply, 400, "no_key", "this provider has no API key configured");
      try {
        const text = await callAi({
          provider: chosen.provider, model: chosen.model, apiKey, baseUrl: chosen.baseUrl,
          system: systemPrompt(p.data.mode, p.data.os ?? ""),
          user: p.data.input,
        });
        return reply.send({ text });
      } catch (e) {
        if (e instanceof AiError) return err(reply, e.status, "ai_error", e.message);
        throw e;
      }
    });
  };
}
