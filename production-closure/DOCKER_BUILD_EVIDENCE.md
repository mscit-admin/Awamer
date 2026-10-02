# Docker Build Evidence

## Production image builds

| Image name | Tag | Build result | Image ID / digest | Release |
|---|---|---|---|---|
| `netsphere/auth-service` (`backend/Dockerfile`) | `1.8.0` | **BLOCKED BY ENVIRONMENT** | — | 1.8.0 |
| `netsphere/vpn-helper` (`backend/Dockerfile.vpn-helper`) | `1.8.0` | **BLOCKED BY ENVIRONMENT** | — | 1.8.0 |
| Frontend | n/a: static files served by host nginx (no image in this stack) | `vite build` **VERIFIED** (commit `4e5d4bd`) | — | 1.8.0 |

**Exact blocker.** The Docker daemon started and `node:20-alpine` was pulled (image id `fb4cd12c85ee`). Both Dockerfiles then stop at the first `apk add`:

- **As shipped:**

  ```
  WARNING: fetching https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/APKINDEX.tar.gz: TLS: server certificate not trusted
  ERROR: unable to select packages ... exit code: 4
  ```

- **With the sandbox proxy CA injected** into a scratch copy only (never committed):

  ```
  WARNING: fetching https://dl-cdn.alpinelinux.org/...: HTTP 403: Forbidden
  ```

The sandbox network policy denies `dl-cdn.alpinelinux.org`, and Docker Hub rate-limited one earlier retry (429). **To unblock:** allow that host in the environment's network settings, or run the CI `images` job, which builds both images, prints their OCI labels and user, and runs the release-identity check.

## What WAS verified in the real base image (`node:20-alpine`, Alpine 3.23.4, Node 20.20.2)

**Emulation, not the final image.** The final image adds the Alpine packages `tini`, `wget`, `iputils` and `traceroute` (backend) or `openvpn`, `iproute2`, `iptables` (helper), which could not be installed.

| Step of the Dockerfile | Verified how | Result |
|---|---|---|
| `APP_VERSION` guard | Ran the guard snippet in the base image against `package.json` | `1.8.0` accepted; `1.7.0` **refused** |
| `COPY package.json package-lock.json` + `npm ci` | `npm ci` from the lockfile of commit `4e5d4bd`, built from `git archive` | PASS |
| `npm run build` + `npm prune --omit=dev` | same | PASS |
| argon2 native module on musl (no compiler toolchain) | `require('argon2').hash()` | PASS |
| Runtime: `user: 10001:10001`, `read_only: true`, `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges` | `docker run` with exactly these flags; `/proc/1/status` inspected | uid/gid 10001; `/app` and `/etc` read-only; `/tmp` writable; `CapPrm`, `CapEff`, `CapBnd` = 0; `NoNewPrivs: 1` |
| `migrate` job as `awamer_migrator` under the same restrictions | `node dist/migrate.js up` | "migrations complete" |
| Backend as `awamer_app` under the same restrictions | `/readyz`, `/api/v1/version`, full smoke test | ready; reports `1.8.0` / `4e5d4bd…`; **60/60 smoke checks** |

## Container inspection (static, from Dockerfiles + compose; runtime parts verified above)

| Property | auth-service | vpn-helper | migrate | db-provision |
|---|---|---|---|---|
| Base image | `node:20-alpine` (multi-stage; no compilers in the runtime stage) | `node:20-alpine` | auth-service image | `postgres:16-alpine` |
| Runtime user | `10001:10001` (Dockerfile `USER app` and compose) ✅ verified | `0:10001` (root, required) | `10001:10001` | `70:70` |
| Linux capabilities | `cap_drop: ALL`, none added ✅ verified | `cap_drop: ALL` + `NET_ADMIN` | `cap_drop: ALL` | `cap_drop: ALL` |
| no-new-privileges | ✅ verified | ✅ | ✅ | ✅ |
| Read-only rootfs | ✅ verified (`/tmp` tmpfs) | ❌ not enabled (OR-04) | ✅ | ✅ |
| Exposed ports | `EXPOSE 8081`; published `127.0.0.1:8081` only | none (host networking; per-server VPN ports) | none | none |
| Volumes | `vpn-helper-run:/run/awamer` (IPC socket) | `vpn-helper-run:/run/awamer` | none | `provision-roles.sh` (read-only) |
| Environment | `NODE_ENV=production`, `MIGRATIONS_DIR`, `GIT_COMMIT`, `BUILD_DATE`; secrets **only at runtime** from `.env.production` | `NODE_ENV`, `OPENVPN_PATH`, socket/runtime paths | — | — |
| Healthcheck | `wget /healthz` | socket present | — | — |
| Entrypoint | `tini -- node dist/server.js` | `tini -- node dist/vpn-helper/main.js` | `node dist/migrate.js up` | `sh provision-roles.sh` |
| Embedded secrets | **none**: `.dockerignore` excludes `.env*`; Dockerfiles contain no secret `ARG`/`ENV` (only `APP_VERSION`, `GIT_COMMIT`, `BUILD_DATE`) | none | none | none |
| Docker socket / privileged | none / no | none / no | none / no | none / no |
| Compose configuration | `docker compose -f deploy/docker-compose.production.yml config` → **valid** with generated secrets | | | |
