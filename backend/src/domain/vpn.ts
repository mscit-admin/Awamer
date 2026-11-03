/**
 * OpenVPN client profiles — domain types (migration 017).
 *
 * A profile bundles the material needed to bring up one OpenVPN tunnel. Secret
 * parts (config text, inline CA/cert/key, auth username/password) live in
 * `secret` and are encrypted at rest by the repository; the public projection
 * (`VpnProfilePublic`) never carries them.
 */
import { DomainError } from "./index.js";

export const VPN_RUNTIMES = ["desktop", "backend"] as const;
export type VpnRuntime = typeof VPN_RUNTIMES[number];

export const VPN_SOURCES = ["config", "manual"] as const;
export type VpnSource = typeof VPN_SOURCES[number];

export const VPN_PROTOS = ["udp", "tcp"] as const;
export type VpnProto = typeof VPN_PROTOS[number];

export const VPN_AUTH_MODES = ["none", "userpass"] as const;
export type VpnAuthMode = typeof VPN_AUTH_MODES[number];

/** Secret material for a profile. Stored encrypted; decrypted at the boundary. */
export interface VpnSecret {
  /** Full .ovpn config text (source = "config"). */
  ovpn?: string;
  /** Inline CA / client cert / client key / tls-auth (PEM), used by manual mode. */
  ca?: string;
  cert?: string;
  key?: string;
  tlsAuth?: string;
  /** auth-user-pass credentials (auth_mode = "userpass"). */
  username?: string;
  password?: string;
}

export interface VpnProfile {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  runtime: VpnRuntime;
  source: VpnSource;
  remoteHost: string | null;
  remotePort: number | null;
  proto: VpnProto;
  authMode: VpnAuthMode;
  autoConnect: boolean;
  /** Decrypted secret payload — present only on repository reads. */
  secret: VpnSecret;
  createdAt: Date;
  updatedAt: Date;
}

/** List/detail projection with secrets stripped — only presence flags remain. */
export interface VpnProfilePublic {
  id: string;
  name: string;
  description: string | null;
  runtime: VpnRuntime;
  source: VpnSource;
  remote_host: string | null;
  remote_port: number | null;
  proto: VpnProto;
  auth_mode: VpnAuthMode;
  auto_connect: boolean;
  has_config: boolean;
  has_ca: boolean;
  has_cert: boolean;
  has_key: boolean;
  has_tls_auth: boolean;
  has_username: boolean;
  has_password: boolean;
  created_at: Date;
  updated_at: Date;
}

const nonEmpty = (v: string | undefined): boolean => typeof v === "string" && v.length > 0;

