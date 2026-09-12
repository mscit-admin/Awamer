/**
 * SEC-INFRA-001 — entrypoint for the privileged `awamer-vpn-helper` container.
 *
 * This process is the ONLY one that spawns OpenVPN. It runs in a dedicated
 * container that holds NET_ADMIN + /dev/net/tun and NO public port; the backend
 * reaches it only over the shared Unix socket, authenticated with the shared
 * `VPN_HELPER_SECRET`. It exposes structured operations only.
 */
import { mkdir, rm, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HelperCore } from "./helperCore.js";
import { createHelperServer, listenHelper } from "./helperServer.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function log(obj: Record<string, unknown>, msg: string): void {
  // Structured JSON line; NEVER includes secrets/config/credentials.
  try { process.stdout.write(JSON.stringify({ t: new Date().toISOString(), svc: "vpn-helper", msg, ...obj }) + "\n"); }
  catch { /* ignore */ }
}

async function main(): Promise<void> {
  const secret = process.env.VPN_HELPER_SECRET ?? "";
  if (secret.length < 32) {
    log({}, "FATAL: VPN_HELPER_SECRET must be set (>=32 chars). Refusing to start.");
    process.exit(1);
  }
  const socketPath = process.env.VPN_HELPER_SOCKET ?? "/run/awamer/ipc/vpn-helper.sock";
  const runtimeDir = process.env.VPN_RUNTIME_DIR ?? "/var/lib/awamer/vpn-runtime";

  // Socket directory + socket are group-shared with the backend WITHOUT needing
  // CAP_CHOWN (dropped): the helper container runs with the backend's gid as its
  // group (compose `user: "0:<gid>"`), so files it CREATES are already group-
  // owned by that gid. We only need chmod (allowed on our own files) — no chown.
  // The socket lives in a helper-created SUBDIR (0750: owner rwx, group r-x, no
  // world) so it inherits that group; the volume root can stay root-owned.
  const sockDir = dirname(socketPath);
  await mkdir(sockDir, { recursive: true });
  await chmod(sockDir, 0o750).catch(() => {}); // owner rwx, backend-gid r-x, world none
  await rm(socketPath, { force: true }).catch(() => {});
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700).catch(() => {});

  // The auth-verify child (server mode) is the helper's OWN authVerify.js, run
  // by the same node binary. In the compiled image this is dist/vpn/authVerify.js.
  const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const verifyScript = join(HERE, "..", "vpn", "authVerify.js");
  const verifyExec = `${shq(process.execPath)} ${shq(verifyScript)}`;

  const core = new HelperCore({
    openvpnPath: process.env.OPENVPN_PATH ?? "/usr/sbin/openvpn",
    runtimeDir,
    maxSessions: Number(process.env.VPN_HELPER_MAX_SESSIONS ?? 20),
    databaseUrl: process.env.DATABASE_URL,
    verifyExec,
    log,
  });

  const server = createHelperServer({ core, secret, socketPath, log });
  await listenHelper(server, socketPath);
  // Group (backend gid) may read+write the socket; owner too; world none.
  await chmod(socketPath, 0o660).catch(() => {});
  log({ socketPath, runtimeDir }, "vpn-helper listening");

  const shutdown = (sig: string) => {
    log({ sig }, "vpn-helper shutting down");
    try { core.stopAll(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => { log({ err: e instanceof Error ? e.message : String(e) }, "vpn-helper failed to start"); process.exit(1); });
