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
  /** Internet policy: route clients through the server; allowed clients are
   *  NATed to the internet, the others reach only the VPN subnet. */
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
  /** May reach the internet through the server (when the server's policy is on). */
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

/**
 * SEC-VPN-CFG-001 — the ONLY data ciphers a server may be configured with
 * (mirrors DATA_CIPHERS and the UI's choices). A strict allowlist, not a
 * sanitiser: the value is interpolated into an OpenVPN config that runs with
 * `script-security 2` inside the root, host-network vpn-helper, so a newline in
 * it (e.g. `AES-256-GCM\nup "/bin/sh -c …"`) was a root command injection.
 */
export const VPN_SERVER_CIPHERS = ["AES-256-GCM", "AES-128-GCM"] as const;
export type VpnServerCipher = (typeof VPN_SERVER_CIPHERS)[number];
export function isVpnServerCipher(s: unknown): s is VpnServerCipher {
  return typeof s === "string" && (VPN_SERVER_CIPHERS as readonly string[]).includes(s);
}

const CFG_HOST_RE = /^[A-Za-z0-9._:-]{1,253}$/;
const CFG_CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

/**
 * SEC-VPN-CFG-001 — defence in depth at the single point where structured
 * values become OpenVPN config text. Runs in BOTH the backend (client .ovpn)
 * and the vpn-helper (server.conf), so a value that bypassed API validation
 * (or was stored before it existed) can never inject a directive.
 */
function assertSafeConfigScalars(v: {
  cipher: string; proto: string; port: number; subnet?: string; dns?: string | null; publicHost?: string;
}): void {
  const bad = (what: string) => new DomainError("vpn_invalid_config", `invalid VPN ${what}`);
  if (!isVpnServerCipher(v.cipher)) throw bad("cipher");
  if (v.proto !== "udp" && v.proto !== "tcp") throw bad("protocol");
  if (!Number.isInteger(v.port) || v.port < 1 || v.port > 65535) throw bad("port");
  if (v.subnet !== undefined && !CFG_CIDR_RE.test(v.subnet)) throw bad("subnet");
  if (v.dns != null && !CFG_HOST_RE.test(v.dns)) throw bad("DNS server");
  if (v.publicHost !== undefined && !CFG_HOST_RE.test(v.publicHost)) throw bad("public host");
}

function maskInt(prefix: number): number {
  return prefix <= 0 ? 0 : prefix >= 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
}
function ipToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return (((p[0] ?? 0) << 24) | ((p[1] ?? 0) << 16) | ((p[2] ?? 0) << 8) | (p[3] ?? 0)) >>> 0;
}
function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** Netmask (dotted) for a CIDR, e.g. "10.8.0.0/24" → "255.255.255.0". */
export function cidrNetmask(cidr: string): string {
  return intToIp(maskInt(Number(cidr.split("/")[1] ?? 24)));
}

/** Convert a CIDR ("10.8.0.0/24") to OpenVPN's `network netmask` pair. */
export function cidrToServerLine(cidr: string): string {
  const [net] = cidr.split("/");
  return `${net} ${cidrNetmask(cidr)}`;
}

/**
 * VPN client usernames double as certificate CNs and as per-client file names
 * in the server's client-config-dir, so they are restricted to a safe set and
 * may not be "." or "..".
 */
const VPN_USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export function isSafeVpnUsername(u: unknown): u is string {
  return typeof u === "string" && VPN_USERNAME_RE.test(u) && u !== "." && u !== "..";
}

/**
 * Give each client a fixed VPN address so the server firewall can tell them
 * apart. The server holds host .1; clients get .2, .3, … in sorted-username
 * order, so a restart keeps the mapping. Clients beyond the subnet's capacity
 * get no address (and, with `ccd-exclusive`, cannot connect).
 */
