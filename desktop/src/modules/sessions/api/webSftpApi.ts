/**
 * Web SFTP API client — talks to the backend SFTP gateway (REST,
 * session-based). Used by WebSftpPage when running in the browser.
 */
import { request } from "@/shared/lib/api";
import type { RemoteEntry } from "../lib/sftpFiles";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

export interface SftpConnectResult {
  session_id: string;
  initial_path: string;
}

export const webSftpApi = {
  connect(hostId: string, password?: string, passphrase?: string) {
    return request<SftpConnectResult>("/api/v1/sftp/connect", {
      method: "POST",
      body: { host_id: hostId, password, passphrase },
    });
  },

  list(sessionId: string, path: string) {
    return request<{ entries: RemoteEntry[] }>(
      `/api/v1/sftp/list?session_id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`,
    );
  },

  read(sessionId: string, path: string) {
    return request<{ content: string; truncated: boolean }>(
      `/api/v1/sftp/read?session_id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`,
    );
  },

  write(sessionId: string, path: string, content: string) {
    return request<{ status: string }>("/api/v1/sftp/write", {
      method: "POST",
      body: { session_id: sessionId, path, content },
    });
  },

  mkdir(sessionId: string, path: string) {
    return request<{ status: string }>("/api/v1/sftp/mkdir", {
      method: "POST",
      body: { session_id: sessionId, path },
    });
  },

  rename(sessionId: string, from: string, to: string) {
    return request<{ status: string }>("/api/v1/sftp/rename", {
      method: "POST",
      body: { session_id: sessionId, from, to },
    });
  },

  remove(sessionId: string, path: string, isDir: boolean) {
    return request<{ status: string }>("/api/v1/sftp/delete", {
      method: "POST",
      body: { session_id: sessionId, path, is_dir: isDir },
    });
  },

  upload(sessionId: string, path: string, contentBase64: string) {
    return request<{ status: string; bytes: number }>("/api/v1/sftp/upload", {
      method: "POST",
      body: { session_id: sessionId, path, content_base64: contentBase64 },
    });
  },

  disconnect(sessionId: string) {
    return request<{ status: string }>("/api/v1/sftp/disconnect", {
      method: "POST",
      body: { session_id: sessionId },
    }).catch(() => undefined);
  },

  /** Authenticated binary download → triggers a browser save. */
  async download(sessionId: string, path: string, token: string): Promise<void> {
    const url = `${API_BASE_URL}/api/v1/sftp/download?session_id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = path.split("/").pop() || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
  },
};
