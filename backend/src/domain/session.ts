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
  /** Optional VPN profile applied to every asset under this folder (017). */
  vpnProfileId: string | null;
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
// Credential + custom fields (vault, Phase 1)
// =====================================================================

/**
 * A KeePass-style advanced field on a credential. `value` is decrypted at the
 * persistence boundary (same AES-256-GCM envelope as `secretData`). When
 * `isSecret` is true the value is masked in the UI and withheld from the
 * public (non-reveal) projection.
 */
export interface CredentialField {
  id: string;
  label: string;
  value: string;
  isSecret: boolean;
  sortOrder: number;
}

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
  /** Vault (Phase 1): folder placement, favorite flag, expiry. */
  folderId: string | null;
  favorite: boolean;
  expiresAt: Date | null;
  /** Custom fields; populated by the repository alongside the row. */
  fields: CredentialField[];
  /** Vault (Phase 2/3) presence flags, populated by the repository. */
  hasTotp: boolean;
  attachmentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// ---- TOTP + attachments (vault Phase 2/3) ---------------------------

export const TOTP_ALGORITHMS = ["SHA1", "SHA256", "SHA512"] as const;
export type TotpAlgorithm = typeof TOTP_ALGORITHMS[number];
export const isTotpAlgorithm = (s: string): s is TotpAlgorithm =>
  (TOTP_ALGORITHMS as readonly string[]).includes(s);

/** Non-secret TOTP configuration returned to the client. */
export interface CredentialTotpConfig {
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  updatedAt: Date;
}

/** Attachment metadata (never includes the blob bytes). */
export interface CredentialAttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
}

export function serializeAttachmentMeta(a: CredentialAttachmentMeta) {
  return {
    id: a.id,
    filename: a.filename,
    mime_type: a.mimeType,
    size_bytes: a.sizeBytes,
    sha256: a.sha256,
    created_at: a.createdAt,
  };
}

/** Public projection of a custom field — secret values withheld unless revealing. */
export interface CredentialFieldPublic {
  id: string;
  label: string;
  isSecret: boolean;
  sortOrder: number;
  hasValue: boolean;
  /** Present for non-secret fields always, and for secret fields only on reveal. */
  value?: string;
}

export function toCredentialFieldPublic(f: CredentialField, reveal: boolean): CredentialFieldPublic {
  const out: CredentialFieldPublic = {
    id: f.id,
    label: f.label,
    isSecret: f.isSecret,
    sortOrder: f.sortOrder,
    hasValue: f.value.length > 0,
  };
  if (reveal || !f.isSecret) out.value = f.value;
  return out;
}

/** Public projection — secret_data stripped. Use for list views and refs. */
export type CredentialPublic = Omit<Credential, "secretData" | "fields"> & {
  hasSecret: boolean;
  fields: CredentialFieldPublic[];
};

export function toCredentialPublic(c: Credential, reveal = false): CredentialPublic {
  return {
    id: c.id,
    userId: c.userId,
    name: c.name,
    credentialType: c.credentialType,
    username: c.username,
    description: c.description,
    folderId: c.folderId,
    favorite: c.favorite,
    expiresAt: c.expiresAt,
    hasTotp: c.hasTotp,
    attachmentCount: c.attachmentCount,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    hasSecret: Object.keys(c.secretData).length > 0,
    fields: c.fields.map((f) => toCredentialFieldPublic(f, reveal)),
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
  /** When true, visible & connectable by all users; editable only by owner. */
  isShared: boolean;
  /** Optional VPN profile that must be up to reach this asset (017). */
  vpnProfileId: string | null;
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
  TotpNotFound: () => new DomainError("totp_not_found", "no OTP is configured on this credential"),
  InvalidTotpSecret: () => new DomainError("invalid_totp_secret", "the OTP secret is not valid base32"),
  AttachmentNotFound: () => new DomainError("attachment_not_found", "attachment not found"),
  AttachmentTooLarge: () => new DomainError("attachment_too_large", "attachment exceeds the maximum size"),
  HistoryNotFound: () => new DomainError("history_not_found", "history entry not found"),
  InvalidProtocol: () => new DomainError("invalid_protocol", "unsupported protocol"),
} as const;
