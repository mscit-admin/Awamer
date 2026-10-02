#!/usr/bin/env node
/**
 * GO-LIVE release-consistency gate. Every first-party release declaration must
 * carry the SAME version (and, when given, equal the expected one, e.g. the
 * git tag without its "v"). Exits 1 listing every mismatch. Third-party
 * dependency versions are never inspected.
 *
 *   node scripts/check-release-version.mjs            # all must agree
 *   node scripts/check-release-version.mjs 1.8.0      # ...and equal 1.8.0
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const json = (p) => JSON.parse(read(p));
const match = (p, re) => (read(p).match(re) ?? [])[1] ?? "<missing>";

const sources = {
  "backend/package.json": json("backend/package.json").version,
  "backend/package-lock.json (root)": json("backend/package-lock.json").packages[""].version,
  "desktop/package.json": json("desktop/package.json").version,
  "desktop/package-lock.json (root)": json("desktop/package-lock.json").packages[""].version,
  "desktop/src-tauri/tauri.conf.json": json("desktop/src-tauri/tauri.conf.json").version,
  "desktop/src-tauri/Cargo.toml": match("desktop/src-tauri/Cargo.toml", /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m),
  "desktop/src-tauri/Cargo.lock (netsphere-terminal)": match("desktop/src-tauri/Cargo.lock", /name = "netsphere-terminal"\nversion = "([^"]+)"/),
  "deploy/scripts/generate-secrets.sh (APP_VERSION)": match("deploy/scripts/generate-secrets.sh", /^APP_VERSION=(\S+)/m),
  "deploy/.env.production.example (APP_VERSION)": match("deploy/.env.production.example", /^APP_VERSION=(\S+)/m),
};

const expected = (process.argv[2] ?? "").replace(/^v/, "") || sources["backend/package.json"];
let bad = 0;
for (const [src, v] of Object.entries(sources)) {
  const ok = v === expected;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${src.padEnd(52)} ${v}`);
}
if (bad) {
  console.error(`\nrelease version mismatch: ${bad} declaration(s) differ from ${expected}`);
  process.exit(1);
}
console.log(`\nrelease version consistent: ${expected}`);
