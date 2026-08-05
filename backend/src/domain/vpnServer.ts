/**
 * Awamer-as-OpenVPN-server — domain types + config assembly (migration 019).
 *
 * Pure builders for the two configs involved:
 *  - `assembleClientOvpn` → the unified `.ovpn` a user downloads and installs.
 *  - `assembleServerConfig` → the config the backend's openvpn server runs.
 * Both inline the PKI material; secrets are decrypted by the repository before
 * these run and never persisted here.
 */
import { DomainError } from "./index.js";

export type VpnProto = "udp" | "tcp";

export interface VpnServer {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  publicHost: string;
  port: number;
  proto: VpnProto;
  subnet: string; // CIDR, e.g. "10.8.0.0/24"
  dns: string | null;
  clientToClient: boolean;
  /** Master switch: route selected clients' traffic to the internet (NAT). */
  internetAccess: boolean;
  cipher: string;
  caCert: string;
  caKey: string;       // decrypted
  serverCert: string;
  serverKey: string;   // decrypted
  tlsCrypt: string;    // decrypted
  createdAt: Date;
  updatedAt: Date;
}

export interface VpnServerPublic {
  id: string;
  name: string;
  description: string | null;
  public_host: string;
  port: number;
  proto: VpnProto;
  subnet: string;
  dns: string | null;
  client_to_client: boolean;
  internet_access: boolean;
  cipher: string;
  ca_cert: string;
  client_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface VpnServerClient {
  id: string;
  serverId: string;
  name: string;
  username: string;
  passwordHash: string;
  password: string;  // decrypted plaintext (admin reveal / config)
  cert: string;
  key: string;       // decrypted
  revoked: boolean;
  revokedAt: Date | null;
  /** This client's traffic is full-tunnelled to the internet via the server. */
  internetAccess: boolean;
  createdAt: Date;
}

export interface VpnServerClientPublic {
  id: string;
  name: string;
  username: string;
  revoked: boolean;
  revoked_at: Date | null;
  internet_access: boolean;
  created_at: Date;
}

export function toVpnServerPublic(s: VpnServer, clientCount = 0): VpnServerPublic {
  return {
    id: s.id, name: s.name, description: s.description,
    public_host: s.publicHost, port: s.port, proto: s.proto, subnet: s.subnet,
    dns: s.dns, client_to_client: s.clientToClient, internet_access: s.internetAccess, cipher: s.cipher,
    ca_cert: s.caCert, client_count: clientCount,
    created_at: s.createdAt, updated_at: s.updatedAt,
  };
}

export function toVpnServerClientPublic(c: VpnServerClient): VpnServerClientPublic {
  return {
    id: c.id, name: c.name, username: c.username,
    revoked: c.revoked, revoked_at: c.revokedAt, internet_access: c.internetAccess, created_at: c.createdAt,
  };
}

const DATA_CIPHERS = "AES-256-GCM:AES-128-GCM";
const inline = (tag: string, pem: string) => `<${tag}>\n${pem.trim()}\n</${tag}>`;

/** Convert a CIDR ("10.8.0.0/24") to OpenVPN's `network netmask` pair. */
export function cidrToServerLine(cidr: string): string {
  const [net, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr ?? 24);
  const mask = prefix >= 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  const netmask = [(mask >>> 24) & 255, (mask >>> 16) & 255, (mask >>> 8) & 255, mask & 255].join(".");
  return `${net} ${netmask}`;
}

/** The `.ovpn` a client downloads. Credentials are NOT embedded — the cert is
 *  "something you have", the username/password (typed or in a local file) is
 *  "something you know". */
export function assembleClientOvpn(input: {
  proto: VpnProto; publicHost: string; port: number; cipher: string;
  caCert: string; clientCert: string; clientKey: string; tlsCrypt: string;
  embedCredentials?: { username: string; password: string };
}): string {
  const lines = [
    "client",
    "dev tun",
    `proto ${input.proto}`,
    `remote ${input.publicHost} ${input.port}`,
    "resolv-retry infinite",
    "nobind",
    "persist-key",
    "persist-tun",
    "remote-cert-tls server",
    `cipher ${input.cipher}`,
    `data-ciphers ${DATA_CIPHERS}`,
    "auth SHA256",
    "auth-nocache",
    input.embedCredentials ? "auth-user-pass credentials.txt" : "auth-user-pass",
    "verb 3",
    inline("ca", input.caCert),
    inline("cert", input.clientCert),
    inline("key", input.clientKey),
    inline("tls-crypt", input.tlsCrypt),
  ];
  return lines.join("\n") + "\n";
}

/** The backend openvpn server config. `verifyCommand` runs the username/password
 *  check; the caller writes the referenced files. */
export function assembleServerConfig(input: {
  port: number; proto: VpnProto; subnet: string; dns: string | null;
  clientToClient: boolean; cipher: string;
  caCert: string; serverCert: string; serverKey: string; tlsCrypt: string;
  verifyCommand: string;
  /** Directory of per-client push files (set when internet routing is on). */
  clientConfigDir?: string | null;
}): string {
  const lines = [
    `port ${input.port}`,
    `proto ${input.proto}`,
    "dev tun",
    "topology subnet",
    `server ${cidrToServerLine(input.subnet)}`,
    "keepalive 10 120",
    "persist-key",
    "persist-tun",
    "dh none",
    "tls-server",
    "remote-cert-tls client",
    `cipher ${input.cipher}`,
    `data-ciphers ${DATA_CIPHERS}`,
    "auth SHA256",
    "verify-client-cert require",
    "username-as-common-name",
    "script-security 2",
    `auth-user-pass-verify ${input.verifyCommand} via-file`,
    "verb 3",
  ];
  if (input.clientToClient) lines.push("client-to-client");
  // Per-client push files (e.g. redirect-gateway for internet-enabled clients).
  if (input.clientConfigDir) lines.push(`client-config-dir ${input.clientConfigDir}`);
  if (input.dns) lines.push(`push "dhcp-option DNS ${input.dns}"`);
  lines.push(inline("ca", input.caCert));
  lines.push(inline("cert", input.serverCert));
  lines.push(inline("key", input.serverKey));
  lines.push(inline("tls-crypt", input.tlsCrypt));
  return lines.join("\n") + "\n";
}

/**
 * Contents of a per-client `client-config-dir` file that full-tunnels the
 * client's traffic to the internet through the server (redirect-gateway). The
 * file is named after the client's common name (= username).
 */
export function clientInternetCcd(dns: string | null): string {
  const lines = ['push "redirect-gateway def1 bypass-dhcp"'];
  if (dns) lines.push(`push "dhcp-option DNS ${dns}"`);
  return lines.join("\n") + "\n";
}

export const VpnServerErrors = {
  ServerNotFound: () => new DomainError("vpn_server_not_found", "VPN server not found"),
  ServerNameTaken: () => new DomainError("vpn_server_name_taken", "a VPN server with this name already exists"),
  ClientNotFound: () => new DomainError("vpn_server_client_not_found", "VPN client not found"),
  ClientNameTaken: () => new DomainError("vpn_server_client_taken", "a client with this name or username already exists"),
  PortInUse: () => new DomainError("vpn_server_port_in_use", "that port is already used by another VPN server"),
  OpenvpnUnavailable: () => new DomainError("vpn_server_openvpn_unavailable", "the openvpn binary is not available on the server"),
  NotRunning: () => new DomainError("vpn_server_not_running", "the VPN server is not running"),
} as const;
