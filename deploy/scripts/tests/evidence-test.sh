#!/usr/bin/env bash
# =====================================================================
# Tests for the installation evidence library  (§45)
# =====================================================================
# Pure-bash test harness (no external test framework). Exercises:
#   run directory creation, previous-run preservation, error/warning/exit
#   recording, secret redaction, manifest + report generation, support
#   bundle generation, support-bundle secret scanning, failed-install
#   evidence preservation, successful-install finalization.
#
# Run:  bash deploy/scripts/tests/evidence-test.sh
# Exit: 0 = all passed, non-zero = failures.
# =====================================================================

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "${HERE}/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPTS}/../.." && pwd)"

TESTROOT="$(mktemp -d)"
trap 'rm -rf "$TESTROOT"' EXIT
export AWAMER_EVIDENCE_ROOT="${TESTROOT}/evidence"

PASS=0; FAIL=0
ok()   { printf '  \033[0;32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[0;31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
assert_eq()      { [[ "$1" == "$2" ]] && ok "$3" || bad "$3 (expected '$2', got '$1')"; }
assert_contains(){ grep -q -- "$2" "$1" && ok "$3" || bad "$3 (missing '$2' in $1)"; }
assert_absent()  { ! grep -rq -- "$2" "$1" && ok "$3" || bad "$3 (found '$2' in $1)"; }
assert_file()    { [[ -f "$1" ]] && ok "$2" || bad "$2 (no file $1)"; }

# shellcheck source=../lib/evidence.sh
source "${SCRIPTS}/lib/evidence.sh"

echo "== 1. run directory creation =="
evidence_init 2026-01-01_000000 >/dev/null
R1="$(evidence_dir)"
assert_file "$R1/${EV_F_ACTIONS}" "run directory + seed files created"
assert_eq "$(evidence_run_id)" "2026-01-01_000000" "run id set"

echo "== 2. previous run is never overwritten (§2) =="
evidence_init 2026-01-01_000000 >/dev/null
R2="$(evidence_dir)"
[[ "$R1" != "$R2" ]] && ok "second init with same id gets a new dir" || bad "collision overwrote previous run"
[[ -d "$R1" && -d "$R2" ]] && ok "both run dirs preserved" || bad "a run dir vanished"

echo "== 3. secret redaction (§8/§9) =="
red="$(printf 'DATABASE_PASSWORD=topsecret\nJWT_SECRET=aa.bb.cc\nResult: PASS\nAuthorization: Bearer xyz.tok\napi_key: "k123"\n' | redact_stream)"
grep -q 'DATABASE_PASSWORD=\[REDACTED\]' <<<"$red" && ok "password redacted" || bad "password not redacted"
grep -q 'JWT_SECRET=\[REDACTED\]' <<<"$red" && ok "jwt secret redacted" || bad "jwt not redacted"
grep -q 'Result: PASS' <<<"$red" && ok "non-secret 'Result: PASS' preserved" || bad "over-redacted PASS"
grep -q 'Authorization: \[REDACTED\]' <<<"$red" && ok "authorization header redacted" || bad "auth header leaked"
grep -q 'topsecret\|aa.bb.cc\|xyz.tok\|k123' <<<"$red" && bad "a raw secret survived" || ok "no raw secret survived"

echo "== 4. error + warning + kv recording =="
evidence_init 2026-02-02_000000 >/dev/null
R="$(evidence_dir)"
ev_phase "TLS" "tls"
ev_error "TLS" "certbot" 1 "AW-INSTALL-TLS-001" "issuance failed for host"
ev_warn "low disk space"
assert_contains "$R/${EV_F_ERRORS}" "AW-INSTALL-TLS-001" "error code recorded in 10-errors.log"
assert_contains "$R/${EV_F_WARNINGS}" "low disk space" "warning recorded in 11-warnings.log"
# warnings must NOT be mixed into the errors file
grep -q "low disk space" "$R/${EV_F_ERRORS}" && bad "warning leaked into errors file" || ok "warnings separate from errors (§20)"

echo "== 5. kv_set redacts sensitive values even split across args (§9) =="
_ev_kv_set BOOTSTRAP_ADMIN_PASSWORD "hunter2"
_ev_kv_set nginx_version "1.24.0"
assert_absent "$R/.manifest" "hunter2" "sensitive kv value redacted at rest"

echo "== 6. command logging with exit code + duration (§7/§31) =="
run_cmd TEST "$EV_F_APP" "true cmd" -- true
assert_contains "$R/${EV_F_APP}" "Result: PASS" "successful command logged PASS"
run_cmd TEST "$EV_F_APP" "false cmd" -- false || true
assert_contains "$R/${EV_F_APP}" "Result: FAIL" "failed command logged FAIL"
assert_contains "$R/${EV_F_APP}" "Duration:" "duration recorded"

echo "== 7. manifest generation is valid JSON (§29) =="
_ev_kv_set health_healthz 200
evidence_finalize SUCCESS
assert_file "$R/${EV_F_MANIFEST}" "manifest created"
if command -v jq >/dev/null 2>&1; then
    jq -e . "$R/${EV_F_MANIFEST}" >/dev/null 2>&1 && ok "manifest is valid JSON" || bad "manifest invalid JSON"
    assert_eq "$(jq -r .meta.status "$R/${EV_F_MANIFEST}")" "SUCCESS" "manifest status=SUCCESS"
    assert_eq "$(jq -r '.errors[0].error_code' "$R/${EV_F_MANIFEST}")" "AW-INSTALL-TLS-001" "manifest carries error code"
else
    python3 -c "import json,sys;json.load(open('$R/${EV_F_MANIFEST}'))" && ok "manifest valid JSON (python)" || bad "manifest invalid JSON"
fi

echo "== 8. report generation (§25) =="
assert_file "$R/${EV_F_REPORT}" "report created"
assert_contains "$R/${EV_F_REPORT}" "Final Installation Status" "report has status section"
assert_contains "$R/${EV_F_REPORT}" "NOT" "report states it is NOT production approval (§24/§49)"

echo "== 9. successful finalization (§24) + failed preservation (§23) =="
evidence_init 2026-03-03_000000 >/dev/null
RS="$(evidence_dir)"; evidence_finalize SUCCESS
assert_contains "$RS/${EV_F_MANIFEST}" '"status":"SUCCESS"' "success run finalized SUCCESS"
evidence_init 2026-03-03_111111 >/dev/null
RF="$(evidence_dir)"
ev_phase "DOCKER" "docker"
ev_error "DOCKER" "compose up" 1 "AW-INSTALL-DOCKER-001" "daemon down"
evidence_finalize FAILED "DOCKER" "docker compose up -d" 1 "AW-INSTALL-DOCKER-001"
assert_contains "$RF/${EV_F_MANIFEST}" '"status":"FAILED"' "failed run finalized FAILED"
[[ -d "$RF" && -f "$RF/${EV_F_ERRORS}" ]] && ok "failed-install evidence preserved (§23)" || bad "failed evidence lost"

echo "== 10. support bundle generation + secret scan (§37/§38/§39) =="
# inject a raw secret into an evidence file (simulating a redactor miss)
echo "DATABASE_PASSWORD=rawsecretvalue" >> "$RS/${EV_F_APP}"
BUNDLE_OUT="${TESTROOT}/out"; mkdir -p "$BUNDLE_OUT"
AWAMER_EVIDENCE_ROOT="$AWAMER_EVIDENCE_ROOT" bash "${SCRIPTS}/support-bundle.sh" --out "$BUNDLE_OUT" "$(basename "$RS")" >/dev/null 2>&1
BUNDLE="${BUNDLE_OUT}/awamer-installation-$(basename "$RS").tar.gz"
assert_file "$BUNDLE" "support bundle archive created"
mkdir -p "${TESTROOT}/x"; tar xzf "$BUNDLE" -C "${TESTROOT}/x"
assert_absent "${TESTROOT}/x" "rawsecretvalue" "bundle re-redacted the injected raw secret (§37)"

echo "== 11. bundle secret scanner rejects a genuinely un-redacted secret (§39) =="
# Extract the scanner's scan_file() from the bundle script and unit-test it.
# (_EV_SENSITIVE_WORDS is already defined by the sourced evidence library.)
eval "$(sed -n '/^scan_file()/,/^}/p' "${SCRIPTS}/support-bundle.sh")"
printf 'DATABASE_PASSWORD=actual-real-value-123\n' > "${TESTROOT}/leak.txt"
printf 'DATABASE_PASSWORD=[REDACTED]\nResult: PASS\n' > "${TESTROOT}/clean.txt"
printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n' > "${TESTROOT}/pem.txt"
if scan_file "${TESTROOT}/leak.txt"; then ok "scanner detects a real KEY=value leak"; else bad "scanner missed a real leak"; fi
if scan_file "${TESTROOT}/pem.txt"; then ok "scanner detects a raw private key"; else bad "scanner missed a private key"; fi
if scan_file "${TESTROOT}/clean.txt"; then bad "scanner false-positive on redacted+PASS"; else ok "scanner clean on redacted content"; fi

echo
echo "================ evidence-test summary ================"
echo "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]]
