/**
 * Client-side export of the admin user list. Builds a CSV or JSON file from the
 * already-loaded accounts and triggers a browser download. No secrets are
 * included — only the fields the admin list API returns.
 */
import type { AdminUser } from "./usersAdminApi";

const COLUMNS: { key: keyof AdminUser; label: string }[] = [
  { key: "username", label: "username" },
  { key: "email", label: "email" },
  { key: "full_name", label: "full_name" },
  { key: "role", label: "role" },
  { key: "is_active", label: "is_active" },
  { key: "is_locked", label: "is_locked" },
  { key: "mfa_enabled", label: "mfa_enabled" },
  { key: "last_login_at", label: "last_login_at" },
  { key: "created_at", label: "created_at" },
  { key: "id", label: "id" },
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Quote if it contains a comma, quote, or newline; escape embedded quotes.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function timestamp(): string {
  // YYYYMMDD-HHMMSS in local time, filename-safe.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportUsersCsv(users: AdminUser[]): void {
  const header = COLUMNS.map((c) => c.label).join(",");
  const rows = users.map((u) => COLUMNS.map((c) => csvCell(u[c.key])).join(","));
  // Prepend a UTF-8 BOM so Excel opens it with correct encoding.
  download(`awamer-users-${timestamp()}.csv`, "﻿" + [header, ...rows].join("\r\n"), "text/csv;charset=utf-8");
}

export function exportUsersJson(users: AdminUser[]): void {
  const data = users.map((u) => Object.fromEntries(COLUMNS.map((c) => [c.label, u[c.key]])));
  download(`awamer-users-${timestamp()}.json`, JSON.stringify(data, null, 2), "application/json");
}
