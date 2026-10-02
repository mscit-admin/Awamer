# Release Version Evidence

**Release: 1.8.0.** The repository evidence pointed to 1.8.0:
- the backend `package.json`;
- the installer `generate-secrets.sh`;
- `.env.production.example`;
- the OpenAPI document.

Only the desktop line lagged behind, at 1.7.0. Third-party dependency versions were not touched by this standardisation.

## Before → after

| Component | Before | After | Source |
|---|---|---|---|
| Backend | 1.8.0 | **1.8.0** | `backend/package.json`, `backend/package-lock.json` (root) |
| Frontend | 1.7.0 | **1.8.0** | `desktop/package.json`, `desktop/package-lock.json` (root entries only) |
| Desktop (Rust crate) | 1.7.0 | **1.8.0** | `desktop/src-tauri/Cargo.toml`, `Cargo.lock` (`netsphere-terminal`) |
| Tauri | 1.7.0 | **1.8.0** | `desktop/src-tauri/tauri.conf.json` |
| UI / About | `1.0.0` (hard-coded), "Phase 1", "Build dev" | **build-time constants:** `__APP_VERSION__` 1.8.0, `__GIT_COMMIT__`, `__BUILD_DATE__`, plus the server's release fetched from `/api/v1/version` | `desktop/vite.config.ts` (`define`), `desktop/src/modules/settings/SettingsPage.tsx` |
| Docker | `${APP_VERSION:-1.6.0.1}` (stale default, fixed to mandatory in the security closure) | **`${APP_VERSION:?}` = 1.8.0.** The image build **fails** if `APP_VERSION` ≠ `package.json`. The installer sets `APP_VERSION` from `backend/package.json` | `backend/Dockerfile*`, `deploy/docker-compose.production.yml`, `deploy/scripts/install.sh` |
| API (OpenAPI) | hard-coded `"1.8.0"` | **`RELEASE.version`**, read from `package.json` | `backend/src/server.ts`, `backend/src/version.ts` |
| API (runtime) | none | **`GET /api/v1/version` → `{version, commit, build_date}`** | `backend/src/server.ts` |
| README / deploy docs | v1.7.0, install examples `1.6.0.1` / `1.7.0` | **v1.8.0** (headline and install/upgrade examples) | `README.md`, `deploy/README.md` |

Historical notes such as `// 1.7.0 — chmod` in `SftpPage.tsx`, and the history sections of the README and release notes, are feature history, not version declarations. They were left unchanged on purpose.

## Executed evidence

```
$ node scripts/check-release-version.mjs 1.8.0
ok    backend/package.json                                 1.8.0
ok    backend/package-lock.json (root)                     1.8.0
ok    desktop/package.json                                 1.8.0
ok    desktop/package-lock.json (root)                     1.8.0
ok    desktop/src-tauri/tauri.conf.json                    1.8.0
ok    desktop/src-tauri/Cargo.toml                         1.8.0
ok    desktop/src-tauri/Cargo.lock (netsphere-terminal)    1.8.0
ok    deploy/scripts/generate-secrets.sh (APP_VERSION)     1.8.0
ok    deploy/.env.production.example (APP_VERSION)         1.8.0
release version consistent: 1.8.0
```

- **Live API** (production-mode run): `GET /api/v1/version` returned `{"version":"1.8.0","commit":"<sha>","build_date":"<iso>"}`. The smoke test asserts the response has **only** these three keys. See `FINAL_TEST_RESULTS.md`.
- **About screen:** `evidence/about-screen.png`, captured through the real web UI against the production-mode server. It shows `Version 1.8.0 · Commit … · Build date … · Server 1.8.0 (…)`, so the client and server are verifiably the same release.
- **Unit tests** in `backend/src/version.test.ts` (VERSION-001…003):
  - the reported version equals `package.json`;
  - a commit or build date that is not a hex SHA or ISO timestamp collapses to `unknown`, so no path, env value or secret can be smuggled out.
- **CI:** the `release` job runs the check on every push, and on tags it also compares against the tag.
