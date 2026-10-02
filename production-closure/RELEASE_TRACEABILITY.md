# Release Traceability

| Link | Mechanism | Evidence |
|---|---|---|
| **Git commit → version** | All first-party declarations = 1.8.0 (`scripts/check-release-version.mjs`, CI `release` job; on tags, also equal to the tag) | Gate output in `RELEASE_VERSION_EVIDENCE.md` |
| **Commit → build** | Images are built with `--build-arg GIT_COMMIT=$(git rev-parse HEAD) BUILD_DATE=…` (installer exports both; CI uses `${{ github.sha }}`); the frontend bakes `__GIT_COMMIT__` / `__BUILD_DATE__` | Commit `4e5d4bd…` built from `git archive` reported itself via `/api/v1/version` and on the About screen |
| **Build → container image** | Tag `netsphere/<service>:${APP_VERSION}` (**mandatory**); the build **fails** if `APP_VERSION` ≠ `package.json`; OCI labels `org.opencontainers.image.{version,revision,created}` | Guard executed in `node:20-alpine`: `1.8.0` accepted, `1.7.0` refused. Full image build: BLOCKED (see `DOCKER_BUILD_EVIDENCE.md`); CI `images` job prints the labels |
| **Image → deployment** | `GET /api/v1/version` → `{version, commit, build_date}` (public, non-sensitive, format-checked); logged at startup as `release`; About screen shows client **and** server release | Smoke checks "traceability: …" (3/3 PASS); `evidence/about-screen.png` |
| **Dependencies** | Lockfiles (`npm ci`, `cargo --locked`); CycloneDX SBOMs | `sbom/` |

## What `/api/v1/version` exposes and does not expose

- **Exposes:** `version` (semver from `package.json`), `commit` (7–40 lowercase hex characters), `build_date` (ISO-8601 UTC). Any other value collapses to `unknown` (VERSION-003).
- **Never exposes:** filesystem paths, environment variables, hostnames, internal addresses or secrets. The smoke test asserts the response has exactly these three keys.

## Exact tested artifact

- **Code commit:** `4e5d4bd4ecf382d13aa2bb880063de779d9a0aaa` (commit A). The following commit adds only the `production-closure/` evidence documents.
- **Builds of commit A:**
  - **Backend:** from `git archive` inside `node:20-alpine` (Alpine 3.23.4, Node 20.20.2), using `npm ci` → `npm run build` → `npm prune --omit=dev`.
  - **Frontend:** `vite build` with `GIT_COMMIT` set.
  - **Desktop crate:** `cargo check --locked`, plus the live SSH test, in the full verification run.
- **Runtime:** the backend run under the production compose restrictions reported `{"version":"1.8.0","commit":"4e5d4bd4…"}`.
- **Remaining gap:** the **final container image** (adds the Alpine packages `tini`, `wget`, `iputils`, `traceroute`) was not built here. Condition C-1 in `CONDITIONS_CLOSURE_MATRIX.md`.
