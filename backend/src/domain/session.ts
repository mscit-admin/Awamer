/**
 * Phase 2 — Session Management domain types.
 *
 * These types are the contract between the application/route layer and the
 * persistence layer. Repositories return these shapes; route handlers
 * serialize them to JSON.
 */

export const HOST_PROTOCOLS = [
  "ssh", "sftp", "rdp", "vnc", "telnet", "serial", "http", "https", "custom",
] as const;
export type HostProtocol = typeof HOST_PROTOCOLS[number];
export const isHostProtocol = (s: string): s is HostProtocol =>
  (HOST_PROTOCOLS as readonly string[]).includes(s);

/** Default port per protocol — overridable per host. */
export const DEFAULT_PORTS: Record<HostProtocol, number> = {
  ssh: 22, sftp: 22, rdp: 3389, vnc: 5900,
  telnet: 23, serial: 0, http: 80, https: 443, custom: 0,
};

export const CREDENTIAL_TYPES = [
  "password", "private_key", "certificate", "agent", "kerberos", "none",
] as const;
export type CredentialType = typeof CREDENTIAL_TYPES[number];
export const isCredentialType = (s: string): s is CredentialType =>
  (CREDENTIAL_TYPES as readonly string[]).includes(s);

export const CONNECTION_STATUSES = [
  "started", "connected", "authenticated", "closed", "failed", "timeout",
] as const;
export type ConnectionStatus = typeof CONNECTION_STATUSES[number];

// =====================================================================
// Folder
// =====================================================================

export interface Folder {
  id: string;
  userId: string;
  parentId: string | null;
  name: string;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FolderTreeNode extends Folder {
  children: FolderTreeNode[];
}

// =====================================================================
// Tag
// =====================================================================

export interface Tag {
  id: string;
  userId: string;
  name: string;
  color: string | null;
  createdAt: Date;
}

// =====================================================================
// Credential
// =====================================================================

export interface Credential {
  id: string;
  userId: string;
  name: string;
  credentialType: CredentialType;
  username: string | null;
  /**
   * Decrypted secret payload. Stored encrypted at rest (AES-256-GCM,
   * Phase 10) and transparently decrypted by CredentialRepository.
   */
  secretData: Record<string, unknown>;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Public projection — secret_data stripped. Use for list views and refs. */
export type CredentialPublic = Omit<Credential, "secretData"> & {
  hasSecret: boolean;
};

export function toCredentialPublic(c: Credential): CredentialPublic {
  return {
    id: c.id,
    userId: c.userId,
    name: c.name,
    credentialType: c.credentialType,
    username: c.username,
    description: c.description,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    hasSecret: Object.keys(c.secretData).length > 0,
  };
}

// =====================================================================
// Host
// =====================================================================

export interface Host {
  id: string;
  userId: string;
  folderId: string | null;
  credentialId: string | null;
  name: string;
  hostname: string;
  port: number;
  protocol: HostProtocol;
  description: string | null;
  isFavorite: boolean;
  options: Record<string, unknown>;
  lastUsedAt: Date | null;
  useCount: number;
  createdAt: Date;
  updatedAt: Date;
  /** Lazily populated by the host repository's `withTags` queries. */
  tags?: Tag[];
}

// =====================================================================
// Connection history
// =====================================================================

export interface ConnectionHistoryEntry {
  id: number;
  userId: string;
  hostId: string | null;
  hostNameSnapshot: string;
  hostnameSnapshot: string;
  portSnapshot: number;
  protocol: HostProtocol;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  status: ConnectionStatus;
  errorMessage: string | null;
  clientIp: string | null;
  bytesIn: number;
  bytesOut: number;
}

// =====================================================================
// Errors specific to Phase 2
// =====================================================================

import { DomainError } from "./index.js";

export const PhaseTwoErrors = {
  HostNotFound: () => new DomainError("host_not_found", "host not found"),
  HostNameTaken: () => new DomainError("host_name_taken", "a host with this name already exists"),
  FolderNotFound: () => new DomainError("folder_not_found", "folder not found"),
  FolderNameTaken: () => new DomainError("folder_name_taken", "a folder with this name already exists at the same level"),
  FolderCycle: () => new DomainError("folder_cycle", "moving folder here would create a cycle"),
  TagNotFound: () => new DomainError("tag_not_found", "tag not found"),
  TagNameTaken: () => new DomainError("tag_name_taken", "a tag with this name already exists"),
  CredentialNotFound: () => new DomainError("credential_not_found", "credential not found"),
  CredentialNameTaken: () => new DomainError("credential_name_taken", "a credential with this name already exists"),
  HistoryNotFound: () => new DomainError("history_not_found", "history entry not found"),
  InvalidProtocol: () => new DomainError("invalid_protocol", "unsupported protocol"),
} as const;
