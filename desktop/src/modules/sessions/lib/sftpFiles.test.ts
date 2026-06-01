import { describe, it, expect } from "vitest";
import {
  type RemoteEntry,
  sortAndFilterEntries,
  formatBytes,
  formatMode,
  maskMode,
  togglePermissionBit,
} from "./sftpFiles";

function entry(partial: Partial<RemoteEntry> & { name: string }): RemoteEntry {
  return {
    path: `/${partial.name}`,
    kind: "file",
    size: 0,
    mtime: 0,
    mode: 0o644,
    ...partial,
  };
}

describe("sortAndFilterEntries", () => {
  const dirB = entry({ name: "beta", kind: "dir", size: 0, mtime: 100 });
  const dirA = entry({ name: "Alpha", kind: "dir", size: 0, mtime: 200 });
  const fileBig = entry({ name: "big.log", size: 5000, mtime: 50 });
  const fileSmall = entry({ name: "small.txt", size: 10, mtime: 300 });
  const all = [fileBig, dirB, fileSmall, dirA];

  it("keeps directories grouped above files regardless of sort", () => {
    const out = sortAndFilterEntries(all, "", { key: "size", dir: "desc" });
    const kinds = out.map((e) => e.kind);
    expect(kinds).toEqual(["dir", "dir", "file", "file"]);
  });

  it("sorts by name ascending, case-insensitively", () => {
    const out = sortAndFilterEntries(all, "", { key: "name", dir: "asc" });
    expect(out.map((e) => e.name)).toEqual(["Alpha", "beta", "big.log", "small.txt"]);
  });

  it("reverses on descending direction within each group", () => {
    const out = sortAndFilterEntries(all, "", { key: "name", dir: "desc" });
    expect(out.map((e) => e.name)).toEqual(["beta", "Alpha", "small.txt", "big.log"]);
  });

  it("sorts files by size", () => {
    const out = sortAndFilterEntries(all, "", { key: "size", dir: "asc" });
    const files = out.filter((e) => e.kind === "file").map((e) => e.name);
    expect(files).toEqual(["small.txt", "big.log"]);
  });

  it("sorts by mtime", () => {
    const out = sortAndFilterEntries(all, "", { key: "mtime", dir: "asc" });
    const files = out.filter((e) => e.kind === "file").map((e) => e.name);
    expect(files).toEqual(["big.log", "small.txt"]);
  });

  it("filters by case-insensitive name substring", () => {
    const out = sortAndFilterEntries(all, "BIG", { key: "name", dir: "asc" });
    expect(out.map((e) => e.name)).toEqual(["big.log"]);
  });

  it("trims the filter and treats blank as no filter", () => {
    expect(sortAndFilterEntries(all, "   ", { key: "name", dir: "asc" })).toHaveLength(4);
  });

  it("does not mutate the input array", () => {
    const input = [...all];
    sortAndFilterEntries(input, "", { key: "size", dir: "desc" });
    expect(input).toEqual(all);
  });
});

describe("formatBytes", () => {
  it("formats across unit boundaries", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
  });
});

describe("formatMode", () => {
  it("renders common modes as rwx strings", () => {
    expect(formatMode(0o644)).toBe("rw-r--r--");
    expect(formatMode(0o755)).toBe("rwxr-xr-x");
    expect(formatMode(0o600)).toBe("rw-------");
    expect(formatMode(0o777)).toBe("rwxrwxrwx");
    expect(formatMode(0o000)).toBe("---------");
  });

  it("ignores high bits above the permission bits", () => {
    // 0o100644 = regular file (S_IFREG) + 0o644
    expect(formatMode(0o100644)).toBe("rw-r--r--");
  });
});

describe("maskMode", () => {
  it("keeps only the low 12 bits", () => {
    expect(maskMode(0o100755)).toBe(0o755);
    expect(maskMode(0o4755)).toBe(0o4755); // setuid preserved
  });
});

describe("togglePermissionBit", () => {
  it("flips a single bit for the right class", () => {
    // owner write off -> on for 0o444
    expect(togglePermissionBit(0o444, 6, 2)).toBe(0o644);
    // toggling twice returns to the original
    expect(togglePermissionBit(togglePermissionBit(0o644, 0, 1), 0, 1)).toBe(0o644);
    // group execute on 0o640 -> 0o650
    expect(togglePermissionBit(0o640, 3, 1)).toBe(0o650);
  });
});
