/**
 * Branding — instance app name + logo, editable from the UI.
 *
 *   GET  /api/v1/branding   public (needed on the login screen)
 *   PUT  /api/v1/branding   admin / super_admin
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppSettingsRepository } from "../repos/appSettings.js";
import type { JwtService } from "../jwt/index.js";
import { makeAuthMiddleware, requireRole } from "../middleware/auth.js";

interface Deps {
  settings: AppSettingsRepository;
  jwt: JwtService;
}

const KEY_NAME = "app_name";
const KEY_LOGO = "app_logo";
const KEY_FAVICON = "app_favicon";

// Logo is a data URI or URL; cap the size (≈ 700 KB of base64).
const MAX_LOGO = 700 * 1024;

export function makeBrandingRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    // Public read — the login page needs it before authentication.
    app.get("/", async (_req, reply) => {
      const s = await deps.settings.getMany([KEY_NAME, KEY_LOGO, KEY_FAVICON]);
      return reply.send({ app_name: s[KEY_NAME], logo: s[KEY_LOGO], favicon: s[KEY_FAVICON] });
    });

    const putSchema = z.object({
      app_name: z.string().max(80).nullable().optional(),
      logo: z.string().max(MAX_LOGO).nullable().optional(),
      favicon: z.string().max(MAX_LOGO).nullable().optional(),
    });

    app.put(
      "/",
      { bodyLimit: 1024 * 1024, preHandler: [makeAuthMiddleware(deps.jwt), requireRole("admin", "super_admin")] },
      async (req, reply) => {
        const parsed = putSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
        }
        const validImage = (v: string) =>
          /^data:image\/[a-zA-Z.+-]+;base64,/.test(v) || /^https?:\/\//.test(v);
        if (parsed.data.logo && !validImage(parsed.data.logo)) {
          return reply.code(400).send({ error: { code: "invalid_logo", message: "logo must be a data:image URI or http(s) URL" } });
        }
        if (parsed.data.favicon && !validImage(parsed.data.favicon)) {
          return reply.code(400).send({ error: { code: "invalid_favicon", message: "favicon must be a data:image URI or http(s) URL" } });
        }
        if (parsed.data.app_name !== undefined) {
          await deps.settings.set(KEY_NAME, parsed.data.app_name?.trim() || null);
        }
        if (parsed.data.logo !== undefined) {
          await deps.settings.set(KEY_LOGO, parsed.data.logo || null);
        }
        if (parsed.data.favicon !== undefined) {
          await deps.settings.set(KEY_FAVICON, parsed.data.favicon || null);
        }
        const s = await deps.settings.getMany([KEY_NAME, KEY_LOGO, KEY_FAVICON]);
        return reply.send({ app_name: s[KEY_NAME], logo: s[KEY_LOGO], favicon: s[KEY_FAVICON] });
      },
    );
  };
}
