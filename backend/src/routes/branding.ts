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
const KEY_LOGIN_IMAGE = "app_login_image";

const KEYS = [KEY_NAME, KEY_LOGO, KEY_FAVICON, KEY_LOGIN_IMAGE];

// Logo/favicon are small; the login background can be a larger photo.
const MAX_LOGO = 700 * 1024;
const MAX_LOGIN_IMAGE = 3 * 1024 * 1024;

export function makeBrandingRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    const view = (s: Record<string, string | null>) => ({
      app_name: s[KEY_NAME], logo: s[KEY_LOGO], favicon: s[KEY_FAVICON], login_image: s[KEY_LOGIN_IMAGE],
    });

    // Public read — the login page needs it before authentication.
    app.get("/", async (_req, reply) => {
      return reply.send(view(await deps.settings.getMany(KEYS)));
    });

    const putSchema = z.object({
      app_name: z.string().max(80).nullable().optional(),
      logo: z.string().max(MAX_LOGO).nullable().optional(),
      favicon: z.string().max(MAX_LOGO).nullable().optional(),
      login_image: z.string().max(MAX_LOGIN_IMAGE).nullable().optional(),
    });

    app.put(
      "/",
      { bodyLimit: 4 * 1024 * 1024, preHandler: [makeAuthMiddleware(deps.jwt), requireRole("admin", "super_admin")] },
      async (req, reply) => {
        const parsed = putSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
        }
        const validImage = (v: string) =>
          /^data:image\/[a-zA-Z.+-]+;base64,/.test(v) || /^https?:\/\//.test(v);
        for (const [field, val] of [["logo", parsed.data.logo], ["favicon", parsed.data.favicon], ["login_image", parsed.data.login_image]] as const) {
          if (val && !validImage(val)) {
            return reply.code(400).send({ error: { code: `invalid_${field}`, message: `${field} must be a data:image URI or http(s) URL` } });
          }
        }
        if (parsed.data.app_name !== undefined) await deps.settings.set(KEY_NAME, parsed.data.app_name?.trim() || null);
        if (parsed.data.logo !== undefined) await deps.settings.set(KEY_LOGO, parsed.data.logo || null);
        if (parsed.data.favicon !== undefined) await deps.settings.set(KEY_FAVICON, parsed.data.favicon || null);
        if (parsed.data.login_image !== undefined) await deps.settings.set(KEY_LOGIN_IMAGE, parsed.data.login_image || null);
        return reply.send(view(await deps.settings.getMany(KEYS)));
      },
    );
  };
}
