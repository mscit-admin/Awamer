import { describe, it, expect } from "vitest";
import { cleanupLegacyBrowserAuth } from "./keyring";

// SEC-019A — legacy browser refresh-token cleanup.

function fakeStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, v); },
  } as Storage;
}

describe("cleanupLegacyBrowserAuth", () => {
  it("BROWSER-LEGACY-001: removes the legacy refresh token but keeps unrelated preferences", () => {
    const store = fakeStorage({ "netsphere.refresh_token": "OLD_SECRET", "netsphere.lock": "{}" });
    cleanupLegacyBrowserAuth({ storage: store, tauri: false });
    expect(store.getItem("netsphere.refresh_token")).toBeNull();
    expect(store.getItem("netsphere.lock")).toBe("{}"); // preference preserved
  });

  it("is a no-op under Tauri (keyring storage must not be touched)", () => {
    const store = fakeStorage({ "netsphere.refresh_token": "OLD_SECRET" });
    cleanupLegacyBrowserAuth({ storage: store, tauri: true });
    expect(store.getItem("netsphere.refresh_token")).toBe("OLD_SECRET");
  });

  it("is safe when storage is unavailable", () => {
    expect(() => cleanupLegacyBrowserAuth({ storage: null, tauri: false })).not.toThrow();
  });
});
