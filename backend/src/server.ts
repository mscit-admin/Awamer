import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { v4 as uuid } from "uuid";

import { loadConfig } from "./config/index.js";
import { createLogger } from "./logger/index.js";
import { createPool } from "./db/index.js";
import { createArgon2 } from "./crypto/argon2.js";
import { createSecretBox, resolveSecretKey } from "./crypto/secretBox.js";
import { createJwt } from "./jwt/index.js";

import { UserRepository } from "./repos/userRepo.js";
import { MFADeviceRepository, RefreshRepository, AuditRepository } from "./repos/otherRepos.js";
import {
  FolderRepository, TagRepository, CredentialRepository,
  HostRepository, ConnectionHistoryRepository,
} from "./repos/sessionRepos.js";

import { LoginUseCase } from "./usecases/login.js";
import { RefreshUseCase } from "./usecases/refresh.js";
import { MFAUseCase } from "./usecases/mfa.js";
import { RegisterUseCase } from "./usecases/register.js";
import { ChangePasswordUseCase } from "./usecases/changePassword.js";

import { makeAuthRoutes } from "./routes/auth.js";
import { makeAuthedRoutes } from "./routes/users.js";
import { makeAdminRoutes } from "./routes/admin.js";
import { makeFolderRoutes, makeTagRoutes, makeCredentialRoutes } from "./routes/sessionMeta.js";
import { makeHostRoutes, makeHistoryRoutes } from "./routes/sessionRoutes.js";
import { makeAuditRoutes } from "./routes/audit.js";
import { makeNetworkRoutes } from "./routes/network.js";
import { makeSshGateway } from "./ssh/gateway.js";
import { makeSftpGateway } from "./ssh/sftpGateway.js";

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  const pool = await createPool(cfg, log);

  const argon2 = createArgon2(cfg);
  const jwt = createJwt(cfg);
  // Phase 10: encryption at rest for credential secrets.
  const secretBox = createSecretBox(resolveSecretKey(cfg, log));

  // Repositories
  const users = new UserRepository(pool);
  const mfaDevices = new MFADeviceRepository(pool);
  const refresh = new RefreshRepository(pool);
  const audit = new AuditRepository(pool);

  // Phase 2 repos
  const folders = new FolderRepository(pool);
  const tags = new TagRepository(pool);
  const credentials = new CredentialRepository(pool, secretBox);
  const hosts = new HostRepository(pool);
  const history = new ConnectionHistoryRepository(pool);

  // Use cases
  const loginUC = new LoginUseCase(users, refresh, audit, jwt, argon2, cfg, log);
  const refreshUC = new RefreshUseCase(users, refresh, audit, jwt, log);
  const mfaUC = new MFAUseCase(users, mfaDevices, audit, cfg, argon2);
  const registerUC = new RegisterUseCase(users, audit, argon2);
  const changePasswordUC = new ChangePasswordUseCase(users, refresh, audit, argon2);

  // Bootstrap admin (only if there are no users)
  await bootstrapAdmin(users, argon2, cfg, log);

  // Fastify app
  const app = Fastify({
    logger: log,
    trustProxy: true,
    bodyLimit: 1024 * 100,
    disableRequestLogging: false,
  });

  await app.register(websocket);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: cfg.corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-ID"],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    max: cfg.env.RATE_LIMIT_API_PER_MIN,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.ip,
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));

  await app.register(makeAuthRoutes({
    login: loginUC, refresh: refreshUC, mfa: mfaUC, users, jwt,
  }), { prefix: "/api/v1/auth" });

  await app.register(makeAuthedRoutes({ users, mfa: mfaUC, changePassword: changePasswordUC, jwt }), { prefix: "/api/v1" });
  await app.register(makeAdminRoutes({ users, register: registerUC, jwt }), { prefix: "/api/v1/admin" });

  // Phase 2 — Session Management routes
  await app.register(makeFolderRoutes({ folders, audit, jwt }), { prefix: "/api/v1/folders" });
  await app.register(makeTagRoutes({ tags, audit, jwt }), { prefix: "/api/v1/tags" });
  await app.register(makeCredentialRoutes({ credentials, audit, jwt }), { prefix: "/api/v1/credentials" });
  await app.register(makeHostRoutes({ hosts, audit, jwt }), { prefix: "/api/v1/hosts" });
  await app.register(makeHistoryRoutes({ history, hosts, audit, jwt }), { prefix: "/api/v1/history" });
  await app.register(makeAuditRoutes({ audit, jwt }), { prefix: "/api/v1/audit" });
  await app.register(makeNetworkRoutes({ jwt }), { prefix: "/api/v1/network" });

  // Phase 5 — browser SSH gateway (WebSocket).
  await app.register(makeSshGateway({ jwt, hosts, credentials, history, log }), { prefix: "/api/v1/ssh" });
  // Phase 4 — browser SFTP gateway (REST, session-based).
  await app.register(makeSftpGateway({ jwt, hosts, credentials, log }), { prefix: "/api/v1/sftp" });

  const closeOn = (sig: NodeJS.Signals) => async () => {
    log.info({ sig }, "shutdown signal received");
    try {
      await app.close();
      await pool.end();
      log.info("clean shutdown complete");
      process.exit(0);
    } catch (e) {
      log.error({ err: e }, "shutdown error");
      process.exit(1);
    }
  };
  process.once("SIGINT", closeOn("SIGINT"));
  process.once("SIGTERM", closeOn("SIGTERM"));

  await app.listen({ host: cfg.env.AUTH_HTTP_HOST, port: cfg.env.AUTH_HTTP_PORT });
  log.info({ host: cfg.env.AUTH_HTTP_HOST, port: cfg.env.AUTH_HTTP_PORT }, "auth-service listening");
}

/**
 * Create a bootstrap admin if the users table is empty. The admin's password
 * is taken from BOOTSTRAP_ADMIN_PASSWORD and hashed at startup, so there's
 * never any baked-in or SQL-escaped hash to corrupt.
 */
async function bootstrapAdmin(
  users: UserRepository,
  argon2: ReturnType<typeof createArgon2>,
  cfg: ReturnType<typeof loadConfig>,
  log: ReturnType<typeof createLogger>,
) {
  const count = await users.countAll();
  if (count > 0) {
    log.info({ existing: count }, "users already exist, skipping bootstrap admin");
    return;
  }
  const username = cfg.env.BOOTSTRAP_ADMIN_USERNAME;
  const passwordHash = await argon2.hash(cfg.env.BOOTSTRAP_ADMIN_PASSWORD);
  await users.create({
    id: uuid(),
    username,
    email: cfg.env.BOOTSTRAP_ADMIN_EMAIL,
    passwordHash,
    fullName: "Bootstrap Administrator",
    role: "super_admin",
  });
  log.warn(
    { username, email: cfg.env.BOOTSTRAP_ADMIN_EMAIL },
    "bootstrap admin created — change this password immediately",
  );
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
