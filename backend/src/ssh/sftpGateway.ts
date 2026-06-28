/**
 * Browser SFTP gateway (Phase 4 — web file browser).
 *
 * The desktop app speaks SFTP natively. For the browser we expose a small
 * session-based REST surface: the server holds the SSH+SFTP connection (via
 * `ssh2`) and the browser issues ordinary authenticated HTTP requests
 * referencing a `session_id`.
 *
 * Sessions live in memory, are bound to the user who created them, and are
 * reaped after an idle timeout. This mirrors the desktop's sftp_connect →
 * session_id model.
 *
 * Endpoints (all under /api/v1/sftp, all require a Bearer token):
 *   POST /connect     {host_id, password?, passphrase?} → {session_id, initial_path}
 *   GET  /list        ?session_id=&path=                 → {entries:[RemoteEntry]}
 *   GET  /read        ?session_id=&path=                 → {content, truncated}
 *   POST /write       {session_id, path, content}
 *   POST /mkdir       {session_id, path}
 *   POST /rename      {session_id, from, to}
 *   POST /delete      {session_id, path, is_dir}
 *   GET  /download    ?session_id=&path=                 → raw bytes
 *   POST /upload      {session_id, path, content_base64}
 *   POST /disconnect  {session_id}
 */
import { Client, type SFTPWrapper, type FileEntry } from "ssh2";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { makeAuthMiddleware } from "../middleware/auth.js";
import { can } from "../domain/permissions.js";
import type { JwtService } from "../jwt/index.js";
import type { Logger } from "../logger/index.js";
import type { HostRepository, CredentialRepository } from "../repos/sessionRepos.js";

export interface SftpGatewayDeps {
  jwt: JwtService;
  hosts: HostRepository;
  credentials: CredentialRepository;
  log: Logger;
}

interface SftpSession {
  conn: Client;
  sftp: SFTPWrapper;
  userId: string;
  host: string;
  lastUsed: number;
}

const IDLE_MS = 10 * 60 * 1000; // reap sessions idle for 10 minutes
const MAX_READ_BYTES = 1024 * 1024; // 1 MB inline read/edit cap (matches desktop)

