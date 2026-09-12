#!/usr/bin/env bash
# =====================================================================
# NetSphere Terminal — Production install on Ubuntu (22.04+ / 24.04)
# =====================================================================
#
# This is an INTERACTIVE installer. Run as a user with sudo rights:
#
#   chmod +x deploy/scripts/install.sh
#   ./deploy/scripts/install.sh
#
# It will:
#   1. Install Docker + Docker Compose plugin (if not present)
#   2. Install nginx + certbot (if not present)
#   3. Generate secrets if .env.production doesn't exist
#   4. Build and start the backend stack
#   5. Configure nginx with your domain
#   6. Issue a Let's Encrypt certificate
#   7. Verify everything works
#
# Idempotent: safe to re-run. Skips steps that are already done.
# =====================================================================

set -euo pipefail

# ----- Pretty output -------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'

# ----- Detect repo root ---------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# ----- Installation evidence & diagnostics (sourced library) --------
# Turns this installer into a structured, sanitized evidence producer:
# every run gets its own never-overwritten directory, secrets are redacted
# automatically, and a report + manifest are generated at the end.
# shellcheck source=lib/evidence.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/evidence.sh"
evidence_init >/dev/null
RUN_DIR="$(evidence_dir)"

# Overall installation outcome — flipped to PARTIAL when a mandatory production
# gate (e.g. TLS) is intentionally left incomplete (EVID-STATE-001).
INSTALL_OUTCOME="SUCCESS"
# Selected public HTTPS port (DEPLOY-PORT-001); resolved in Step 5. Default 443.
HTTPS_PORT="443"
DEPLOYMENT_CONF="${AWAMER_DEPLOYMENT_CONF:-/etc/awamer/deployment.conf}"

# Evidence-aware output helpers: console output is unchanged for the operator,
# but every message is ALSO recorded (sanitized) into the evidence run.
say() { echo -e "${BOLD}==>${NC} $*"; ev_action "$*"; }
ok()  { echo -e "${GREEN}✓${NC} $*"; ev_action "OK: $*"; }
warn(){ echo -e "${YELLOW}!${NC} $*"; ev_warn "$*"; }
# err <message> [error_code]  — records the error, finalizes evidence as FAILED
# (evidence is PRESERVED, §23), prints the failure summary, then exits non-zero.
err() {
    local msg="$1" code="${2:-AW-INSTALL-${EV_CURRENT_PHASE}-001}"
    echo -e "${RED}✗${NC} $msg" >&2
    ev_error "$EV_CURRENT_PHASE" "install step" 1 "$code" "$msg"
    _finalize_once FAILED "$EV_CURRENT_PHASE" "$msg" 1 "$code"
    print_failure_summary "$code"
    exit 1
}

# Finalize exactly once (err() and the ERR trap can both fire).
_EV_FINALIZED=0
_finalize_once() { [[ $_EV_FINALIZED -eq 1 ]] && return 0; _EV_FINALIZED=1; evidence_finalize "$@"; }

print_failure_summary() { # (§35)
    local code="${1:-AW-INSTALL-${EV_CURRENT_PHASE}-001}"
    cat >&2 <<EOF

${RED}════════════════════════════════════════════════${NC}
${RED}  INSTALLATION FAILED${NC}
${RED}════════════════════════════════════════════════${NC}

  Phase:       ${EV_CURRENT_PHASE}
  Error Code:  ${code}
  Evidence:    ${RUN_DIR}/
  Main Report: ${RUN_DIR}/${EV_F_REPORT}
  Errors:      ${RUN_DIR}/${EV_F_ERRORS}

  Nothing was deleted — the evidence above is preserved for
  root-cause analysis. Attach a support bundle when asking for help:
    ./deploy/scripts/support-bundle.sh "$(evidence_run_id)"
EOF
}

# Unexpected failures (any command failing under set -e) are captured, not
# silently swallowed, and never auto-"fixed" (§44).
_on_err() {
    local rc=$?
    local cmd="$BASH_COMMAND"
    ev_error "$EV_CURRENT_PHASE" "$(redact_text "$cmd")" "$rc" \
        "AW-INSTALL-${EV_CURRENT_PHASE}-000" "unexpected command failure"
    _finalize_once FAILED "$EV_CURRENT_PHASE" "$cmd" "$rc" "AW-INSTALL-${EV_CURRENT_PHASE}-000"
    print_failure_summary "AW-INSTALL-${EV_CURRENT_PHASE}-000"
}
trap _on_err ERR