export function assignClientIps(cidr: string, usernames: string[]): Map<string, string> {
  const [net, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr ?? 24);
  const netInt = ipToInt(net ?? "0.0.0.0") & maskInt(prefix);
  const usableHosts = prefix >= 31 ? 0 : 2 ** (32 - prefix) - 2;
  const map = new Map<string, string>();
  let host = 2; // .1 is the server
  for (const u of [...new Set(usernames)].sort()) {
    if (host > usableHosts) break;
    map.set(u, intToIp(netInt + host));
    host += 1;
  }
  return map;
}

/** Per-client client-config-dir file pinning a fixed VPN address (topology subnet). */
export function clientIpCcd(ip: string, netmask: string): string {
  return `ifconfig-push ${ip} ${netmask}\n`;
}

export interface FirewallSpec { table?: "nat"; chain: string; rule: string[] }

/**
 * iptables rules (argv without the -A/-D flag) for the internet policy:
 * everyone reaches the VPN subnet, blocked clients' internet-bound traffic is
 * dropped, allowed clients are NATed out. Every rule carries the `tag` comment
 * so it can be removed exactly later without touching anyone else's rules.
 * Order matters: the per-client DROPs precede the general internet ACCEPT.
 */
export function internetFirewallSpecs(subnet: string, blockedIps: string[], tag: string): FirewallSpec[] {
  const c = ["-m", "comment", "--comment", tag];
  const specs: FirewallSpec[] = [
    { chain: "FORWARD", rule: ["-s", subnet, "-d", subnet, ...c, "-j", "ACCEPT"] },
    { chain: "FORWARD", rule: ["-d", subnet, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", ...c, "-j", "ACCEPT"] },
  ];
  for (const ip of blockedIps) {
    specs.push({ chain: "FORWARD", rule: ["-s", `${ip}/32`, "!", "-d", subnet, ...c, "-j", "DROP"] });
  }
  specs.push({ chain: "FORWARD", rule: ["-s", subnet, "!", "-d", subnet, ...c, "-j", "ACCEPT"] });
  specs.push({ table: "nat", chain: "POSTROUTING", rule: ["-s", subnet, "!", "-d", subnet, ...c, "-j", "MASQUERADE"] });
  return specs;
}

/** The `.ovpn` a client downloads. Credentials are NOT embedded — the cert is
 *  "something you have", the username/password (typed or in a local file) is
 *  "something you know". */
export function assembleClientOvpn(input: {
  proto: VpnProto; publicHost: string; port: number; cipher: string;
  caCert: string; clientCert: string; clientKey: string; tlsCrypt: string;
  embedCredentials?: { username: string; password: string };
}): string {
  assertSafeConfigScalars({ cipher: input.cipher, proto: input.proto, port: input.port, publicHost: input.publicHost });
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
  /** Directory of per-client files (fixed addresses) when the internet policy is on. */
  clientConfigDir?: string | null;
  /** Internet policy: push the default route to every client; the server
   *  firewall then lets allowed clients out and blocks the rest. */
  internetPolicy?: boolean;
}): string {
  assertSafeConfigScalars({ cipher: input.cipher, proto: input.proto, port: input.port, subnet: input.subnet, dns: input.dns });
  if (input.clientConfigDir != null && !/^\/[A-Za-z0-9._/-]{1,240}$/.test(input.clientConfigDir)) {
    throw new DomainError("vpn_invalid_config", "invalid VPN client-config-dir");
  }
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
  if (input.clientConfigDir) {
    // Every client must have a file (= a fixed address the firewall knows);
    // one without a file is refused rather than given a pool address that
    // could match another client's rule.
    lines.push(`client-config-dir ${input.clientConfigDir}`, "ccd-exclusive");
  }
  if (input.internetPolicy) lines.push('push "redirect-gateway def1 bypass-dhcp"');
  if (input.dns) lines.push(`push "dhcp-option DNS ${input.dns}"`);
  lines.push(inline("ca", input.caCert));
  lines.push(inline("cert", input.serverCert));
  lines.push(inline("key", input.serverKey));
  lines.push(inline("tls-crypt", input.tlsCrypt));
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