function randomId(): string {
  // 16 random bytes hex — collision-safe session handle.
  const b = Buffer.allocUnsafe(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return b.toString("hex");
}

// POSIX file-type bits (Attributes only exposes the raw mode number).
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

function entryKind(e: FileEntry): "file" | "dir" | "symlink" | "other" {
  const t = (e.attrs.mode ?? 0) & S_IFMT;
  if (t === S_IFDIR) return "dir";
  if (t === S_IFLNK) return "symlink";
  if (t === S_IFREG) return "file";
  return "other";
}

function joinPath(dir: string, name: string): string {
  if (dir.endsWith("/")) return dir + name;
  return dir + "/" + name;
}

export function makeSftpGateway(deps: SftpGatewayDeps) {
  const sessions = new Map<string, SftpSession>();

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastUsed > IDLE_MS) {
        try { s.conn.end(); } catch { /* ignore */ }
        sessions.delete(id);
      }
    }
  }, 60_000);
  reaper.unref?.();

  /** Resolve and touch a session, enforcing ownership. */
  function getSession(req: FastifyRequest, reply: FastifyReply, sessionId: string | undefined): SftpSession | null {
    if (!sessionId) {
      reply.code(400).send({ error: { code: "bad_request", message: "session_id required" } });
      return null;
    }
    const s = sessions.get(sessionId);
    if (!s || s.userId !== req.auth!.sub) {
      reply.code(404).send({ error: { code: "session_not_found", message: "no such SFTP session" } });
      return null;
    }
    s.lastUsed = Date.now();
    return s;
  }

  return async function plugin(app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt));
    app.addHook("onClose", async () => {
      clearInterval(reaper);
      for (const s of sessions.values()) {
        try { s.conn.end(); } catch { /* ignore */ }
      }
      sessions.clear();
    });

    // ---- connect ------------------------------------------------------
    const connectSchema = z.object({
      host_id: z.string().uuid(),
      password: z.string().optional(),
      passphrase: z.string().optional(),
    });

    app.post("/connect", async (req, reply) => {
      const parsed = connectSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      const userId = req.auth!.sub;
      if (!can(req.auth!.role, "sessions:connect")) {
        return reply.code(403).send({ error: { code: "forbidden", message: "your role cannot open sessions" } });
      }
      const { host_id, password, passphrase } = parsed.data;

      let host;
      try {
        host = await deps.hosts.getById(userId, host_id);
      } catch {
        return reply.code(404).send({ error: { code: "host_not_found", message: "host not found" } });
      }

      // Resolve auth material (mirrors the SSH gateway).
      let username = "root";
      let auth: { password: string } | { privateKey: string; passphrase?: string } | null = null;
      try {
        if (password) {
          if (host.credentialId) {
            const c = await deps.credentials.getById(userId, host.credentialId);
            username = c.username || "root";
          }
          auth = { password };
        } else if (host.credentialId) {
          const cred = await deps.credentials.getById(userId, host.credentialId);
          username = cred.username || "root";
          const secret = cred.secretData ?? {};
          if (cred.credentialType === "password") {
            if (typeof secret["password"] !== "string") {
              return reply.code(400).send({ error: { code: "no_credential", message: "credential has no password" } });
            }
            auth = { password: secret["password"] as string };
          } else if (cred.credentialType === "private_key") {
            if (typeof secret["private_key"] !== "string") {
              return reply.code(400).send({ error: { code: "no_credential", message: "credential has no private_key" } });
            }
            const pp = passphrase ?? (typeof secret["passphrase"] === "string" ? (secret["passphrase"] as string) : undefined);
            auth = { privateKey: secret["private_key"] as string, ...(pp ? { passphrase: pp } : {}) };
          } else {
            return reply.code(400).send({ error: { code: "unsupported_credential", message: `type ${cred.credentialType} unsupported` } });
          }
        } else {
          return reply.code(400).send({ error: { code: "no_credential", message: "host has no credential and no password provided" } });
        }
      } catch (e) {
        deps.log.warn({ err: e }, "sftp gateway: credential resolution failed");
        return reply.code(400).send({ error: { code: "credential_error", message: "could not resolve credentials" } });
      }

      // Open SSH + SFTP.
      try {
        const result = await new Promise<{ session_id: string; initial_path: string }>((resolve, reject) => {
          const conn = new Client();
          conn.on("ready", () => {
            conn.sftp((err, sftp) => {
              if (err) { conn.end(); return reject(err); }
              sftp.realpath(".", (rpErr, abs) => {
                const initial = rpErr ? "/" : abs;
                const id = randomId();
                sessions.set(id, { conn, sftp, userId, host: host.hostname, lastUsed: Date.now() });
                resolve({ session_id: id, initial_path: initial });
              });
            });
          });
          conn.on("error", (e) => reject(e));
          conn.connect({
            host: host.hostname,
            port: host.port,
            username,
            readyTimeout: 20_000,
            hostVerifier: () => true, // TOFU-accept (see SSH gateway note)
            ...auth,
          });
        });
        return reply.send(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "connection failed";
        return reply.code(502).send({ error: { code: "ssh_error", message: msg } });
      }
    });

    // ---- list ---------------------------------------------------------
    app.get("/list", async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const s = getSession(req, reply, q.session_id);
      if (!s) return;
      const path = q.path || ".";
      try {
        const entries = await new Promise<FileEntry[]>((resolve, reject) => {
          s.sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)));
        });
        const mapped = entries
          .filter((e) => e.filename !== "." && e.filename !== "..")
          .map((e) => ({
            name: e.filename,
            path: joinPath(path, e.filename),
            kind: entryKind(e),
            size: e.attrs.size ?? 0,
            mtime: e.attrs.mtime ?? 0,
            mode: e.attrs.mode ?? 0,
            uid: e.attrs.uid ?? null,
            gid: e.attrs.gid ?? null,
          }));
        return reply.send({ entries: mapped });
      } catch (e) {
        return reply.code(400).send({ error: { code: "list_failed", message: e instanceof Error ? e.message : "list failed" } });
      }
    });

    // ---- read (inline view/edit) -------------------------------------
    app.get("/read", async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const s = getSession(req, reply, q.session_id);
      if (!s) return;
      if (!q.path) return reply.code(400).send({ error: { code: "bad_request", message: "path required" } });
      try {
        const stat = await new Promise<import("ssh2").Stats>((resolve, reject) => {
          s.sftp.stat(q.path as string, (err, st) => (err ? reject(err) : resolve(st)));
        });
        if ((stat.size ?? 0) > MAX_READ_BYTES) {
          return reply.code(413).send({ error: { code: "too_large", message: "file exceeds 1 MB inline limit" } });
        }
        const buf = await new Promise<Buffer>((resolve, reject) => {
          s.sftp.readFile(q.path as string, (err, data) => (err ? reject(err) : resolve(data as Buffer)));
        });
        return reply.send({ content: buf.toString("utf8"), truncated: false });
      } catch (e) {
        return reply.code(400).send({ error: { code: "read_failed", message: e instanceof Error ? e.message : "read failed" } });
      }
    });

    // ---- write -------------------------------------------------------
    const writeSchema = z.object({ session_id: z.string(), path: z.string().min(1), content: z.string() });
    app.post("/write", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
      const parsed = writeSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      const s = getSession(req, reply, parsed.data.session_id);
      if (!s) return;
      try {
        await new Promise<void>((resolve, reject) => {
          s.sftp.writeFile(parsed.data.path, Buffer.from(parsed.data.content, "utf8"), (err) => (err ? reject(err) : resolve()));
        });
        return reply.send({ status: "ok" });
      } catch (e) {
        return reply.code(400).send({ error: { code: "write_failed", message: e instanceof Error ? e.message : "write failed" } });
      }
    });

    // ---- mkdir / rename / delete -------------------------------------
    const mkdirSchema = z.object({ session_id: z.string(), path: z.string().min(1) });
    app.post("/mkdir", async (req, reply) => {
      const parsed = mkdirSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      const s = getSession(req, reply, parsed.data.session_id);
      if (!s) return;
      try {
        await new Promise<void>((resolve, reject) => s.sftp.mkdir(parsed.data.path, (err) => (err ? reject(err) : resolve())));
        return reply.send({ status: "ok" });
      } catch (e) {
        return reply.code(400).send({ error: { code: "mkdir_failed", message: e instanceof Error ? e.message : "mkdir failed" } });
      }
    });

    const renameSchema = z.object({ session_id: z.string(), from: z.string().min(1), to: z.string().min(1) });
    app.post("/rename", async (req, reply) => {
      const parsed = renameSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      const s = getSession(req, reply, parsed.data.session_id);
      if (!s) return;
      try {
        await new Promise<void>((resolve, reject) => s.sftp.rename(parsed.data.from, parsed.data.to, (err) => (err ? reject(err) : resolve())));
        return reply.send({ status: "ok" });
      } catch (e) {
        return reply.code(400).send({ error: { code: "rename_failed", message: e instanceof Error ? e.message : "rename failed" } });
      }
    });

    const deleteSchema = z.object({ session_id: z.string(), path: z.string().min(1), is_dir: z.boolean().optional() });
    app.post("/delete", async (req, reply) => {
      const parsed = deleteSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      const s = getSession(req, reply, parsed.data.session_id);
      if (!s) return;
      try {
        await new Promise<void>((resolve, reject) => {
          const cb = (err: Error | null | undefined) => (err ? reject(err) : resolve());
          if (parsed.data.is_dir) s.sftp.rmdir(parsed.data.path, cb);
          else s.sftp.unlink(parsed.data.path, cb);
        });
        return reply.send({ status: "ok" });
      } catch (e) {
        return reply.code(400).send({ error: { code: "delete_failed", message: e instanceof Error ? e.message : "delete failed" } });
      }
    });

    // ---- download (raw bytes) ----------------------------------------
    app.get("/download", async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const s = getSession(req, reply, q.session_id);
      if (!s) return;
      if (!q.path) return reply.code(400).send({ error: { code: "bad_request", message: "path required" } });
      const name = q.path.split("/").pop() || "download";
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Disposition", `attachment; filename="${name.replace(/"/g, "")}"`);
      const stream = s.sftp.createReadStream(q.path);
      return reply.send(stream);
    });

    // ---- upload (base64 in JSON) -------------------------------------
    const uploadSchema = z.object({ session_id: z.string(), path: z.string().min(1), content_base64: z.string() });
    app.post("/upload", { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
      const parsed = uploadSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      const s = getSession(req, reply, parsed.data.session_id);
      if (!s) return;
      try {
        const buf = Buffer.from(parsed.data.content_base64, "base64");
        await new Promise<void>((resolve, reject) => {
          s.sftp.writeFile(parsed.data.path, buf, (err) => (err ? reject(err) : resolve()));
        });
        return reply.send({ status: "ok", bytes: buf.length });
      } catch (e) {
        return reply.code(400).send({ error: { code: "upload_failed", message: e instanceof Error ? e.message : "upload failed" } });
      }
    });

    // ---- disconnect --------------------------------------------------
    const disconnectSchema = z.object({ session_id: z.string() });
    app.post("/disconnect", async (req, reply) => {
      const parsed = disconnectSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      const s = sessions.get(parsed.data.session_id);
      if (s && s.userId === req.auth!.sub) {
        try { s.conn.end(); } catch { /* ignore */ }
        sessions.delete(parsed.data.session_id);
      }
      return reply.send({ status: "ok" });
    });
  };
}