if [[ ! -f deploy/docker-compose.production.yml ]]; then
    err "Could not find deploy/docker-compose.production.yml — are you in the project root?"
fi

# ----- Step 0: system information + preflight (§4, §5, §6) -----------
ev_phase "SYSINFO" "Collect system information"
say "Step 0/7: Collecting system information + preflight"
collect_system_info
collect_network_baseline "${NETSPHERE_DOMAIN:-}"
ev_fingerprint "docker-compose.production.yml" "deploy/docker-compose.production.yml"
ev_fingerprint "nginx/netsphere.conf" "deploy/nginx/netsphere.conf"
ev_fingerprint "install.sh" "deploy/scripts/install.sh"
ev_fingerprint "update.sh" "deploy/scripts/update.sh"

ev_phase "PREFLIGHT" "Resource + connectivity preflight"
_pf_start=$(date +%s)
# Disk: require >= 5 GiB free on the filesystem holding the repo.
_disk_free_kb=$(df -Pk . 2>/dev/null | awk 'NR==2{print $4}')
if [[ -n "${_disk_free_kb:-}" && "$_disk_free_kb" -ge 5242880 ]]; then
    preflight_check "Disk >= 5 GiB free" PASS "$((_disk_free_kb/1024/1024)) GiB free"
elif [[ -n "${_disk_free_kb:-}" ]]; then
    preflight_check "Disk >= 5 GiB free" WARN "only $((_disk_free_kb/1024/1024)) GiB free"
else
    preflight_check "Disk >= 5 GiB free" WARN "could not determine free disk"
fi
# RAM: recommend >= 2 GiB total.
_mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null)
if [[ -n "${_mem_kb:-}" && "$_mem_kb" -ge 2097152 ]]; then
    preflight_check "RAM >= 2 GiB recommended" PASS "$((_mem_kb/1024)) MiB total"
elif [[ -n "${_mem_kb:-}" ]]; then
    preflight_check "RAM >= 2 GiB recommended" WARN "only $((_mem_kb/1024)) MiB total"
else
    preflight_check "RAM >= 2 GiB recommended" WARN "could not determine RAM"
fi
# Architecture
_arch=$(uname -m 2>/dev/null)
if [[ "$_arch" == "x86_64" || "$_arch" == "aarch64" || "$_arch" == "arm64" ]]; then
    preflight_check "CPU architecture supported" PASS "$_arch"
else
    preflight_check "CPU architecture supported" WARN "$_arch (untested)"
fi
# Required local ports free (informational): 80, 6655, 8081
for _p in 80 6655 8081; do
    if ss -tlnH "( sport = :$_p )" 2>/dev/null | grep -q .; then
        preflight_check "Port $_p available" WARN "already in use"
    else
        preflight_check "Port $_p available" PASS "free"
    fi
done
# Package repo / internet reachability (informational)
if curl -fsS --max-time 8 -o /dev/null https://get.docker.com 2>/dev/null; then
    preflight_check "Package/internet reachability" PASS "reachable"
else
    preflight_check "Package/internet reachability" WARN "could not reach get.docker.com"
fi
# Domain DNS resolution (only if a domain is already known)
if [[ -n "${NETSPHERE_DOMAIN:-}" && "${NETSPHERE_DOMAIN}" != "skip" ]]; then
    if getent hosts "$NETSPHERE_DOMAIN" >/dev/null 2>&1; then
        preflight_check "Domain resolves" PASS "$NETSPHERE_DOMAIN"
    else
        preflight_check "Domain resolves" WARN "$NETSPHERE_DOMAIN does not resolve yet"
    fi
fi
phase_record "PREFLIGHT" "PASS" "$(( $(date +%s) - _pf_start ))s"
ok "Preflight complete (see ${RUN_DIR}/${EV_F_PREFLIGHT})"

# ----- Step 1: prerequisites ----------------------------------------
ev_phase "PACKAGES" "Install prerequisites"
say "Step 1/7: Installing prerequisites"

_docker_before="$(ev_ver docker --version)"
if ! command -v docker >/dev/null 2>&1; then
    say "  Installing Docker"
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
    warn "Added you to the docker group. You may need to log out and back in for this to take effect."
