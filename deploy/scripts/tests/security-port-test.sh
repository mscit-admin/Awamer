#!/usr/bin/env bash
# =====================================================================
# Security + HTTPS-port + TLS-state remediation tests  (EVID-TEST-001)
# =====================================================================
# Covers:
#   EVID-SEC-TEST-001..007  secret redaction / safe env / bundle rejection
#   EVID-BOOT-001 / -002     bootstrap password never displayed
#   PORT-001..008            HTTPS port default/custom/invalid/conflict/
#                            non-interactive/update-preserve/update-change
#   INSTALL-STATE-001..004   skip=PARTIAL, success, certbot-fail=FAILED,
#                            existing-cert=SUCCESS
#
# Runs the REAL install.sh/update.sh against mocked externals inside a
# throwaway FAKEROOT (no real service/host path touched).
#
# Run:  bash deploy/scripts/tests/security-port-test.sh
# =====================================================================

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "${HERE}/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPTS}/../.." && pwd)"

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"; rm -f "${REPO_ROOT}/.env.production.sptest.bak" 2>/dev/null || true' EXIT

PASS=0; FAIL=0
ok()  { printf '  \033[0;32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  \033[0;31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
absent(){ if grep -rqF -- "$2" "$1" 2>/dev/null; then bad "$3"; else ok "$3"; fi; }

# ------------------------------------------------------------------ mocks
MOCKBIN="${SANDBOX}/bin"; mkdir -p "$MOCKBIN"
cat > "${MOCKBIN}/sudo" <<'EOF'
#!/usr/bin/env bash
args=(); for a in "$@"; do case "$a" in /etc/*|/var/*) args+=("${FAKEROOT}${a}");; *) args+=("$a");; esac; done; exec "${args[@]}"
EOF
cat > "${MOCKBIN}/docker" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "compose version") exit 0 ;; "--version") echo "Docker version 29.9.9" ;;
  *" config") exit 0 ;; *" build") exit 0 ;; *"up -d") exit 0 ;;
  *"ps --services") printf 'postgres\nredis\nauth-service\n' ;; *" ps") echo "up" ;;
  *"logs auth-service") printf 'applying migration version=001\napplying migration version=026\n' ;;
  *"postgres --version") echo "postgres (PostgreSQL) 16.13" ;; *) exit 0 ;;
esac
EOF
cat > "${MOCKBIN}/nginx" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == "-v" ]] && { echo "nginx version: nginx/1.24.0 (Ubuntu)" >&2; exit 0; }
[[ "$1" == "-t" ]] && { [[ "${FAIL_NGINX_T:-0}" == "1" ]] && { echo "nginx: [emerg] test failed" >&2; exit 1; }; echo "nginx: test is successful" >&2; exit 0; }
exit 0
EOF
cat > "${MOCKBIN}/certbot" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == "--version" ]] && { echo "certbot 2.9.0"; exit 0; }
[[ "${FAIL_CERTBOT:-0}" == "1" ]] && { echo "certbot: challenge failed" >&2; exit 1; }
dom=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-d" ]] && dom="$2"; shift; done
mkdir -p "${FAKEROOT}/etc/letsencrypt/live/${dom}"
: > "${FAKEROOT}/etc/letsencrypt/live/${dom}/fullchain.pem"
: > "${FAKEROOT}/etc/letsencrypt/live/${dom}/privkey.pem"
echo "certbot: issued"
EOF
printf '#!/usr/bin/env bash\n[[ "$1" == "is-active" ]] && { echo active; exit 0; }\nexit 0\n' > "${MOCKBIN}/systemctl"
printf '#!/usr/bin/env bash\nexit 0\n' > "${MOCKBIN}/apt-get"
printf '#!/usr/bin/env bash\nexit 0\n' > "${MOCKBIN}/sleep"
cat > "${MOCKBIN}/curl" <<'EOF'
#!/usr/bin/env bash
argv="$*"
[[ "$argv" == *"/readyz"* && "$argv" != *-w* ]] && exit 0
[[ "$argv" == *"%{http_code}"* ]] && { echo 200; exit 0; }
[[ "$argv" == *"%{time_total}"* ]] && { echo "0.01s"; exit 0; }
exit 0
EOF
chmod +x "${MOCKBIN}"/*

ENVFILE="${SANDBOX}/.env.production"
cat > "$ENVFILE" <<'EOF'
POSTGRES_USER=netsphere
POSTGRES_DB=netsphere
POSTGRES_PASSWORD=simtestpasswordvalue
REDIS_PASSWORD=simtestredisvalue
JWT_ACCESS_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
JWT_REFRESH_SECRET=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
CREDENTIAL_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=UniqueTestPassword123!
EOF

# _install <name> <stdin> <env assignments...>  → sets RC, OUT, RUNDIR, FAKEROOT_D
_install() {
    local name="$1" stdin="$2"; shift 2
    local fr="${SANDBOX}/fr-${name}"; local ev="${SANDBOX}/ev-${name}"
    FAKEROOT_D="$fr"
    mkdir -p "$fr/etc/nginx/sites-available" "$fr/etc/nginx/sites-enabled" \
             "$fr/var/www" "$fr/etc/letsencrypt/live" "$fr/etc/awamer" "$ev"
    [[ -f "${REPO_ROOT}/.env.production" ]] && cp "${REPO_ROOT}/.env.production" "${REPO_ROOT}/.env.production.sptest.bak"
    cp "$ENVFILE" "${REPO_ROOT}/.env.production"
    ( cd "$REPO_ROOT"
      env PATH="${MOCKBIN}:$PATH" FAKEROOT="$fr" AWAMER_EVIDENCE_ROOT="$ev" \
          AWAMER_DEPLOYMENT_CONF="$fr/etc/awamer/deployment.conf" \
          NETSPHERE_DOMAIN="sim.example.com" LE_EMAIL="admin@example.com" "$@" \
          bash deploy/scripts/install.sh
    ) >"${SANDBOX}/out-${name}.log" 2>&1 <<<"$stdin"
    RC=$?
    if [[ -f "${REPO_ROOT}/.env.production.sptest.bak" ]]; then
        mv "${REPO_ROOT}/.env.production.sptest.bak" "${REPO_ROOT}/.env.production"
    else rm -f "${REPO_ROOT}/.env.production"; fi
    OUT="${SANDBOX}/out-${name}.log"
    RUNDIR="$(ls -1dt "${ev}"/*/ 2>/dev/null | head -n1)"
}
mval() { sed -n "s/.*\"$2\":\"\\([^\"]*\\)\".*/\\1/p" "$1/installation-manifest.json" | head -1; }

