/**
 * Release identity (GO-LIVE traceability).
 *
 * `version` is read from the backend package.json (the single source of truth
 * for the release number); `commit` / `buildDate` are baked into the image at
 * build time (Docker build args GIT_COMMIT / BUILD_DATE → env). Values are
 * format-checked so nothing but a version string, a hex commit id and an ISO
 * timestamp can ever be exposed — no paths, env, or infrastructure details.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ReleaseInfo {
  version: string;
  commit: string;
  buildDate: string;
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function readPackageVersion(): string {
  // src/version.ts (tsx) and dist/version.js (prod) both sit one level below
  // the package root, where package.json lives (the image copies it to /app).
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && SEMVER_RE.test(pkg.version) ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function sanitizeRelease(raw: { version?: string; commit?: string; buildDate?: string }): ReleaseInfo {
  const commit = (raw.commit ?? "").trim().toLowerCase();
  const buildDate = (raw.buildDate ?? "").trim();
  return {
    version: raw.version && SEMVER_RE.test(raw.version) ? raw.version : "unknown",
    commit: COMMIT_RE.test(commit) ? commit : "unknown",
    buildDate: DATE_RE.test(buildDate) ? buildDate : "unknown",
  };
}

export const RELEASE: ReleaseInfo = sanitizeRelease({
  version: readPackageVersion(),
  commit: process.env.GIT_COMMIT,
  buildDate: process.env.BUILD_DATE,
});
