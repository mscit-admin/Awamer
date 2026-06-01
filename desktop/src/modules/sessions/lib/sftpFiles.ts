// =====================================================================
// Pure helpers for the SFTP browser.
//
// Extracted from SftpPage so the listing logic (sort/filter), the byte
// and mode formatters, and the chmod bit math can be unit-tested without
// mounting the React component or a Tauri runtime.
// =====================================================================

export interface RemoteEntry {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink" | "other";
  size: number;
  mtime: number;
  mode: number;
}

export type SortKey = "name" | "size" | "mtime";
export interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

/**
 * Filter a listing by a case-insensitive name substring, then sort by the
 * chosen column. Directories are always grouped above files regardless of
 * sort direction (the column sort applies *within* each group). Returns a
 * new array; the input is not mutated.
 */
export function sortAndFilterEntries(
  entries: RemoteEntry[],
  filter: string,
  sort: SortState,
): RemoteEntry[] {
  const needle = filter.trim().toLowerCase();
  return entries
    .filter((e) => needle === "" || e.name.toLowerCase().includes(needle))
    .slice()
    .sort((a, b) => {
      if (a.kind === "dir" && b.kind !== "dir") return -1;
      if (a.kind !== "dir" && b.kind === "dir") return 1;
      let cmp: number;
      if (sort.key === "size") cmp = a.size - b.size;
      else if (sort.key === "mtime") cmp = a.mtime - b.mtime;
      else cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      return sort.dir === "asc" ? cmp : -cmp;
    });
}

/** Human-readable byte size (B / KB / MB / GB). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Render the low 9 permission bits as an `rwxr-xr-x`-style string. */
export function formatMode(mode: number): string {
  const perms = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];
  const owner = perms[(mode >> 6) & 0b111];
  const group = perms[(mode >> 3) & 0b111];
  const other = perms[mode & 0b111];
  return `${owner}${group}${other}`;
}

/** The permission/setuid/setgid/sticky bits a chmod is allowed to touch. */
export function maskMode(mode: number): number {
  return mode & 0o7777;
}

/**
 * Flip a single permission bit. `shift` selects the class (6 = owner,
 * 3 = group, 0 = others); `bit` is the action (4 = read, 2 = write,
 * 1 = execute).
 */
export function togglePermissionBit(mode: number, shift: number, bit: number): number {
  return mode ^ (bit << shift);
}