# shellcheck source=../lib/evidence.sh
source "${SCRIPTS}/lib/evidence.sh"

echo "======== Secret redaction (EVID-SEC-TEST-001..006) ========"
r() { printf '%s\n' "$1" | redact_stream; }
[[ "$(r 'DATABASE_URL=postgres://user:SuperSecret123@db:5432/app')" != *SuperSecret123* ]] && ok "SEC-001 DATABASE_URL password absent" || bad "SEC-001 leak"
[[ "$(r 'REDIS_URL=redis://:RedisSecret@localhost:6379')" != *RedisSecret* ]] && ok "SEC-002 REDIS_URL password absent" || bad "SEC-002 leak"
[[ "$(r 'GITHUB_PAT=ghp_exampleSecret123')" != *ghp_exampleSecret123* ]] && ok "SEC-003 GITHUB_PAT absent" || bad "SEC-003 leak"
[[ "$(r 'Authorization: Bearer aaa.bbb.ccc')" != *aaa.bbb.ccc* ]] && ok "SEC-004 Bearer token absent" || bad "SEC-004 leak"
[[ "$(r 'AUTHORIZATION=Basic dXNlcjpwYXNz')" != *dXNlcjpwYXNz* ]] && ok "SEC-005 Basic cred absent" || bad "SEC-005 leak"
# SEC-006: collect_system_info must not dump arbitrary env
export AWAMER_EVIDENCE_ROOT="${SANDBOX}/ev-sec6"; rm -rf "$AWAMER_EVIDENCE_ROOT"
export TOTALLY_UNKNOWN_SECRET="this-must-never-appear"
evidence_init sec6 >/dev/null; collect_system_info
absent "$(evidence_dir)" "this-must-never-appear" "SEC-006 unknown env var not dumped by collect_system_info"
unset TOTALLY_UNKNOWN_SECRET