fi
component_record "docker" "$_docker_before" "$(ev_ver docker --version)" \
    "$(command -v docker >/dev/null 2>&1 && echo PASS || echo FAIL)"

if ! sudo docker compose version >/dev/null 2>&1; then
    err "Docker Compose plugin not available. Re-run after Docker is installed." "AW-INSTALL-DOCKER-001"
fi
component_record "docker-compose" "-" "$(sudo docker compose version 2>/dev/null | head -n1)" "PASS"

_nginx_before="$(ev_ver nginx -v)"
if ! command -v nginx >/dev/null 2>&1; then
    say "  Installing nginx"
    sudo apt-get update -qq
    sudo apt-get install -y nginx
fi
# DEPLOY-001: report the nginx version. The shipped config uses the
# `listen … ssl http2` syntax, which is compatible with the distro nginx on
# Ubuntu 22.04/24.04 (no third-party nginx repo required).
_nginx_after="$(nginx -v 2>&1 | sed 's/^nginx version: //')"
say "  nginx version: $_nginx_after"
component_record "nginx" "$_nginx_before" "$_nginx_after" "PASS"
_ev_kv_set nginx_version "$_nginx_after"

_certbot_before="$(ev_ver certbot --version)"
if ! command -v certbot >/dev/null 2>&1; then
    say "  Installing certbot (for Let's Encrypt)"
    sudo apt-get install -y certbot python3-certbot-nginx
fi
component_record "certbot" "$_certbot_before" "$(ev_ver certbot --version)" \
    "$(command -v certbot >/dev/null 2>&1 && echo PASS || echo FAIL)"

phase_record "PACKAGES" "PASS" "-"
ok "Prerequisites ready"

# ----- Step 2: secrets ----------------------------------------------
ev_phase "SECRETS" "Configure secrets"
say "Step 2/7: Configuring secrets"

if [[ ! -f .env.production ]]; then
    say "  Generating .env.production"
    bash deploy/scripts/generate-secrets.sh > .env.production
    chmod 600 .env.production
    ok "Generated .env.production (mode 600)"
    warn "BACK THIS FILE UP TO A SAFE PLACE — losing it means losing all sessions and MFA secrets!"

    # EVID-SEC-002: NEVER display the bootstrap password. Show only the
    # non-secret username/email so the operator knows which account to use;
    # the password stays in the mode-600 .env.production and is never printed.
    _boot_user="$(grep -E '^BOOTSTRAP_ADMIN_USERNAME=' .env.production | cut -d= -f2- || true)"
    _boot_email="$(grep -E '^BOOTSTRAP_ADMIN_EMAIL=' .env.production | cut -d= -f2- || true)"
    echo
    echo "  Bootstrap administrator:"
    echo "    Username: ${_boot_user:-admin}"
    echo "    Email:    ${_boot_email:-<in .env.production>}"
    echo "    Password: [configured securely — not displayed]"
    echo
    echo "Press Enter to continue with the generated admin credentials, or"
    echo "Ctrl-C to abort and edit them in .env.production first."
    read -r
else
    warn "Existing .env.production found, NOT regenerating"
fi

# Validate required vars
MISSING=()
for v in POSTGRES_PASSWORD REDIS_PASSWORD JWT_ACCESS_SECRET JWT_REFRESH_SECRET CREDENTIAL_ENCRYPTION_KEY BOOTSTRAP_ADMIN_PASSWORD; do
    if ! grep -q "^${v}=." .env.production || grep -q "^${v}=CHANGE_ME" .env.production; then
        MISSING+=("$v")
    fi
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
    # NOTE: only the names of missing/placeholder vars are recorded, never values.
    err "Missing or placeholder values for: ${MISSING[*]}" "AW-INSTALL-PREFLIGHT-002"
fi

phase_record "SECRETS" "PASS" "-"
ok "Secrets validated"

# ----- Step 3: build + start ----------------------------------------
ev_phase "DOCKER" "Build and start backend stack"
say "Step 3/7: Building and starting backend stack"

# Compose config validation is cheap and catches env/interpolation errors (§15).
if run_cmd DOCKER "$EV_F_DOCKER" "docker compose config" -- \
        sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production config; then
    _ev_kv_set docker_compose_config "VALID"
