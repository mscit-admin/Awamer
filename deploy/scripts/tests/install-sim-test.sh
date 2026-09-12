#!/usr/bin/env bash
# =====================================================================
# Simulated installation + controlled-failure tests  (§46)
# =====================================================================
# Runs the REAL deploy/scripts/install.sh end-to-end against MOCKED external
# commands (docker/nginx/certbot/systemctl/apt-get/curl/sudo) inside a throw-
# away FAKEROOT, so no real service, host path, or application logic is touched
# (§46). Each scenario asserts the installer's exit code (§33), the finalized
# status, that evidence is preserved, and that no secret leaked.
#
#   Scenarios: success, certbot failure, nginx -t failure, readiness timeout,
#   docker-compose-config invalid, docker unavailable.
#
# Run:  bash deploy/scripts/tests/install-sim-test.sh
# =====================================================================

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "${HERE}/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPTS}/../.." && pwd)"

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"; rm -f "${REPO_ROOT}/.env.production.simtest.bak" 2>/dev/null || true' EXIT

PASS=0; FAIL=0
ok()  { printf '  \033[0;32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  \033[0;31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }

# ----- Build the mock bin ---------------------------------------------
MOCKBIN="${SANDBOX}/bin"; mkdir -p "$MOCKBIN"

cat > "${MOCKBIN}/sudo" <<'EOF'
#!/usr/bin/env bash
# Passthrough sudo that redirects system paths into $FAKEROOT so tests never
# touch real /etc or /var.
args=()
for a in "$@"; do
  case "$a" in
    /etc/*|/var/*) args+=("${FAKEROOT}${a}") ;;
    *) args+=("$a") ;;
  esac
done
exec "${args[@]}"
EOF

cat > "${MOCKBIN}/docker" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "compose version") [[ "${FAIL_DOCKER:-0}" == "1" ]] && exit 1 || exit 0 ;;
  "--version") echo "Docker version 29.9.9, build test" ;;
  *" config") [[ "${FAIL_COMPOSE_CONFIG:-0}" == "1" ]] && { echo "invalid compose" >&2; exit 1; } || exit 0 ;;
  *" build") exit 0 ;;
  *"up -d") exit 0 ;;
  *"ps --services") printf 'postgres\nredis\nauth-service\n' ;;
  *" ps") printf 'NAME STATUS\nnetsphere-auth Up (healthy)\n' ;;
  *"logs auth-service") printf 'INFO applying migration version=001\nINFO applying migration version=026\nINFO migrations complete\n' ;;
  *"postgres --version") echo "postgres (PostgreSQL) 16.13" ;;
  *) exit 0 ;;
esac
EOF
[[ "${FAIL_DOCKER:-0}" == "1" ]] && true  # handled per-scenario via env

cat > "${MOCKBIN}/nginx" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "-v" ]]; then echo "nginx version: nginx/1.24.0 (Ubuntu)" >&2; exit 0; fi
if [[ "$1" == "-t" ]]; then
  if [[ "${FAIL_NGINX_T:-0}" == "1" ]]; then echo "nginx: [emerg] test failed" >&2; exit 1; fi
  echo "nginx: configuration file test is successful" >&2; exit 0
fi
exit 0
EOF

cat > "${MOCKBIN}/certbot" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "certbot 2.9.0"; exit 0; fi
# certonly …
if [[ "${FAIL_CERTBOT:-0}" == "1" ]]; then echo "certbot: challenge failed" >&2; exit 1; fi
dom=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-d" ]] && dom="$2"; shift; done
mkdir -p "${FAKEROOT}/etc/letsencrypt/live/${dom}"
: > "${FAKEROOT}/etc/letsencrypt/live/${dom}/fullchain.pem"
: > "${FAKEROOT}/etc/letsencrypt/live/${dom}/privkey.pem"
echo "certbot: certificate issued"
EOF

cat > "${MOCKBIN}/systemctl" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == "is-active" ]] && { echo active; exit 0; }
exit 0
EOF

cat > "${MOCKBIN}/apt-get" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "${MOCKBIN}/curl" <<'EOF'
#!/usr/bin/env bash
argv="$*"
# readiness gate: curl -sf http://127.0.0.1:8081/readyz
if [[ "$argv" == *"/readyz"* && "$argv" != *"-w"* ]]; then
  [[ "${FAIL_READY:-0}" == "1" ]] && exit 7 || exit 0
fi
# probe_http: curl -sk -o /dev/null -w '<fmt>' URL
if [[ "$argv" == *"%{http_code}"* ]]; then
  if [[ "$argv" == *"/readyz"* && "${FAIL_READY:-0}" == "1" ]]; then echo 503; else echo 200; fi
  exit 0
fi
if [[ "$argv" == *"%{time_total}"* ]]; then echo "0.010s"; exit 0; fi
# preflight reachability + anything else
exit 0
EOF

cat > "${MOCKBIN}/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

chmod +x "${MOCKBIN}"/*

# ----- A valid .env.production so the installer skips generation -------
ENVTEST="${SANDBOX}/.env.production"
cat > "$ENVTEST" <<'EOF'
POSTGRES_USER=netsphere
POSTGRES_DB=netsphere
POSTGRES_PASSWORD=simtestpasswordvalue
REDIS_PASSWORD=simtestredisvalue
JWT_ACCESS_SECRET=simtestaccesssecretsimtestaccesssecret
JWT_REFRESH_SECRET=simtestrefreshsecretsimtestrefreshsecret
CREDENTIAL_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=SimTestBootstrapPassw0rd
APP_VERSION=test
LOG_LEVEL=info
CORS_ALLOWED_ORIGINS=https://sim.example.com:6655
RATE_LIMIT_API_PER_MIN=600
RATE_LIMIT_LOGIN_PER_MIN=30
EOF

run_scenario() {
    local name="$1"; shift
    local expect_rc="$1"; shift
    local expect_status="$1"; shift
    # remaining args are FAIL_* env assignments
    local fakeroot="${SANDBOX}/fakeroot-${name}"
    local evroot="${SANDBOX}/evidence-${name}"
    mkdir -p "${fakeroot}/etc/nginx/sites-available" "${fakeroot}/etc/nginx/sites-enabled" \
             "${fakeroot}/var/www" "${fakeroot}/etc/letsencrypt/live" "$evroot"
    # Place the test .env.production into the repo (backed up + restored).
    [[ -f "${REPO_ROOT}/.env.production" ]] && cp "${REPO_ROOT}/.env.production" "${REPO_ROOT}/.env.production.simtest.bak"
    cp "$ENVTEST" "${REPO_ROOT}/.env.production"

    local rc
    # Use `env` so scenario FAIL_* vars ("$@") are parsed as assignments, not
    # mistaken for the command word.
    ( cd "$REPO_ROOT"
      env PATH="${MOCKBIN}:$PATH" \
          FAKEROOT="$fakeroot" \
          AWAMER_EVIDENCE_ROOT="$evroot" \
          NETSPHERE_DOMAIN="sim.example.com" \
          LE_EMAIL="admin@example.com" \
          "$@" \
          bash deploy/scripts/install.sh
    ) >"${SANDBOX}/out-${name}.log" 2>&1 <<<"Y"
    rc=$?

    # restore repo .env.production
    if [[ -f "${REPO_ROOT}/.env.production.simtest.bak" ]]; then
        mv "${REPO_ROOT}/.env.production.simtest.bak" "${REPO_ROOT}/.env.production"
    else
        rm -f "${REPO_ROOT}/.env.production"
    fi

    echo "-- scenario: ${name} (rc=${rc}) --"
    [[ "$rc" == "$expect_rc" ]] && ok "${name}: exit code ${rc} (§33)" || bad "${name}: exit ${rc}, expected ${expect_rc}"

    local rundir; rundir="$(ls -1dt "${evroot}"/*/ 2>/dev/null | head -n1)"
    if [[ -z "$rundir" ]]; then bad "${name}: no evidence run created"; return; fi
    ok "${name}: evidence run created + preserved (§23)"
    local manifest="${rundir}installation-manifest.json"
    if [[ -f "$manifest" ]]; then
        local st
        st="$(sed -n 's/.*"status":"\([A-Z]*\)".*/\1/p' "$manifest" | head -n1)"
        [[ "$st" == "$expect_status" ]] && ok "${name}: status=${st}" || bad "${name}: status=${st}, expected ${expect_status}"
        if command -v jq >/dev/null 2>&1; then
            jq -e . "$manifest" >/dev/null 2>&1 && ok "${name}: manifest valid JSON" || bad "${name}: manifest invalid JSON"
        fi
    else
        bad "${name}: no manifest"
    fi
    # No secret ever leaks, in any scenario.
    if grep -rqE 'simtestpasswordvalue|SimTestBootstrapPassw0rd|simtestaccesssecret|0123456789abcdef0123456789abcdef' "$rundir" 2>/dev/null; then
        bad "${name}: SECRET LEAK in evidence"
    else
        ok "${name}: no secret leak in evidence (§8)"
    fi
}