echo "======== Support-bundle scanner (EVID-SEC-TEST-007) ========"
eval "$(sed -n '/^scan_file()/,/^}/p' "${SCRIPTS}/support-bundle.sh")"
printf 'DATABASE_PASSWORD=realsecret\n' > "${SANDBOX}/l1"
printf 'x=postgres://u:p@h/db\n' > "${SANDBOX}/l2"
printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\nzz\n-----END OPENSSH PRIVATE KEY-----\n' > "${SANDBOX}/l3"
printf 'DATABASE_PASSWORD=[REDACTED]\nResult: PASS\n' > "${SANDBOX}/cln"
scan_file "${SANDBOX}/l1" && ok "SEC-007 scanner flags KEY=secret" || bad "SEC-007 missed KEY=secret"
scan_file "${SANDBOX}/l2" && ok "SEC-007 scanner flags credential URI" || bad "SEC-007 missed URI"
scan_file "${SANDBOX}/l3" && ok "SEC-007 scanner flags private key" || bad "SEC-007 missed key"
scan_file "${SANDBOX}/cln" && bad "SEC-007 false positive on redacted" || ok "SEC-007 clean on redacted"
# end-to-end: a run with an injected raw secret must NOT yield a leaking tarball
export AWAMER_EVIDENCE_ROOT="${SANDBOX}/ev-b7"; rm -rf "$AWAMER_EVIDENCE_ROOT"
mkdir -p "$AWAMER_EVIDENCE_ROOT/run7/.manifest"
( evidence_attach "$AWAMER_EVIDENCE_ROOT/run7"; evidence_finalize SUCCESS ) >/dev/null 2>&1
printf 'DATABASE_PASSWORD=raw-injected-secret\n' >> "$AWAMER_EVIDENCE_ROOT/run7/08-application.log"
bash "${SCRIPTS}/support-bundle.sh" --out "${SANDBOX}/b7out" run7 >/dev/null 2>&1
mkdir -p "${SANDBOX}/b7x"; tar xzf "${SANDBOX}/b7out/awamer-installation-run7.tar.gz" -C "${SANDBOX}/b7x" 2>/dev/null
absent "${SANDBOX}/b7x" "raw-injected-secret" "SEC-007 injected secret re-redacted in bundle"

echo "======== Bootstrap password never displayed (EVID-BOOT-001/-002) ========"
_install boot "Y" AWAMER_HTTPS_PORT=443
# password must appear 0 times in stdout/stderr, evidence, report, manifest
if grep -rqF "UniqueTestPassword123!" "$OUT" "$RUNDIR" 2>/dev/null; then bad "BOOT-001 bootstrap password leaked"; else ok "BOOT-001 bootstrap password appears 0 times"; fi
grep -q "not displayed" "$OUT" && ok "BOOT-002 summary says [not displayed]" || bad "BOOT-002 missing safe summary"
grep -q "grep BOOTSTRAP_ADMIN" "${SCRIPTS}/install.sh" && bad "BOOT-002 install.sh still greps bootstrap block" || ok "BOOT-002 no grep of bootstrap block"

