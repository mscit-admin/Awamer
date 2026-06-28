/** Backup / restore API — export & re-import the caller's own session data. */
import { request } from "@/shared/lib/api";

export interface BackupBundle {
  format: string;
  version: number;
  exported_at?: string;
  includes_secrets?: boolean;
  counts?: { folders: number; tags: number; credentials: number; hosts: number };
  data: unknown;
}

export interface ExportResult {
  encrypted: boolean;
  payload: unknown; // BackupBundle (plaintext) or EncryptedBackup envelope
}

export interface ImportSummary {
  folders: { created: number; skipped: number };
  tags: { created: number; skipped: number };
  credentials: { created: number; skipped: number };
  hosts: { created: number; skipped: number };
}

export const backupApi = {
  export(input: { include_secrets: boolean; passphrase?: string }) {
    return request<ExportResult>("/api/v1/backup/export", { method: "POST", body: input });
  },
  import(input: { payload: unknown; passphrase?: string; mode: "merge" | "skip" }) {
    return request<{ ok: boolean; summary: ImportSummary }>("/api/v1/backup/import", { method: "POST", body: input });
  },
};
