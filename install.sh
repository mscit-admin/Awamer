#!/usr/bin/env bash
# =====================================================================
# Awamer Terminal — install.sh
# =====================================================================
# One-shot bootstrap for a fresh checkout. Idempotent — safe to re-run.
# =====================================================================
set -euo pipefail

# Colors
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; NC=$'\033[0m'

log()   { echo -e "${CYAN}==>${NC} $*"; }
warn()  { echo -e "${YELLOW}!${NC}  $*" >&2; }
err()   { echo -e "${RED}✗${NC}  $*" >&2; }
ok()    { echo -e "${GREEN}✓${NC}  $*"; }

# --- 0. Sanity checks ------------------------------------------------
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"
[[ -f Makefile && -d backend ]] || { err "run this script from the repo root"; exit 1; }

# --- 1. Verify dependencies ------------------------------------------
log "Checking dependencies…"

missing=()
command -v docker >/dev/null 2>&1 || missing+=("docker")
docker compose version >/dev/null 2>&1 || missing+=("docker compose plugin")
command -v node >/dev/null 2>&1 || missing+=("node (>=20)")
command -v npm >/dev/null 2>&1 || missing+=("npm")
command -v make >/dev/null 2>&1 || missing+=("make")

if ((${#missing[@]} > 0)); then
  err "missing required tools: ${missing[*]}"
  echo "See README.md → System requirements"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  err "Node.js is too old: $(node --version). Need 20.x or 22.x."
  exit 1
fi

ok "All required tools present"

# Rust check (warn only — only needed for desktop)
if command -v rustc >/dev/null 2>&1; then
  RUST_VERSION=$(rustc --version | awk '{print $2}')
  RUST_MAJOR=$(echo "$RUST_VERSION" | cut -d. -f1)
  RUST_MINOR=$(echo "$RUST_VERSION" | cut -d. -f2)
  if (( RUST_MAJOR < 1 )) || (( RUST_MAJOR == 1 && RUST_MINOR < 85 )); then
    warn "Rust $RUST_VERSION is too old for Tauri (need ≥ 1.85). Run: rustup update stable"
  else
    ok "Rust $RUST_VERSION present"
  fi
else
  warn "Rust not found. Run \"curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh\" before \"npm run tauri dev\""
fi

# --- 2. .env file ----------------------------------------------------
if [[ ! -f .env ]]; then
  cp .env.example .env
  ok "Created .env from .env.example"
else
  ok ".env exists"
fi

# --- 3. desktop/.env -------------------------------------------------
if [[ ! -f desktop/.env ]]; then
  echo "VITE_API_BASE_URL=http://localhost:8081" > desktop/.env
  ok "Created desktop/.env"
else
  ok "desktop/.env exists"
fi

# --- 4. Bring up Docker stack ----------------------------------------
log "Bringing up Docker stack (postgres, redis, auth-service)…"
make docker-up

log "Waiting for postgres to become healthy…"
for i in {1..30}; do
  if docker compose --env-file .env -f deployments/docker-compose.yml exec -T postgres \
       pg_isready -U "${POSTGRES_USER:-netsphere}" -d "${POSTGRES_DB:-netsphere}" >/dev/null 2>&1; then
    ok "postgres is healthy"
    break
  fi
  sleep 2
  if [[ $i -eq 30 ]]; then
    err "postgres failed to come up in 60s; check: docker compose logs postgres"
    exit 1
  fi
done

# --- 5. Run migrations -----------------------------------------------
log "Applying database migrations…"
make migrate-up-docker

# --- 6. Restart auth-service so bootstrap runs AFTER migrations ------
log "Restarting auth-service to trigger admin bootstrap…"
docker compose --env-file .env -f deployments/docker-compose.yml restart auth-service

log "Waiting for auth-service to be healthy…"
for i in {1..30}; do
  if curl -fsS http://localhost:8081/healthz >/dev/null 2>&1; then
    ok "auth-service is healthy"
    break
  fi
  sleep 2
  if [[ $i -eq 30 ]]; then
    err "auth-service failed to come up; check: docker compose logs auth-service"
    exit 1
  fi
done

# --- 7. Verify login works -------------------------------------------
log "Verifying login…"
BOOTSTRAP_USERNAME=$(grep -E '^BOOTSTRAP_ADMIN_USERNAME=' .env | cut -d= -f2 | tr -d '"' || echo admin)
BOOTSTRAP_PASSWORD=$(grep -E '^BOOTSTRAP_ADMIN_PASSWORD=' .env | cut -d= -f2 | tr -d '"' || echo 'ChangeMe!2026')

RESP=$(curl -s -X POST http://localhost:8081/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$BOOTSTRAP_USERNAME\",\"password\":\"$BOOTSTRAP_PASSWORD\"}")

if echo "$RESP" | grep -q access_token; then
  ok "Login verified — admin user is operational"
else
  err "Login failed. Response: $RESP"
  err "Check: docker compose logs --tail=20 auth-service"
  exit 1
fi

# --- 8. Done ---------------------------------------------------------
echo
echo "==============================================================="
echo "  Awamer Terminal is ready."
echo "==============================================================="
echo
echo "  Backend:    http://localhost:8081"
echo "  Login:      $BOOTSTRAP_USERNAME / $BOOTSTRAP_PASSWORD"
echo
echo "  Next steps:"
echo "    1. cd desktop"
echo "    2. npm install"
echo "    3. npm run tauri dev          # native window (needs Rust)"
echo "       npm run dev                # browser at http://localhost:1420"
echo
