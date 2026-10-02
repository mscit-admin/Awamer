import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { v4 as uuid } from "uuid";

import { loadConfig } from "./config/index.js";
import { DomainError } from "./domain/index.js";
import { createLogger } from "./logger/index.js";
import { createPool } from "./db/index.js";
import { probeDb } from "./db/readiness.js";
import { createArgon2 } from "./crypto/argon2.js";
import { createSecretBox, resolveSecretKey } from "./crypto/secretBox.js";
import { createJwt } from "./jwt/index.js";

import { UserRepository } from "./repos/userRepo.js";
import { ActiveSessionManager } from "./session/activeSessions.js";
import { MFADeviceRepository, RefreshRepository, AuditRepository, getAuditWriteFailuresTotal } from "./repos/otherRepos.js";
import {
  FolderRepository, TagRepository, CredentialRepository,
  HostRepository, ConnectionHistoryRepository,
} from "./repos/sessionRepos.js";
import { CredentialTotpRepository, CredentialAttachmentRepository } from "./repos/vaultRepos.js";

import { LoginUseCase } from "./usecases/login.js";
import { RefreshUseCase } from "./usecases/refresh.js";
import { MFAUseCase } from "./usecases/mfa.js";
import { RegisterUseCase } from "./usecases/register.js";
import { ChangePasswordUseCase } from "./usecases/changePassword.js";
import { PasswordResetUseCase } from "./usecases/passwordReset.js";
import { reencryptLegacyMfaSecrets } from "./usecases/mfaMigration.js";
import { resolveTrustedBaseUrl, assertResetEmailBaseUrl } from "./usecases/publicBaseUrl.js";
import { PasswordResetRepository } from "./repos/passwordResetRepo.js";
import { MailService } from "./email/mailer.js";
import { makePasswordResetRoutes } from "./routes/passwordReset.js";
import { configureRemoteDestinationPolicy } from "./usecases/remoteDestination.js";
import { makeSmtpRoutes } from "./routes/smtp.js";
import { makeSessionSettingsRoutes } from "./routes/sessionSettings.js";

import { makeAuthRoutes } from "./routes/auth.js";
import { makeAuthedRoutes } from "./routes/users.js";
import { StepUpService } from "./usecases/stepUp.js";
import { makeAdminRoutes } from "./routes/admin.js";
import { makeFolderRoutes, makeTagRoutes, makeCredentialRoutes } from "./routes/sessionMeta.js";
import { makeHostRoutes, makeHistoryRoutes } from "./routes/sessionRoutes.js";
import { makeAuditRoutes } from "./routes/audit.js";
import { makeNetworkRoutes } from "./routes/network.js";
import { makeBrandingRoutes } from "./routes/branding.js";
import { makeOrganizationRoutes } from "./routes/organization.js";
import { CompanyRepository, OrgUnitRepository } from "./repos/orgRepos.js";
import { makeAiRoutes } from "./routes/ai.js";
import { AiProviderRepository } from "./repos/aiRepo.js";
import { makeCommandHistoryRoutes } from "./routes/commandHistory.js";
import { makeBackupRoutes } from "./routes/backup.js";
import { AppSettingsRepository } from "./repos/appSettings.js";
import { CommandHistoryRepository } from "./repos/commandHistoryRepo.js";
import { NotesRepository } from "./repos/notesRepo.js";
import { makeNotesRoutes } from "./routes/notes.js";
import { BackupRepository } from "./repos/backupRepo.js";
import { RoleRepository } from "./repos/roleRepo.js";
import { RoleService } from "./domain/roleService.js";
import { makeRoleRoutes } from "./routes/roles.js";
import { makeSshGateway } from "./ssh/gateway.js";
import { makeSftpGateway } from "./ssh/sftpGateway.js";
import { makeVncGateway } from "./vnc/gateway.js";
import { makeTelnetGateway } from "./telnet/gateway.js";
import { TunnelManager } from "./ssh/tunnelManager.js";
import { HostKeyRepository } from "./ssh/hostKeys.js";
import { makeTunnelRoutes } from "./routes/tunnels.js";
import { makeWsTunnelGateway } from "./ssh/wsTunnelGateway.js";
import { VpnProfileRepository } from "./repos/vpnRepo.js";
import { VpnManager } from "./vpn/vpnManager.js";
import { VpnHelperClient } from "./vpn/helperClient.js";
import { makeVpnRoutes } from "./routes/vpn.js";
import { VpnServerRepository } from "./repos/vpnServerRepo.js";
import { VpnServerManager } from "./vpn/vpnServerManager.js";
import { VpnReconfigurationService } from "./vpn/vpnReconfigure.js";
import { makeVpnServerRoutes } from "./routes/vpnServer.js";