export function toVpnProfilePublic(p: VpnProfile): VpnProfilePublic {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    runtime: p.runtime,
    source: p.source,
    remote_host: p.remoteHost,
    remote_port: p.remotePort,
    proto: p.proto,
    auth_mode: p.authMode,
    auto_connect: p.autoConnect,
    has_config: nonEmpty(p.secret.ovpn),
    has_ca: nonEmpty(p.secret.ca),
    has_cert: nonEmpty(p.secret.cert),
    has_key: nonEmpty(p.secret.key),
    has_tls_auth: nonEmpty(p.secret.tlsAuth),
    has_username: nonEmpty(p.secret.username),
    has_password: nonEmpty(p.secret.password),
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

/**
 * OpenVPN config directives that run an external program or relax the script
 * sandbox. A stored profile config is attacker-controlled data, so allowing any
 * of these turns "launch my VPN" into arbitrary command execution on whichever
 * host runs openvpn (the backend server for backend-runtime profiles). They are
 * rejected outright; interface setup still works via openvpn's built-in `ip`
 * handling with `--script-security 1`.
 */
const DENIED_OVPN_DIRECTIVES = new Set([
  "up", "down", "route-up", "route-pre-down", "ipchange", "tls-verify",
  "tls-crypt-v2-verify", "auth-user-pass-verify", "client-connect",
  "client-disconnect", "learn-address", "plugin", "script-security",
  "setenv-safe", "iproute", "cd", "chroot", "up-restart", "route-noexec",
  // SEC-OVPN-FILE-001: the config runs as root in the HOST-network vpn-helper.
  // Deny directives that read/write arbitrary files, open a control channel,
  // include other configs, or hijack the host's default route.
  "management", "management-client", "management-client-user", "management-client-group",
  "management-hold", "management-query-passwords", "management-query-proxy",
  "management-query-remote", "management-signal", "management-forget-disconnect",
  "management-up-down", "management-client-auth", "management-client-pf", "management-external-key",
  "management-external-cert", "management-log-cache",
  "log", "log-append", "writepid", "status", "replay-persist", "ifconfig-pool-persist",
  "config", "askpass", "daemon", "tmp-dir", "redirect-gateway", "redirect-private",
  "auth-gen-token-secret", "http-proxy-user-pass",
]);

/**
 * SEC-OVPN-FILE-001 — directives that may take EITHER an inline `<tag>` block
 * OR a filesystem path. The helper writes only `client.ovpn` (plus its own
 * auth file), so a legitimate profile can only use the inline form; a path
 * argument is an attempt to read a local file as root (e.g.
 * `auth-user-pass /proc/self/environ` would send the helper's environment —
 * DATABASE_URL, VPN_HELPER_SECRET — to the attacker's VPN server as the
 * "username"). Bare `auth-user-pass` (prompt via the helper's file) stays OK,
 * and `[inline]` is the explicit inline marker.
 */
const FILE_ARG_DIRECTIVES = new Set([
  "auth-user-pass", "ca", "cert", "key", "tls-auth", "tls-crypt", "tls-crypt-v2",
  "secret", "pkcs12", "dh", "crl-verify", "extra-certs", "capath", "http-proxy",
]);

/**
 * Reject a config that contains any command-executing / sandbox-relaxing
 * directive. Runs on the fully-assembled config (comments stripped), so an
 * injection smuggled in via a manual profile's inline PEM field — e.g. a cert
 * that closes its `</ca>` block early and adds an `up` line — is caught too.
 * Throws VpnErrors.UnsafeConfig on the first offending directive.
 */
export function assertSafeOvpnConfig(config: string): void {
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.replace(/[#;].*$/, "").trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const directive = parts[0]!.toLowerCase().replace(/^-+/, "");
    if (DENIED_OVPN_DIRECTIVES.has(directive)) {
      throw VpnErrors.UnsafeConfig(directive);
    }
    if (FILE_ARG_DIRECTIVES.has(directive) && parts.length > 1) {
      const arg = parts[1]!;
      // `http-proxy host port [authfile]` — only a 4th token is a file.
      const fileArg = directive === "http-proxy" ? parts[3] : arg;
      if (fileArg !== undefined && fileArg !== "[inline]" && !/^\d+$/.test(fileArg)) {
        throw VpnErrors.UnsafeConfig(directive);
      }
    }
  }
}

/**
 * Assemble a launchable OpenVPN config from a profile. Config-source profiles
 * return their stored .ovpn verbatim; manual profiles are synthesized from the
 * remote + inline material. Inline auth (username/password) is delivered
 * separately (an `auth-user-pass` file) rather than embedded here. The result
 * is validated by `assertSafeOvpnConfig` before being returned to any caller.
 */
export function assembleOvpnConfig(p: VpnProfile): string {
  let config: string;
  if (p.source === "config") {
    const cfg = (p.secret.ovpn ?? "").trim();
    // Ensure userpass profiles prompt via the management-supplied auth file.
    config = p.authMode === "userpass" && !/^\s*auth-user-pass/m.test(cfg)
      ? `${cfg}\nauth-user-pass\n`
      : `${cfg}\n`;
  } else {
    // Manual: build a minimal client config.
    const lines: string[] = ["client", "dev tun", "nobind", "resolv-retry infinite", "persist-key", "persist-tun"];
    lines.push(`proto ${p.proto}`);
    if (p.remoteHost) lines.push(`remote ${p.remoteHost} ${p.remotePort ?? 1194}`);
    if (p.authMode === "userpass") lines.push("auth-user-pass");
    const inlineBlock = (tag: string, pem: string | undefined): string[] =>
      nonEmpty(pem) ? [`<${tag}>`, (pem as string).trim(), `</${tag}>`] : [];
    lines.push(...inlineBlock("ca", p.secret.ca));
    lines.push(...inlineBlock("cert", p.secret.cert));
    lines.push(...inlineBlock("key", p.secret.key));
    lines.push(...inlineBlock("tls-auth", p.secret.tlsAuth));
    config = `${lines.join("\n")}\n`;
  }
  assertSafeOvpnConfig(config);
  return config;
}

export const VpnErrors = {
  ProfileNotFound: () => new DomainError("vpn_profile_not_found", "VPN profile not found"),
  ProfileNameTaken: () => new DomainError("vpn_profile_name_taken", "a VPN profile with this name already exists"),
  ConfigMissing: () => new DomainError("vpn_config_missing", "profile has no launchable OpenVPN configuration"),
  UnsafeConfig: (directive: string) => new DomainError("vpn_unsafe_config", `OpenVPN config contains a disallowed directive: "${directive}"`),
  ConnectionNotFound: () => new DomainError("vpn_connection_not_found", "VPN connection not found"),
  TooManyConnections: () => new DomainError("vpn_too_many", "backend VPN connection limit reached"),
  BackendOnly: () => new DomainError("vpn_backend_only", "this endpoint manages backend-runtime VPN connections only"),
  OpenvpnUnavailable: () => new DomainError("vpn_openvpn_unavailable", "the openvpn binary is not available on the server"),
} as const;
