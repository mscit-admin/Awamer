# Release Version Matrix

Assessment date: 2026-10-02 · Baseline commit assessed: `8a8fb5b6949ebcc7143e636f81a1e9c6fe64c233`
(remediation is on branch `claude/determined-fermat-zf9h5p`; see `FINAL_SECURITY_ASSESSMENT.md`).

All values were read from the current files, not from earlier reports.

## Version consistency matrix

| Component | Version | Source |
|---|---|---|
| Backend (npm package) | **1.8.0** | `backend/package.json:3`, `backend/package-lock.json` (root) |
| API (OpenAPI document) | **1.8.0** | `backend/src/server.ts` (`info.version` of the Swagger registration) |
| API runtime (`/healthz`, `/readyz`) | *(no version reported)* | `backend/src/server.ts` (returns `{status}` only) |
| Frontend (npm package) | **1.7.0** | `desktop/package.json:4`, `desktop/package-lock.json` (root) |
| Desktop (Tauri config) | **1.7.0** | `desktop/src-tauri/tauri.conf.json:4` |
| Desktop (Rust crate) | **1.7.0** | `desktop/src-tauri/Cargo.toml:3`, `Cargo.lock` (`netsphere-terminal`) |
| Frontend "About → Version" display | **1.0.0** (hard-coded) | `desktop/src/modules/settings/SettingsPage.tsx` (`<Row label="Version" value="1.0.0">`) |
| Docker image tag (production compose) | **was `${APP_VERSION:-1.6.0.1}`** → now **`${APP_VERSION:?…}` (mandatory)** | `deploy/docker-compose.production.yml` (auth-service, vpn-helper) |
| Docker `APP_VERSION` written by installer | **1.8.0** | `deploy/scripts/generate-secrets.sh:78` |
| Docker `APP_VERSION` in env template | **1.8.0** | `deploy/.env.production.example` |
| README headline | **v1.7.0** (install text references `netsphere-1.6.0.1.tar.gz`) | `README.md:1`, `README.md:15` |
| Latest RELEASE_NOTES entry | **1.7.0** | `RELEASE_NOTES.md:8` |
| CHANGELOG | only `[Unreleased]` sections since 1.7.0 | `CHANGELOG.md` |

## Findings

1. **Inconsistent.** There is no single traceable release. The server is 1.8.0, while the
   desktop/Tauri client is 1.7.0. The UI "About" panel says 1.0.0, and the README says v1.7.0.
2. **Stale implicit Docker tag (fixed).** If `APP_VERSION` was missing from
   `.env.production`, compose silently tagged both images `1.6.0.1`, a version two
   releases old. The images were built from current source, so the label would have been
   misleading, and a cached/registry `1.6.0.1` image could have been run instead. The variable
   is now **required** (`${APP_VERSION:?…}`), which matches how the file already treats every
   other mandatory variable. The installer already writes it, so the shipped install path is unaffected.
3. **No version endpoint.** Operators cannot confirm which build is running from the API.

## What was deliberately NOT changed

Release intent can't be determined from the repository. The backend has 1.8.0-only
features, the desktop was never bumped, and the CHANGELOG has only `[Unreleased]` sections.
So no version number was changed here, in line with the assessment rules.

## Recommended release procedure

1. Decide the release number. Recommendation: **1.8.0** for the whole product, because the
   backend, installer and env template already use it, or **1.8.1** if this security
   closure ships as its own release.
2. Bump it everywhere in **one** commit: `backend/package.json` (+lock root),
   `desktop/package.json` (+lock root), `desktop/src-tauri/tauri.conf.json`,
   `desktop/src-tauri/Cargo.toml` (+`Cargo.lock`), the OpenAPI `info.version`,
   `deploy/scripts/generate-secrets.sh`, `deploy/.env.production.example`, `README.md`.
   Replace the hard-coded `1.0.0` in `SettingsPage.tsx` with a build-time constant
   (e.g. Vite `define: { __APP_VERSION__: JSON.stringify(pkg.version) }`).
3. Turn the CHANGELOG `[Unreleased]` sections into a dated `[x.y.z]` section, and add a
   RELEASE_NOTES entry.
4. Tag the commit `vX.Y.Z`. Build the images with `APP_VERSION=X.Y.Z` and the desktop
   bundles from **that tag only**.
5. Optionally expose the version on `/healthz`, and add a CI check that fails when the
   versions above disagree.
