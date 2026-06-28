import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// https://tauri.app/v1/guides/getting-started/setup/vite
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],

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
