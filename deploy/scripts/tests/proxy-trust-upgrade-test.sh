#!/usr/bin/env bash
# =====================================================================
# SEC-PROXY-001 — TRUST_PROXY upgrade migration (F1 tighten)
#   PROXY-UPGRADE-001  old generated default "loopback, uniquelocal" → "loopback"
#   PROXY-UPGRADE-002  an administrator-customized value is NOT overwritten
#   PROXY-UPGRADE-003  a missing key is added as the secure default "loopback"
#   PROXY-UPGRADE-004  a broad custom value is preserved but WARNED about
# Drives the REAL update.sh (aborts at HTTPS resolution — no git/docker/nginx).
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../../.." && pwd)"
SANDBOX="$(mktemp -d)"; trap 'rm -rf "$SANDBOX"' EXIT
PASS=0; FAIL=0
ok(){ printf '  \033[0;32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad(){ printf '  \033[0;31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }

run_update() { ( cd "$REPO_ROOT" && ENV_FILE="$1" AWAMER_DEPLOYMENT_CONF="${SANDBOX}/nope.conf" bash deploy/scripts/update.sh ) 2>&1; }
mkenv() { printf 'VPN_HELPER_SECRET=%s\n' "$(printf 'd%.0s' {1..64})" > "$1"; [[ -n "${2:-}" ]] && printf 'TRUST_PROXY=%s\n' "$2" >> "$1"; chmod 600 "$1"; }
tp() { grep -E '^TRUST_PROXY=' "$1" | head -1 | cut -d= -f2-; }

# PROXY-UPGRADE-001: exact old broad default → tightened to loopback
E1="$SANDBOX/old.env"; mkenv "$E1" "loopback, uniquelocal"
OUT1="$(run_update "$E1" || true)"
[[ "$(tp "$E1")" == "loopback" ]] && ok "PROXY-UPGRADE-001 old default migrated to loopback" || bad "PROXY-UPGRADE-001 got '$(tp "$E1")'"
echo "$OUT1" | grep -qi "Migrated the old broad TRUST_PROXY" && ok "PROXY-UPGRADE-001 migration announced" || bad "no migration message"

# PROXY-UPGRADE-002: administrator-customized value preserved
E2="$SANDBOX/custom.env"; mkenv "$E2" "loopback,172.20.0.5/32"
run_update "$E2" >/dev/null 2>&1 || true
[[ "$(tp "$E2")" == "loopback,172.20.0.5/32" ]] && ok "PROXY-UPGRADE-002 custom value preserved" || bad "PROXY-UPGRADE-002 got '$(tp "$E2")'"

# PROXY-UPGRADE-003: missing key added as loopback
E3="$SANDBOX/none.env"; mkenv "$E3"
run_update "$E3" >/dev/null 2>&1 || true
[[ "$(tp "$E3")" == "loopback" ]] && ok "PROXY-UPGRADE-003 missing key added as loopback" || bad "PROXY-UPGRADE-003 got '$(tp "$E3")'"

# PROXY-UPGRADE-004: broad custom value preserved but warned
E4="$SANDBOX/broad.env"; mkenv "$E4" "loopback,10.0.0.0/8"
OUT4="$(run_update "$E4" || true)"
[[ "$(tp "$E4")" == "loopback,10.0.0.0/8" ]] && ok "PROXY-UPGRADE-004 broad custom value left unchanged" || bad "PROXY-UPGRADE-004 changed to '$(tp "$E4")'"
echo "$OUT4" | grep -qi "WARNING: TRUST_PROXY" && ok "PROXY-UPGRADE-004 broad value warned" || bad "PROXY-UPGRADE-004 no warning"

echo; echo "PASS=$PASS FAIL=$FAIL"; [[ "$FAIL" -eq 0 ]]