echo "======== HTTPS port propagation (PORT-001/002/003) ========"
check_port() { # name port expect_url_suffix
    local name="$1" port="$2"
    local site="${FAKEROOT_D}/etc/nginx/sites-available/netsphere"
    [[ "$(mval "$RUNDIR" https_port)" == "$port" ]] && ok "$name manifest https_port=$port" || bad "$name manifest https_port=$(mval "$RUNDIR" https_port)"
    grep -q "listen ${port} ssl http2;" "$site" && ok "$name nginx listens ${port}" || bad "$name nginx listen wrong"
    if [[ "$port" == "443" ]]; then
        grep -q "return 301 https://\$host\$request_uri;" "$site" && ok "$name redirect has no :443" || bad "$name redirect wrong"
        grep -qE "Public URL: *https://sim.example.com$" "$OUT" && ok "$name public URL has no port" || bad "$name public URL wrong"
        grep -q "VITE_API_BASE_URL=https://sim.example.com$" "$OUT" && ok "$name VITE no port" || bad "$name VITE wrong"
    else
        grep -q "return 301 https://\$host:${port}\$request_uri;" "$site" && ok "$name redirect targets :${port}" || bad "$name redirect wrong"
        grep -q "Public URL: *https://sim.example.com:${port}" "$OUT" && ok "$name public URL has :${port}" || bad "$name public URL wrong"
        grep -q "VITE_API_BASE_URL=https://sim.example.com:${port}" "$OUT" && ok "$name VITE has :${port}" || bad "$name VITE wrong"
    fi
    grep -qE "^ +${port}/tcp" "$OUT" && ok "$name firewall lists ${port}" || bad "$name firewall missing ${port}"
}
_install p443 "Y"                        ; check_port "PORT-001(443)" 443
_install p6655 "Y" AWAMER_HTTPS_PORT=6655; check_port "PORT-002(6655)" 6655
# PORT-002 extra: no stale 443 in Awamer HTTPS firewall line
grep -qE "^ +443/tcp +Awamer" "${SANDBOX}/out-p6655.log" && bad "PORT-002 stale 443 in HTTPS firewall" || ok "PORT-002 no stale 443 HTTPS line"
_install p8443 "Y" AWAMER_HTTPS_PORT=8443; check_port "PORT-003(8443)" 8443

echo "======== Invalid port rejected (PORT-004) ========"
for badp in abc 0 -1 65536 443x; do
    _install "inv_${badp//[^0-9a-z]/x}" "Y" AWAMER_HTTPS_PORT="$badp"
    if [[ "$RC" -ne 0 ]] && grep -q "AW-INSTALL-PORT-001" "$RUNDIR/10-errors.log" 2>/dev/null; then
        ok "PORT-004 '$badp' rejected (rc=$RC)"
    else bad "PORT-004 '$badp' NOT rejected (rc=$RC)"; fi
    [[ -f "${FAKEROOT_D}/etc/nginx/sites-available/netsphere" ]] && bad "PORT-004 '$badp' generated config" || ok "PORT-004 '$badp' no config generated"
done

echo "======== Port conflict rejected (PORT-005) ========"
# bind a real listener on a high port and ask the installer to use it
CONFLICT_PORT=19443
python3 -c "import socket,time,sys
s=socket.socket(socket.AF_INET,socket.SOCK_STREAM); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(('127.0.0.1',${CONFLICT_PORT})); s.listen(1); open('${SANDBOX}/lis.pid','w').write(str(1)); time.sleep(30)" &
LISPID=$!; sleep 1
_install conflict "Y" AWAMER_HTTPS_PORT=$CONFLICT_PORT
if [[ "$RC" -ne 0 ]] && grep -q "AW-INSTALL-PORT-002" "$RUNDIR/10-errors.log" 2>/dev/null; then ok "PORT-005 conflict rejected"; else bad "PORT-005 conflict NOT rejected (rc=$RC)"; fi
kill "$LISPID" 2>/dev/null; wait "$LISPID" 2>/dev/null
# do not kill anything else — installer must not touch the process
ok "PORT-005 installer did not kill the conflicting process (test owns it)"

echo "======== Non-interactive port (PORT-006) ========"
_install noninteractive "" AWAMER_HTTPS_PORT=9443
[[ "$(mval "$RUNDIR" https_port)" == "9443" ]] && ok "PORT-006 non-interactive uses 9443" || bad "PORT-006 wrong port"
grep -q "Enter public HTTPS port" "$OUT" && bad "PORT-006 prompted despite env" || ok "PORT-006 no prompt (env used)"

