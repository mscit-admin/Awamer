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
export const isVpnRuntime = (s: string): s is VpnRuntime =>
  (VPN_RUNTIMES as readonly string[]).includes(s);

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
 * Assemble a launchable OpenVPN config from a profile. Config-source profiles
 * return their stored .ovpn verbatim; manual profiles are synthesized from the
 * remote + inline material. Inline auth (username/password) is delivered
 * separately (an `auth-user-pass` file) rather than embedded here.
 */
export function assembleOvpnConfig(p: VpnProfile): string {
  if (p.source === "config") {
    const cfg = (p.secret.ovpn ?? "").trim();
    // Ensure userpass profiles prompt via the management-supplied auth file.
    if (p.authMode === "userpass" && !/^\s*auth-user-pass/m.test(cfg)) {
      return `${cfg}\nauth-user-pass\n`;
    }
    return `${cfg}\n`;
  }

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
  return `${lines.join("\n")}\n`;
}

export const VpnErrors = {
  ProfileNotFound: () => new DomainError("vpn_profile_not_found", "VPN profile not found"),
  ProfileNameTaken: () => new DomainError("vpn_profile_name_taken", "a VPN profile with this name already exists"),
  ConfigMissing: () => new DomainError("vpn_config_missing", "profile has no launchable OpenVPN configuration"),
  ConnectionNotFound: () => new DomainError("vpn_connection_not_found", "VPN connection not found"),
  TooManyConnections: () => new DomainError("vpn_too_many", "backend VPN connection limit reached"),
  BackendOnly: () => new DomainError("vpn_backend_only", "this endpoint manages backend-runtime VPN connections only"),
  OpenvpnUnavailable: () => new DomainError("vpn_openvpn_unavailable", "the openvpn binary is not available on the server"),
} as const;
