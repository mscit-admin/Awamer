import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// GO-LIVE traceability: bake the release identity into the bundle. Version is
// package.json; commit/build date come from CI (GIT_COMMIT / BUILD_DATE) or
// the local git checkout. Only these three non-sensitive strings are embedded.
const pkgVersion: string = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8")).version;
function gitCommit(): string {
  const fromEnv = (process.env.GIT_COMMIT ?? "").trim().toLowerCase();
  if (/^[0-9a-f]{7,40}$/.test(fromEnv)) return fromEnv;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}
const buildDate = /^\d{4}-\d{2}-\d{2}T/.test(process.env.BUILD_DATE ?? "")
  ? process.env.BUILD_DATE!
  : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// https://tauri.app/v1/guides/getting-started/setup/vite
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],

  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __GIT_COMMIT__: JSON.stringify(gitCommit()),
    __BUILD_DATE__: JSON.stringify(buildDate),
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Tauri dev server requires a fixed port
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Ignore Rust source so the Tauri CLI can manage its own rebuilds
      ignored: ["**/src-tauri/**"],
    },
  },

  envPrefix: ["VITE_", "TAURI_"],

  build: {
    // es2022 for top-level await + BigInt (used by @novnc/novnc).
    target: ["es2022", "chrome105", "safari15"],
    minify: process.env.TAURI_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_DEBUG,
  },
}));