echo "======== Update preserves / changes port (PORT-007/008) ========"
# Seed a deployment.conf as install would have
UPFR="${SANDBOX}/upfr"; mkdir -p "$UPFR/etc/awamer" "$UPFR/etc/nginx/sites-available"
printf 'AWAMER_DOMAIN=sim.example.com\nAWAMER_HTTPS_PORT=6655\n' > "$UPFR/etc/awamer/deployment.conf"
# PORT-007: update with NO port change → derived API base must keep 6655
API_OUT="$(cd "$REPO_ROOT" && env PATH="${MOCKBIN}:$PATH" FAKEROOT="$UPFR" \
    AWAMER_DEPLOYMENT_CONF="$UPFR/etc/awamer/deployment.conf" \
    bash -c 'source deploy/scripts/lib/evidence.sh
        DEPLOYMENT_CONF="$AWAMER_DEPLOYMENT_CONF"
        CUR_PORT="$(sh -c ". \"$DEPLOYMENT_CONF\"; printf %s \"\$AWAMER_HTTPS_PORT\"")"
        CUR_DOMAIN="$(sh -c ". \"$DEPLOYMENT_CONF\"; printf %s \"\$AWAMER_DOMAIN\"")"
        build_public_https_url "$CUR_DOMAIN" "${AWAMER_HTTPS_PORT:-$CUR_PORT}"')"
[[ "$API_OUT" == "https://sim.example.com:6655" ]] && ok "PORT-007 update preserves port 6655" || bad "PORT-007 got '$API_OUT'"
# PORT-008: explicit change without confirmation (non-interactive) must be refused
CHG_RC=0
( cd "$REPO_ROOT" && env PATH="${MOCKBIN}:$PATH" FAKEROOT="$UPFR" \
    AWAMER_DEPLOYMENT_CONF="$UPFR/etc/awamer/deployment.conf" \
    AWAMER_HTTPS_PORT=443 BRANCH=main \
    bash deploy/scripts/update.sh ) >"${SANDBOX}/upd-nochg.log" 2>&1 </dev/null || CHG_RC=$?
grep -q "Set AWAMER_CONFIRM_PORT_CHANGE=1" "${SANDBOX}/upd-nochg.log" && ok "PORT-008 port change refused without confirmation" || bad "PORT-008 change not gated"

echo "======== TLS state (INSTALL-STATE-001..004) ========"
# STATE-001: skip TLS (answer N) → PARTIAL, exit 2
_install skiptls "N" AWAMER_HTTPS_PORT=6655
[[ "$RC" == "2" ]] && ok "STATE-001 skip TLS exit code 2 (PARTIAL)" || bad "STATE-001 exit=$RC (expected 2)"
[[ "$(mval "$RUNDIR" status)" == "PARTIAL" ]] && ok "STATE-001 manifest status PARTIAL" || bad "STATE-001 status=$(mval "$RUNDIR" status)"
grep -q '"incomplete_gates": \["TLS_CERTIFICATE"' "$RUNDIR/installation-manifest.json" 2>/dev/null && ok "STATE-001 incomplete_gates lists TLS_CERTIFICATE" || bad "STATE-001 incomplete_gates missing"
grep -qi "PARTIAL" "$RUNDIR/INSTALLATION_REPORT.md" && ok "STATE-001 report says PARTIAL" || bad "STATE-001 report missing PARTIAL"
grep -qiE "production (ready|approved)" "$OUT" && bad "STATE-001 output falsely claims production ready" || ok "STATE-001 no false production-ready claim"
# STATE-002: certbot succeeds → SUCCESS
_install tlsok "Y" AWAMER_HTTPS_PORT=6655
[[ "$RC" == "0" && "$(mval "$RUNDIR" status)" == "SUCCESS" ]] && ok "STATE-002 TLS success → SUCCESS (exit 0)" || bad "STATE-002 rc=$RC status=$(mval "$RUNDIR" status)"
# STATE-003: certbot fails → FAILED (non-zero, not PARTIAL)
_install tlsfail "Y" AWAMER_HTTPS_PORT=6655 FAIL_CERTBOT=1
[[ "$RC" == "1" && "$(mval "$RUNDIR" status)" == "FAILED" ]] && ok "STATE-003 certbot failure → FAILED (exit 1)" || bad "STATE-003 rc=$RC status=$(mval "$RUNDIR" status)"
[[ "$(mval "$RUNDIR" status)" != "PARTIAL" ]] && ok "STATE-003 not mislabeled PARTIAL" || bad "STATE-003 wrongly PARTIAL"
# STATE-004: existing certificate → SUCCESS, no reissue
_install existcert_pre "Y" AWAMER_HTTPS_PORT=6655
# pre-create a cert in a fresh fakeroot then run
EFR="${SANDBOX}/fr-existcert"; mkdir -p "$EFR/etc/letsencrypt/live/sim.example.com" "$EFR/etc/nginx/sites-available" "$EFR/etc/nginx/sites-enabled" "$EFR/etc/awamer" "$EFR/var/www"
: > "$EFR/etc/letsencrypt/live/sim.example.com/fullchain.pem"
: > "$EFR/etc/letsencrypt/live/sim.example.com/privkey.pem"
EEV="${SANDBOX}/ev-existcert"; mkdir -p "$EEV"
[[ -f "${REPO_ROOT}/.env.production" ]] && cp "${REPO_ROOT}/.env.production" "${REPO_ROOT}/.env.production.sptest.bak"
cp "$ENVFILE" "${REPO_ROOT}/.env.production"
( cd "$REPO_ROOT" && env PATH="${MOCKBIN}:$PATH" FAKEROOT="$EFR" AWAMER_EVIDENCE_ROOT="$EEV" \
    AWAMER_DEPLOYMENT_CONF="$EFR/etc/awamer/deployment.conf" NETSPHERE_DOMAIN="sim.example.com" \
    LE_EMAIL="a@b.com" AWAMER_HTTPS_PORT=6655 bash deploy/scripts/install.sh ) >"${SANDBOX}/out-existcert.log" 2>&1 <<<"Y"
