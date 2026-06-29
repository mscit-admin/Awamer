/**
 * Backup / Restore — export and re-import the caller's own session data
 * (folders, tags, credentials, hosts) as a portable file.
 *
 *   POST /api/v1/backup/export   build a backup (optionally encrypted)
 *   POST /api/v1/backup/import   restore a backup
 *
 * Self-scoped to the authenticated user. Exporting credential secrets requires
 * `credentials:reveal`; importing requires `resources:write`. When secrets are
 * included the whole file is encrypted with a user-chosen passphrase.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { JwtService } from "../jwt/index.js";
import { makeAuthMiddleware, requirePermission } from "../middleware/auth.js";
import { can } from "../domain/permissions.js";
import type { BackupRepository, BackupData } from "../repos/backupRepo.js";
import { encryptBackup, decryptBackup, isEncryptedBackup, BackupDecryptError } from "../crypto/backupCrypto.js";

interface Deps {
  backup: BackupRepository;
  jwt: JwtService;
}

const BACKUP_FORMAT = "awamer-backup";
const BACKUP_VERSION = 1;

export function makeBackupRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt));
    app.addHook("preHandler", requirePermission("backup:manage"));

    const exportBody = z.object({
      include_secrets: z.boolean().optional().default(false),
      passphrase: z.string().min(8).max(512).optional(),
    });

    app.post("/export", { bodyLimit: 1024 * 1024 }, async (req, reply) => {
      const parsed = exportBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      const { include_secrets, passphrase } = parsed.data;

      if (include_secrets) {
        if (!can(req.auth!.role, "credentials:reveal")) {
          return reply.code(403).send({ error: { code: "forbidden", message: "your role cannot export credential secrets" } });
        }
        if (!passphrase) {
          return reply.code(400).send({ error: { code: "passphrase_required", message: "a passphrase is required to export secrets" } });
        }
      }

      const data = await deps.backup.exportForUser(req.auth!.sub, include_secrets);
      const bundle = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exported_at: new Date().toISOString(),
        includes_secrets: include_secrets,
        counts: {
          folders: data.folders.length, tags: data.tags.length,
          credentials: data.credentials.length, hosts: data.hosts.length,
        },
        data,
      };

      if (include_secrets && passphrase) {
        return reply.send({ encrypted: true, payload: encryptBackup(JSON.stringify(bundle), passphrase) });
      }
      return reply.send({ encrypted: false, payload: bundle });
    });

    const importBody = z.object({
      payload: z.unknown(),
      passphrase: z.string().max(512).optional(),
      mode: z.enum(["merge", "skip"]).optional().default("merge"),
    });

    app.post("/import", { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
      const parsed = importBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      const { payload, passphrase, mode } = parsed.data;

      // Decrypt if it's an encrypted bundle.
      let bundle: unknown = payload;
      if (isEncryptedBackup(payload)) {
        if (!passphrase) {
          return reply.code(400).send({ error: { code: "passphrase_required", message: "this backup is encrypted — a passphrase is required" } });
        }
        try {
          bundle = JSON.parse(decryptBackup(payload, passphrase));
        } catch (e) {
          if (e instanceof BackupDecryptError) {
            return reply.code(400).send({ error: { code: "decrypt_failed", message: e.message } });
          }
          throw e;
        }
      }

      const data = extractData(bundle);
      if (!data) {
        return reply.code(400).send({ error: { code: "invalid_backup", message: "not a valid Awamer backup file" } });
      }

      try {
        const summary = await deps.backup.importForUser(req.auth!.sub, data, { mode });
        return reply.send({ ok: true, summary });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "import failed";
        return reply.code(400).send({ error: { code: "import_failed", message: msg } });
      }
    });
  };
}

/** Validate the decrypted bundle shape and pull out the data section. */
function extractData(bundle: unknown): BackupData | null {
  if (!bundle || typeof bundle !== "object") return null;
  const b = bundle as { format?: string; data?: unknown };
  if (b.format !== BACKUP_FORMAT || !b.data || typeof b.data !== "object") return null;
  const d = b.data as Partial<BackupData>;
  if (!Array.isArray(d.folders) || !Array.isArray(d.tags) || !Array.isArray(d.credentials) || !Array.isArray(d.hosts)) {
    return null;
  }
  return { folders: d.folders, tags: d.tags, credentials: d.credentials, hosts: d.hosts };
}