/** Map a DomainError code to an HTTP status for the global error handler. */
function statusForDomainError(code: string): number {
  if (code.endsWith("_not_found")) return 404;
  if (code.endsWith("_taken") || code === "vpn_too_many") return 409;
  if (code === "forbidden" || code === "cross_company_share") return 403;
  return 400;
}

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
  const audit = new AuditRepository(pool, log);

  // Phase 2 repos
  const folders = new FolderRepository(pool);
  const tags = new TagRepository(pool);
  const credentials = new CredentialRepository(pool, secretBox);
  const credentialTotp = new CredentialTotpRepository(pool, secretBox);
  const credentialAttachments = new CredentialAttachmentRepository(pool, secretBox);
  const hosts = new HostRepository(pool);
  const history = new ConnectionHistoryRepository(pool);
  const commands = new CommandHistoryRepository(pool);
  const notes = new NotesRepository(pool);
  const appSettings = new AppSettingsRepository(pool);
  // Multi-tenant org structure.
  const companies = new CompanyRepository(pool);
  const orgUnits = new OrgUnitRepository(pool);
  // AI providers (org + personal), keys encrypted at rest.
  const aiProviders = new AiProviderRepository(pool, secretBox);
  // SSH host-key pinning (TOFU + change detection), shared by all ssh2 sites.
  const hostKeys = new HostKeyRepository(pool);
  // Phase 5 — server-managed SSH local tunnels (in-memory).
  // SEC-INFRA-001 — the backend never spawns OpenVPN; it delegates all
  // privileged VPN lifecycle work to the isolated awamer-vpn-helper over an
  // authenticated Unix socket. Fail-closed if the helper is unreachable.
  const vpnHelper = new VpnHelperClient({
    socketPath: cfg.env.VPN_HELPER_SOCKET,
    secret: cfg.env.VPN_HELPER_SECRET ?? "",
  });
  // OpenVPN client profiles (encrypted) + backend-runtime tunnel manager.
  const vpnProfiles = new VpnProfileRepository(pool, secretBox);
  const vpnManager = new VpnManager(log, vpnHelper);
  // Awamer-as-OpenVPN-server: PKI-backed server instances + their users.
  const vpnServers = new VpnServerRepository(pool, secretBox, argon2, cfg.vpnPortPolicy);
  const vpnServerManager = new VpnServerManager(log, vpnHelper);
  // MULTI-VPN-ROLLBACK-001 — rollback-safe port/protocol reconfiguration.
  const vpnReconfig = new VpnReconfigurationService({
    servers: vpnServers, manager: vpnServerManager, audit, policy: cfg.vpnPortPolicy, log,
  });
  // Backup / restore of a user's own session data.
  const backup = new BackupRepository(pool, secretBox);
  // Custom roles — load the DB-backed RBAC resolver before serving traffic.
  const roles = new RoleRepository(pool);
  const roleService = new RoleService(roles);
  // Reconcile locked built-in roles with the code catalog first, so the latest
  // permissions are always granted to them without a per-permission migration.
  await roleService.syncBuiltins();
  await roleService.reload();

  // SEC-MFA-001: encrypt any legacy plaintext TOTP secrets at rest (idempotent).
  await reencryptLegacyMfaSecrets(mfaDevices, secretBox, log);

  // AWM-SEC-022: registry of active long-lived remote sessions (SSH/Telnet/
  // tunnel/VNC). A security-relevant account change revokes matching sessions
  // immediately; a periodic loop revalidates live state as a fallback.
  // SEC-REMOTE-DEST-001: destination policy for every remote-session gateway.
  configureRemoteDestinationPolicy({
    allowLoopback: cfg.env.REMOTE_SESSION_ALLOW_LOOPBACK,
    denyCidrs: cfg.env.REMOTE_SESSION_DENY_CIDRS ?? null,
    denyLocalSubnets: cfg.env.REMOTE_SESSION_DENY_LOCAL_SUBNETS,
  });
  const activeSessions = new ActiveSessionManager({ users, log, audit });
  const tunnels = new TunnelManager({ hosts, credentials, log, hostKeys, sessions: activeSessions });
  activeSessions.startPeriodic();

  // Use cases
  const loginUC = new LoginUseCase(users, refresh, audit, jwt, argon2, cfg, log);
  const refreshUC = new RefreshUseCase(users, refresh, audit, jwt, log);
  const stepUp = new StepUpService(jwt, users);
  const mfaUC = new MFAUseCase(users, mfaDevices, audit, cfg, argon2, secretBox, appSettings, refresh, activeSessions);
  const registerUC = new RegisterUseCase(users, audit, argon2);
  const changePasswordUC = new ChangePasswordUseCase(users, refresh, audit, argon2, activeSessions);
  // Email + forgot/reset password.
  const passwordResets = new PasswordResetRepository(pool);
  const mailer = new MailService(appSettings, secretBox, log);
  const passwordResetUC = new PasswordResetUseCase(users, passwordResets, refresh, mailer, argon2, audit, log,
    { isProd: cfg.isProd, publicBaseUrl: cfg.publicBaseUrl }, activeSessions);

  // SEC-RESET-001 (§5): fail closed at startup if email/reset is enabled in
  // production but no trusted public base URL is configured (env or setting).
  {
    const emailEnabled = await mailer.isConfigured();
    const trustedBase = resolveTrustedBaseUrl({
      envBaseUrl: cfg.publicBaseUrl,
      dbBaseUrl: await mailer.baseUrl(),
      allowHttp: !cfg.isProd,
    });
    assertResetEmailBaseUrl({ isProd: cfg.isProd, emailEnabled, trustedBase });
  }

  // Bootstrap admin (only if there are no users)
  await bootstrapAdmin(users, argon2, cfg, log);

  // Fastify app
  const app = Fastify({
    // Fastify 5: a pre-created logger instance goes in `loggerInstance`
    // (`logger` now only accepts a config object).
    loggerInstance: log,
    // SEC-PROXY-001 — trust ONLY the configured reverse-proxy hops for
    // X-Forwarded-* (default: loopback + private/ULA, i.e. the Nginx proxy path),
    // never arbitrary clients. A direct client on an untrusted address cannot spoof
    // X-Forwarded-For / X-Real-IP / Forwarded to influence req.ip (rate limit,
    // audit source IP, and any IP-sensitive logic).
    trustProxy: cfg.trustProxy,
    bodyLimit: 1024 * 100,
  });

  // SEC-WS-LIMIT-001: cap a single inbound frame (the `ws` default is 100 MiB,
  // accepted even before the first-frame auth). Terminal keystrokes, resize and
  // VNC client messages are tiny; 2 MiB leaves ample room for tunnel chunks
  // and clipboard pastes.
  await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });
  // Credential attachment uploads (vault Phase 3). 5 MB/file, single file.
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4 },
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: cfg.corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    // X-Awamer-Client is sent by the web build on every request (api.ts); it must
    // be allow-listed so cross-origin browser operation (e.g. the Vite dev origin
    // in CORS_ALLOWED_ORIGINS) passes preflight. Same-origin prod needs no CORS,
    // but listing it is harmless and keeps dev/cross-origin working (AWM §30).
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-ID", "X-Awamer-Client"],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    max: cfg.env.RATE_LIMIT_API_PER_MIN,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.ip,
  });

  // Global safety net: per-route handlers still respond first; this catches
  // anything uncaught so a stray throw never leaks a stack/internal detail to
  // the client. Domain errors keep their code + a safe status; everything
  // unexpected is logged server-side and returned as a generic 500.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) {
      return reply.code(statusForDomainError(err.code)).send({ error: { code: err.code, message: err.message } });
    }
    const e = err as { statusCode?: number; validation?: unknown; code?: string; message?: string };
    if (e.validation) {
      return reply.code(400).send({ error: { code: "validation_failed", message: e.message ?? "validation failed" } });
    }
    if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: e.code ?? "error", message: e.message ?? "error" } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "internal_error", message: "internal server error" } });
  });
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: "not_found", message: "route not found" } });
  });

  // OpenAPI docs (opt-in). Registered before the routes so it captures them;
  // browsable at /docs. Off by default so the API surface isn't exposed in prod.
  if (cfg.env.ENABLE_API_DOCS) {
    await app.register(swagger, {
      openapi: {
        info: { title: "Awamer Terminal API", version: "1.8.0" },
        components: {
          securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
        },
      },
    });
    await app.register(swaggerUi, { routePrefix: "/docs" });
    log.info("API docs enabled at /docs");
  }

  // Liveness: the process itself is up. MUST NOT depend on PostgreSQL, so an
  // orchestrator doesn't kill a healthy process during a transient DB blip.
  app.get("/healthz", async () => ({ status: "ok" }));
  // Readiness (STAB-001): only "ready" when the DB actually answers, so traffic
  // isn't routed to an instance that can't serve it. Recovers automatically
  // when the DB returns (no restart needed).
  app.get("/readyz", async (_req, reply) => {
    const ok = await probeDb(pool);
    // SEC-AUDIT-ALERT-001: export the (fail-open) audit-write failure counter so
    // monitoring can alert on it; it never affects readiness (availability).
    return reply.code(ok ? 200 : 503).send({
      status: ok ? "ready" : "not_ready",
      audit_write_failures_total: getAuditWriteFailuresTotal(),
    });
  });

  await app.register(makeAuthRoutes({
    login: loginUC, refresh: refreshUC, mfa: mfaUC, users, jwt,
    loginRateMax: cfg.env.RATE_LIMIT_LOGIN_PER_MIN,
    refreshCookieMaxAgeSec: cfg.jwtRefreshTtlSec,
    sessions: activeSessions,
  }), { prefix: "/api/v1/auth" });
  // Public forgot/reset password (same prefix as auth).
  await app.register(makePasswordResetRoutes({ reset: passwordResetUC, rateMax: cfg.env.RATE_LIMIT_LOGIN_PER_MIN }), { prefix: "/api/v1/auth" });

  await app.register(makeAuthedRoutes({ users, mfa: mfaUC, changePassword: changePasswordUC, jwt, stepUp }), { prefix: "/api/v1" });
  await app.register(makeAdminRoutes({ audit, sessions: activeSessions, users, register: registerUC, changePassword: changePasswordUC, mfa: mfaUC, roleService, jwt, refresh }), { prefix: "/api/v1/admin" });
  await app.register(makeSmtpRoutes({ mailer, users, jwt, audit }), { prefix: "/api/v1/admin/smtp" });
  await app.register(makeSessionSettingsRoutes({ settings: appSettings, users, jwt, audit }), { prefix: "/api/v1/admin/session-settings" });
  await app.register(makeRoleRoutes({ roles, roleService, audit, jwt, users }), { prefix: "/api/v1/roles" });

  // Phase 2 — Session Management routes
  await app.register(makeFolderRoutes({ folders, audit, users, jwt }), { prefix: "/api/v1/folders" });
  await app.register(makeTagRoutes({ tags, audit, users, jwt }), { prefix: "/api/v1/tags" });
  await app.register(makeCredentialRoutes({ credentials, totp: credentialTotp, attachments: credentialAttachments, audit, users, jwt }), { prefix: "/api/v1/credentials" });
  await app.register(makeHostRoutes({ hosts, audit, users, jwt }), { prefix: "/api/v1/hosts" });
  await app.register(makeHistoryRoutes({ history, hosts, audit, users, jwt }), { prefix: "/api/v1/history" });
  await app.register(makeAuditRoutes({ audit, users, jwt }), { prefix: "/api/v1/audit" });
  await app.register(makeNetworkRoutes({ users, jwt, audit, policy: cfg.networkDiagnostic }), { prefix: "/api/v1/network" });
  await app.register(makeBrandingRoutes({ settings: appSettings, users, jwt, audit }), { prefix: "/api/v1/branding" });
  await app.register(makeOrganizationRoutes({ sessions: activeSessions, companies, units: orgUnits, users, audit, jwt, roleService }), { prefix: "/api/v1/org" });
  await app.register(makeAiRoutes({ ai: aiProviders, users, jwt }), { prefix: "/api/v1/ai" });
  await app.register(makeCommandHistoryRoutes({ commands, users, jwt }), { prefix: "/api/v1/command-history" });
  await app.register(makeNotesRoutes({ notes, users, jwt }), { prefix: "/api/v1/notes" });
  await app.register(makeBackupRoutes({ backup, users, jwt }), { prefix: "/api/v1/backup" });

  // Phase 5 — browser SSH gateway (WebSocket).
  await app.register(makeSshGateway({ sessions: activeSessions, users, jwt, hosts, credentials, history, settings: appSettings, log, hostKeys }), { prefix: "/api/v1/ssh" });
  // Phase 4 — browser SFTP gateway (REST, session-based).
  await app.register(makeSftpGateway({ users, jwt, hosts, credentials, log, hostKeys, sessions: activeSessions }), { prefix: "/api/v1/sftp" });
  // Phase 6 — browser VNC gateway (WebSocket byte relay).
  await app.register(makeVncGateway({ sessions: activeSessions, users, jwt, hosts, history, log }), { prefix: "/api/v1/vnc" });
  // Browser Telnet gateway (WebSocket ↔ raw TCP relay).
  await app.register(makeTelnetGateway({ sessions: activeSessions, users, jwt, hosts, history, log }), { prefix: "/api/v1/telnet" });
  // Phase 5 — SSH port forwarding: server-managed local tunnels (REST) and a
  // per-user WebSocket TCP tunnel.
  await app.register(makeTunnelRoutes({ tunnels, users, jwt }), { prefix: "/api/v1/tunnels" });
  await app.register(makeWsTunnelGateway({ sessions: activeSessions, users, jwt, hosts, credentials, log, hostKeys }), { prefix: "/api/v1/tunnel" });
  // OpenVPN client profiles + backend-runtime connections.
  await app.register(makeVpnRoutes({ vpn: vpnProfiles, manager: vpnManager, audit, users, jwt }), { prefix: "/api/v1/vpn" });
  // Built-in OpenVPN server management (PKI, users, .ovpn, start/stop).
  await app.register(makeVpnServerRoutes({ servers: vpnServers, manager: vpnServerManager, reconfig: vpnReconfig, audit, users, jwt, portPolicy: { min: cfg.vpnPortPolicy.min, max: cfg.vpnPortPolicy.max } }), { prefix: "/api/v1/vpn-server" });

  const closeOn = (sig: NodeJS.Signals) => async () => {
    log.info({ sig }, "shutdown signal received");
    try {
      tunnels.stopAll();
      await vpnManager.stopAll();
      await vpnServerManager.stopAll();
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