echo "==== Simulated installation scenarios ===="
run_scenario success            0 SUCCESS
run_scenario certbot_fail       1 FAILED  FAIL_CERTBOT=1
run_scenario nginx_t_fail       1 FAILED  FAIL_NGINX_T=1
run_scenario readiness_timeout  1 FAILED  FAIL_READY=1
run_scenario compose_config_bad 1 FAILED  FAIL_COMPOSE_CONFIG=1
run_scenario docker_unavailable 1 FAILED  FAIL_DOCKER=1

echo
echo "== scenario-specific evidence assertions =="
# certbot failure must record the TLS error code and NOT activate HTTPS
CB_RUN="$(ls -1dt "${SANDBOX}/evidence-certbot_fail"/*/ 2>/dev/null | head -n1)"
grep -q "AW-INSTALL-TLS-001" "${CB_RUN}10-errors.log" 2>/dev/null && ok "certbot_fail: AW-INSTALL-TLS-001 recorded" || bad "certbot_fail: TLS error code missing"
# readiness timeout must record READY error code
RT_RUN="$(ls -1dt "${SANDBOX}/evidence-readiness_timeout"/*/ 2>/dev/null | head -n1)"
grep -q "AW-INSTALL-READY-001" "${RT_RUN}10-errors.log" 2>/dev/null && ok "readiness_timeout: AW-INSTALL-READY-001 recorded" || bad "readiness_timeout: READY code missing"
# success run must have report + actions history
S_RUN="$(ls -1dt "${SANDBOX}/evidence-success"/*/ 2>/dev/null | head -n1)"
grep -q "Requested Let's Encrypt certificate" "${S_RUN}12-actions.log" 2>/dev/null && ok "success: action history reconstructable (§21)" || bad "success: action history missing"

echo
echo "================ install-sim summary ================"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]]