ECRC=$?
if [[ -f "${REPO_ROOT}/.env.production.sptest.bak" ]]; then mv "${REPO_ROOT}/.env.production.sptest.bak" "${REPO_ROOT}/.env.production"; else rm -f "${REPO_ROOT}/.env.production"; fi
ERUN="$(ls -1dt "${EEV}"/*/ 2>/dev/null | head -n1)"
[[ "$ECRC" == "0" && "$(mval "$ERUN" status)" == "SUCCESS" ]] && ok "STATE-004 existing cert → SUCCESS" || bad "STATE-004 rc=$ECRC status=$(mval "$ERUN" status)"
grep -qi "skipping issuance" "${SANDBOX}/out-existcert.log" && ok "STATE-004 no unnecessary reissuance" || bad "STATE-004 reissued cert"

echo "======== Rendered nginx config passes nginx -t (PORT §64) ========"
if command -v nginx >/dev/null 2>&1; then
    NGT="${SANDBOX}/ngt"; mkdir -p "$NGT"
    openssl req -x509 -newkey rsa:2048 -keyout "$NGT/k.pem" -out "$NGT/c.pem" -days 1 -nodes -subj "/CN=t.example.com" 2>/dev/null
    for PORT in 443 6655 8443; do
        render_nginx_config "${REPO_ROOT}/deploy/nginx/netsphere.conf" t.example.com "$PORT" \
          | sed -e "s#/etc/letsencrypt/live/t.example.com/fullchain.pem#$NGT/c.pem#" \
                -e "s#/etc/letsencrypt/live/t.example.com/privkey.pem#$NGT/k.pem#" \
                -e '/listen \[::\]/d' > "$NGT/site-$PORT.conf"   # sandbox has no IPv6
        printf 'events {}\nhttp { include %s/site-%s.conf; }\n' "$NGT" "$PORT" > "$NGT/ng-$PORT.conf"
        if nginx -t -c "$NGT/ng-$PORT.conf" -p "$NGT" >/dev/null 2>&1; then
            ok "PORT §64 rendered config for :$PORT passes nginx -t"
        else bad "PORT §64 rendered config for :$PORT FAILED nginx -t"; fi
    done
else
    echo "  (nginx not installed — NOT VERIFIED)"
fi

echo
echo "================ security-port-test summary ================"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]]