else
    _ev_kv_set docker_compose_config "INVALID"
    err "docker compose config is invalid — see ${RUN_DIR}/${EV_F_DOCKER}" "AW-INSTALL-DOCKER-001"
fi

_t0=$(date +%s)
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production build
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production up -d
phase_record "DOCKER" "PASS" "$(( $(date +%s) - _t0 ))s"

ok "Backend stack started"

# ----- Step 4: readiness check --------------------------------------
# AWM-STAB-002: gate rollout on READINESS (process + PostgreSQL), not just
# liveness. /readyz is 200 only when the DB is reachable.
ev_phase "READY" "Wait for backend readiness"
say "Step 4/7: Waiting for backend to become ready (/readyz)"

_ready=0
for i in {1..30}; do
    if curl -sf http://127.0.0.1:8081/readyz >/dev/null 2>&1; then
        ok "Backend is ready after ${i}s"
        _ready=1
        break
    fi
    sleep 1
done

# Capture container + migration + health evidence from the running stack.
run_cmd READY "$EV_F_DOCKER" "docker compose ps" -- \
    sudo docker compose -f deploy/docker-compose.production.yml ps || true
_ev_kv_set docker_containers "$(sudo docker compose -f deploy/docker-compose.production.yml ps --services 2>/dev/null | tr '\n' ' ')"
# Migration evidence (§13, §14): the backend runs migrations on startup; scrape
# the (sanitized) migration lines from its logs — never dumps data.
sudo docker compose -f deploy/docker-compose.production.yml logs auth-service 2>/dev/null \
    | grep -iE 'migrat' | ev_log_block "$EV_F_MIGRATIONS" "migration lines from auth-service logs" || true
_mig_start=$(sudo docker compose -f deploy/docker-compose.production.yml logs auth-service 2>/dev/null | grep -ioE 'applying migration[^0-9]*[0-9]+' | head -n1 | grep -oE '[0-9]+' || echo "?")
_mig_end=$(sudo docker compose -f deploy/docker-compose.production.yml logs auth-service 2>/dev/null | grep -ioE 'applying migration[^0-9]*[0-9]+' | tail -n1 | grep -oE '[0-9]+' || echo "?")
_ev_kv_set migration_start "$_mig_start"
_ev_kv_set migration_end "$_mig_end"
_ev_kv_set migration_result "$([[ $_ready -eq 1 ]] && echo PASS || echo UNKNOWN)"
_ev_kv_set postgres_version "$(sudo docker compose -f deploy/docker-compose.production.yml exec -T postgres postgres --version 2>/dev/null | head -n1 || echo unknown)"
_ev_kv_set postgres_connectivity "$([[ $_ready -eq 1 ]] && echo PASS || echo FAIL)"
_ev_kv_set app_backend "$([[ $_ready -eq 1 ]] && echo PASS || echo FAIL)"

hz="$(probe_http "/healthz" "http://127.0.0.1:8081/healthz" 200)" || true
rz="$(probe_http "/readyz"  "http://127.0.0.1:8081/readyz" 200)" || true
_ev_kv_set health_healthz "$hz"
_ev_kv_set health_readyz "$rz"
_ev_kv_set app_api "$hz"

if [[ $_ready -ne 1 ]]; then
    err "Backend did not become READY within 30 seconds (/readyz not 200 — check DB connectivity). Check logs: docker compose -f deploy/docker-compose.production.yml logs auth-service" "AW-INSTALL-READY-001"
fi
phase_record "READY" "PASS" "-"

# ----- Step 5: domain prompt ----------------------------------------
ev_phase "NGINX" "Configure nginx + TLS"
say "Step 5/7: Configuring nginx + TLS"

if [[ -z "${NETSPHERE_DOMAIN:-}" ]]; then
    echo
    read -rp "Enter your domain name (e.g. netsphere.example.com), or 'skip' to skip nginx setup: " NETSPHERE_DOMAIN
fi
_ev_kv_set tls_domain "$NETSPHERE_DOMAIN"

if [[ "$NETSPHERE_DOMAIN" == "skip" ]]; then
    # EVID-STATE-001: no nginx/TLS was configured, so the production HTTPS
    # endpoint is not active → PARTIAL, not SUCCESS.
    warn "Skipping nginx setup. Backend listens on 127.0.0.1:8081"
    _ev_kv_set nginx_service "skipped"
    _ev_kv_set tls_issuance "skipped"
    INSTALL_OUTCOME="PARTIAL"
    _ev_kv_set partial_reason "nginx/TLS setup was skipped; no public HTTPS endpoint was configured."
    ev_incomplete_gate "NGINX_HTTPS" "operator chose to skip nginx setup"
    ev_incomplete_gate "TLS_CERTIFICATE" "skipped (no nginx)"
else
    # DEPLOY-009: sanity-check the domain before involving Let's Encrypt.
    if [[ ! "$NETSPHERE_DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]]; then
        err "'$NETSPHERE_DOMAIN' does not look like a valid fully-qualified domain name."
    fi

    # ---- DEPLOY-PORT-001: operator-selected public HTTPS port -----------
    # Priority: 1) AWAMER_HTTPS_PORT (env/automation)  2) interactive prompt
    #           3) existing persisted port  4) default 443.
    # ACME HTTP-01 validation always uses TCP 80, independent of this port (§19).
    _existing_port=""
    if [[ -r "$DEPLOYMENT_CONF" ]]; then
        _existing_port="$(sudo sh -c ". '$DEPLOYMENT_CONF' 2>/dev/null; printf %s \"\${AWAMER_HTTPS_PORT:-}\"" 2>/dev/null || true)"
    fi
    if [[ -n "${AWAMER_HTTPS_PORT:-}" ]]; then
        HTTPS_PORT="$AWAMER_HTTPS_PORT"
        say "  Using HTTPS port from AWAMER_HTTPS_PORT: $HTTPS_PORT"
    elif [[ -t 0 ]]; then
        read -rp "Enter public HTTPS port [${_existing_port:-443}]: " _pin
        HTTPS_PORT="${_pin:-${_existing_port:-443}}"
    else
        HTTPS_PORT="${_existing_port:-443}"
        say "  Non-interactive: HTTPS port = $HTTPS_PORT (set AWAMER_HTTPS_PORT to override)"
    fi
    if ! validate_https_port "$HTTPS_PORT"; then
        preflight_check "HTTPS port valid" FAIL "$HTTPS_PORT"
        err "Invalid HTTPS port '$HTTPS_PORT' — must be an integer in 1..65535." "AW-INSTALL-PORT-001"
    fi
    preflight_check "HTTPS port valid" PASS "$HTTPS_PORT"
    if [[ "$HTTPS_PORT" -lt 1024 ]]; then
        say "  Note: $HTTPS_PORT is a privileged port; nginx binds it via its root master process."
    fi
    # Port conflict (§15/§28): FAIL if a NON-nginx process already owns it.
    _port_owner="$(ss -tlnpH "( sport = :$HTTPS_PORT )" 2>/dev/null \
        | grep -oE 'users:\(\("[^"]+"' | head -1 | sed 's/.*(("//' || true)"
    if [[ -n "$_port_owner" && "$_port_owner" != "nginx" ]]; then
        preflight_check "HTTPS port $HTTPS_PORT free" FAIL "in use by $_port_owner"
        err "Port $HTTPS_PORT is already in use by '$_port_owner' (not nginx). Free it or choose another port." "AW-INSTALL-PORT-002"
    fi
    preflight_check "HTTPS port $HTTPS_PORT free" PASS "available (or already served by nginx)"
    _ev_kv_set https_port "$HTTPS_PORT"
    _ev_kv_set public_url "$(build_public_https_url "$NETSPHERE_DOMAIN" "$HTTPS_PORT")"

    NGINX_CONF=/etc/nginx/sites-available/netsphere      # final HTTPS config
    BOOTSTRAP_CONF=/etc/nginx/sites-available/netsphere-bootstrap
    WEBROOT=/var/www/certbot
    LE_LIVE="/etc/letsencrypt/live/${NETSPHERE_DOMAIN}"
    LE_EMAIL="${LE_EMAIL:-admin@${NETSPHERE_DOMAIN#*.}}"
    sudo mkdir -p "$WEBROOT"

    # Render the FINAL HTTPS config from the template (domain + selected port)
    # but do NOT enable it yet — it references cert files that may not exist on
    # a fresh host. The port is already strictly numeric (validate_https_port).
    render_nginx_config deploy/nginx/netsphere.conf "$NETSPHERE_DOMAIN" "$HTTPS_PORT" \
        | sudo tee "$NGINX_CONF" >/dev/null
    sudo rm -f /etc/nginx/sites-enabled/default

    # Persist NON-SECRET deployment config (§26) so update.sh preserves the port.
    sudo mkdir -p "$(dirname "$DEPLOYMENT_CONF")"
    printf 'AWAMER_DOMAIN=%s\nAWAMER_HTTPS_PORT=%s\n' "$NETSPHERE_DOMAIN" "$HTTPS_PORT" \
        | sudo tee "$DEPLOYMENT_CONF" >/dev/null
    ev_action "Persisted deployment config $DEPLOYMENT_CONF (AWAMER_HTTPS_PORT=$HTTPS_PORT)"

    # enable_final(): point sites-enabled at the HTTPS config, validate, reload.
    # NEVER reloads on a failed `nginx -t` (keeps the running config intact).
    enable_final() {
        sudo ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/netsphere
        sudo rm -f /etc/nginx/sites-enabled/netsphere-bootstrap
        if sudo nginx -t 2>&1 | ev_log_block "$EV_F_NGINX" "nginx -t (final HTTPS config)"; sudo nginx -t >/dev/null 2>&1; then
            _ev_kv_set nginx_config_test "PASS"
            sudo systemctl reload nginx
            _ev_kv_set nginx_service "$(systemctl is-active nginx 2>/dev/null || echo unknown)"
            ok "HTTPS nginx config active for $NETSPHERE_DOMAIN"
        else
            _ev_kv_set nginx_config_test "FAIL"
            # Roll back to whatever was serving before (bootstrap, if present).
            sudo rm -f /etc/nginx/sites-enabled/netsphere
            [[ -f "$BOOTSTRAP_CONF" ]] && sudo ln -sf "$BOOTSTRAP_CONF" /etc/nginx/sites-enabled/netsphere-bootstrap
            sudo nginx -t >/dev/null 2>&1 && sudo systemctl reload nginx || true
            err "Final nginx config failed 'nginx -t' — HTTPS NOT activated. Check: sudo nginx -t" "AW-INSTALL-NGINX-001"
        fi
    }

    # ----- Step 6: TLS via Let's Encrypt -----------------------------
    ev_phase "TLS" "TLS certificate (Let's Encrypt)"
    say "Step 6/7: TLS certificate (Let's Encrypt)"

    if sudo test -f "${LE_LIVE}/fullchain.pem" && sudo test -f "${LE_LIVE}/privkey.pem"; then
        # DEPLOY-005/§15: a certificate already exists — do NOT reissue it.
        _ev_kv_set tls_cert_before "YES"
        _ev_kv_set tls_issuance "SKIPPED (cert already present)"
        ok "Existing certificate found for $NETSPHERE_DOMAIN — skipping issuance"
        enable_final
    else
        _ev_kv_set tls_cert_before "NO"
        # DEPLOY-002/§4: fresh host with no certificate. Serve an HTTP-only
        # bootstrap vhost first (ACME webroot on :80), obtain the cert, then
        # enable the final HTTPS config. The HTTPS config is NEVER activated
        # before its certificate exists.
        say "  No certificate yet — installing a temporary HTTP-only bootstrap vhost"
        sudo tee "$BOOTSTRAP_CONF" >/dev/null <<BOOT
server {
    listen 80;
    listen [::]:80;
    server_name ${NETSPHERE_DOMAIN};
    # ACME HTTP-01 challenge (Let's Encrypt writes tokens here).
    location /.well-known/acme-challenge/ { root ${WEBROOT}; }
    # Nothing else is exposed during bootstrap.
    location / { return 404; }
}
BOOT
        sudo ln -sf "$BOOTSTRAP_CONF" /etc/nginx/sites-enabled/netsphere-bootstrap
        sudo rm -f /etc/nginx/sites-enabled/netsphere
        ev_action "Created temporary HTTP-only ACME bootstrap vhost (webroot: $WEBROOT)"
        if ! sudo nginx -t; then
            _ev_kv_set nginx_config_test "FAIL"
            err "Bootstrap nginx config failed 'nginx -t'. Check: sudo nginx -t" "AW-INSTALL-NGINX-002"
        fi
        sudo systemctl reload nginx
        ok "Bootstrap HTTP vhost live on port 80 (ACME webroot: $WEBROOT)"

        echo
        echo "Let's Encrypt needs TCP 80 reachable and DNS for '$NETSPHERE_DOMAIN'"
        echo "to resolve to THIS server before issuing a certificate."
        read -rp "Continue with certbot certificate issuance? [Y/n]: " ANS
        if [[ "$ANS" == "n" || "$ANS" == "N" ]]; then
            # EVID-STATE-001: operator SKIPPED TLS. The production HTTPS endpoint
            # is NOT active, so this is PARTIAL — never SUCCESS. (A certbot
            # *failure*, handled below, remains FAILED.)
            _ev_kv_set tls_issuance "SKIPPED (operator declined)"
            INSTALL_OUTCOME="PARTIAL"
            _ev_kv_set partial_reason "TLS certificate issuance was skipped by the operator; the production HTTPS endpoint is not active."
            ev_incomplete_gate "TLS_CERTIFICATE" "operator declined certbot issuance"
            ev_incomplete_gate "HTTPS_ACTIVATION" "final HTTPS config not enabled (no certificate)"
            warn "Skipped certbot. HTTP bootstrap vhost left in place."
            warn "Issue later, then enable HTTPS:"
            warn "  sudo certbot certonly --webroot -w $WEBROOT -d $NETSPHERE_DOMAIN --agree-tos --no-eff-email -m $LE_EMAIL"
            warn "  sudo ln -sf $NGINX_CONF /etc/nginx/sites-enabled/netsphere && sudo rm -f /etc/nginx/sites-enabled/netsphere-bootstrap && sudo nginx -t && sudo systemctl reload nginx"
        else
            # DEPLOY-008/§8/§16: on certbot failure, exit non-zero and DO NOT
            # activate the (cert-less) HTTPS config — the bootstrap vhost stays.
            ev_action "Requested Let's Encrypt certificate via certbot webroot"
            if ! sudo certbot certonly --webroot -w "$WEBROOT" -d "$NETSPHERE_DOMAIN" \
                    --agree-tos --no-eff-email --non-interactive -m "$LE_EMAIL"; then
                _ev_kv_set tls_issuance "FAILED"
                _ev_kv_set tls_cert_after "NO"
                err "Certificate issuance FAILED. HTTPS config NOT activated (bootstrap vhost still serving). Verify DNS + inbound TCP 80, then re-run." "AW-INSTALL-TLS-001"
            fi
            _ev_kv_set tls_issuance "SUCCESS"
            ok "Certificate issued for $NETSPHERE_DOMAIN"
            enable_final
        fi
    fi

    # TLS evidence: record cert presence + PUBLIC expiry metadata only (§12).
    # The private key is NEVER read or copied into evidence.
    if sudo test -f "${LE_LIVE}/fullchain.pem"; then
        _ev_kv_set tls_cert_after "YES"
        _cert_exp="$(sudo openssl x509 -enddate -noout -in "${LE_LIVE}/fullchain.pem" 2>/dev/null | sed 's/notAfter=//' || echo unknown)"
        _ev_kv_set tls_expiry "$_cert_exp"
    else
        _ev_kv_set tls_cert_after "NO"
    fi
    phase_record "NGINX+TLS" "PASS" "-"
fi

# ----- Step 7: summary ----------------------------------------------
ev_phase "FINALIZE" "Finalize + generate evidence"
say "Step 7/7: Summary"

# Finalize with the actual outcome. SUCCESS only when every mandatory production
# gate completed; PARTIAL when TLS/HTTPS was intentionally left incomplete
# (EVID-STATE-001). Neither is a production-approval decision (§24/§49).
_finalize_once "$INSTALL_OUTCOME"

cat <<EOF

${GREEN}═══════════════════════════════════════════════════════════════${NC}
${GREEN}  NetSphere Terminal installation complete.${NC}
${GREEN}═══════════════════════════════════════════════════════════════${NC}

  Backend container:  netsphere-auth (port 8081, bound to 127.0.0.1)
  Postgres container: netsphere-postgres (volume: netsphere-postgres-data)
  Redis container:    netsphere-redis (volume: netsphere-redis-data)
EOF

if [[ "${NETSPHERE_DOMAIN:-}" != "skip" && -n "${NETSPHERE_DOMAIN:-}" ]]; then
    _pub_url="$(build_public_https_url "$NETSPHERE_DOMAIN" "$HTTPS_PORT")"
    cat <<EOF
  HTTPS Port:         ${HTTPS_PORT}
  Public URL:         ${_pub_url}
  Health check:       ${_pub_url}/healthz

  Desktop clients should be configured with:
    VITE_API_BASE_URL=${_pub_url}

  Required inbound ports (open in host firewall AND cloud security group):
    22/tcp    SSH administration
    80/tcp    Let's Encrypt HTTP-01 validation / HTTP→HTTPS redirect
    ${HTTPS_PORT}/tcp  Awamer HTTPS
EOF
fi

# EVID-SEC-002/§11/§43: never display or grep the bootstrap password.
_boot_user="$(grep -E '^BOOTSTRAP_ADMIN_USERNAME=' .env.production | cut -d= -f2- 2>/dev/null || true)"
_boot_email="$(grep -E '^BOOTSTRAP_ADMIN_EMAIL=' .env.production | cut -d= -f2- 2>/dev/null || true)"
cat <<EOF

  Bootstrap administrator (credentials are in .env.production, mode 600):
    Username: ${_boot_user:-admin}
    Email:    ${_boot_email:-<in .env.production>}
    Password: [not displayed]

  ${YELLOW}IMPORTANT:${NC}
    1. Sign in via a desktop client and CHANGE the bootstrap password.
    2. Back up .env.production to a secure password manager.
    3. Set up automated database backups (see deploy/scripts/backup.sh).
    4. Configure firewall: allow only 22 (SSH), 80, and ${HTTPS_PORT:-443} (Awamer HTTPS).

  Useful commands:
    Tail logs:          sudo docker compose -f deploy/docker-compose.production.yml logs -f auth-service
    Restart backend:    sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production restart auth-service
    Stop everything:    sudo docker compose -f deploy/docker-compose.production.yml down
    Database backup:    ./deploy/scripts/backup.sh
    Database shell:     sudo docker compose -f deploy/docker-compose.production.yml exec postgres psql -U netsphere
EOF

# ----- Installation evidence summary (§36/§60/§61) ------------------
# Disable the failure trap now that we have cleanly finalized.
trap - ERR

if [[ "$INSTALL_OUTCOME" == "PARTIAL" ]]; then
    # §32: automation must NOT read PARTIAL as a successful production install.
    # §34: never claim "production ready/approved" for PARTIAL.
    cat <<EOF

${YELLOW}INSTALLATION STATUS: PARTIAL${NC}

  Installation incomplete.
  TLS setup has not been completed — the production HTTPS endpoint is not active.

  Reason:    $(_ev_kv_get partial_reason)
$( [[ "${NETSPHERE_DOMAIN:-}" != "skip" && -n "${NETSPHERE_DOMAIN:-}" ]] && echo "  Selected HTTPS Port: ${HTTPS_PORT}" )
  Evidence:  ${RUN_DIR}/
  Report:    ${RUN_DIR}/${EV_F_REPORT}
  Manifest:  ${RUN_DIR}/${EV_F_MANIFEST}  (status: PARTIAL)

  Complete TLS later, then re-run, to reach SUCCESS.
  Support bundle: ./deploy/scripts/support-bundle.sh $(evidence_run_id)
EOF
    exit 2
fi

cat <<EOF

${GREEN}INSTALLATION COMPLETED${NC}

  Installation Status: SUCCESS  (installation validated — NOT production approval, §24/§49)
  Domain:    ${NETSPHERE_DOMAIN:-<none>}
$( [[ "${NETSPHERE_DOMAIN:-}" != "skip" && -n "${NETSPHERE_DOMAIN:-}" ]] && echo "  HTTPS Port: ${HTTPS_PORT}" && echo "  Public URL: $(build_public_https_url "$NETSPHERE_DOMAIN" "$HTTPS_PORT")" )
  Certificate: $(_ev_kv_get tls_cert_after 2>/dev/null || echo n/a)
  Nginx:     $(_ev_kv_get nginx_config_test 2>/dev/null || echo n/a)
  Evidence:  ${RUN_DIR}/
  Report:    ${RUN_DIR}/${EV_F_REPORT}
  Manifest:  ${RUN_DIR}/${EV_F_MANIFEST}

  Record a manual troubleshooting note:
    ./deploy/scripts/deployment-note.sh "what you did"
  Create a sanitized support bundle to send for review:
    ./deploy/scripts/support-bundle.sh $(evidence_run_id)
EOF
exit 0
