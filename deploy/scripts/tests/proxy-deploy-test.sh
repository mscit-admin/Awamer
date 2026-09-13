#!/usr/bin/env bash
# =====================================================================
# PROXY-DEPLOY-001 — dynamic Docker-gateway trust integration (lib unit tests).
# Mocks `docker` (no real daemon) and exercises deploy/scripts/lib/trustproxy.sh.
#   001 gateway discovered   002 exact /32   003 IPv6 /128   004 no broad trust
#   005 missing gw fails closed   006 admin custom preserved   007 stale gw replaced
#   008 backend loopback-only publication (compose)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../../.." && pwd)"
source "${HERE}/../lib/trustproxy.sh"
SB="$(mktemp -d)"; trap 'rm -rf "$SB"' EXIT
PASS=0; FAIL=0
ok(){ printf '  \033[0;32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad(){ printf '  \033[0;31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
sq(){ :; } # silent say-fn

# --- mock docker: returns MOCK_CONTAINER / MOCK_NETWORK canned template output ---
MOCK_CONTAINER=""; MOCK_NETWORK=""
docker(){
  case "$1 $2" in
    "inspect -f"|"inspect -f ") printf '%s' "$MOCK_CONTAINER";;
    "network inspect") printf '%s' "$MOCK_NETWORK";;
    *) case "$1" in inspect) printf '%s' "$MOCK_CONTAINER";; network) printf '%s' "$MOCK_NETWORK";; *) return 1;; esac;;
  esac
}
export -f docker 2>/dev/null || true

mkenv(){ local f="$1"; shift; : > "$f"; printf 'VPN_HELPER_SECRET=x\n' >> "$f"; [[ $# -gt 0 && -n "$1" ]] && printf 'TRUST_PROXY=%s\n' "$1" >> "$f"; [[ $# -gt 1 ]] && sed -i "1i # awamer-managed-trust-proxy=$2" "$f"; chmod 600 "$f"; }
tp(){ tp_env_get "$1"; }

# PROXY-DEPLOY-001: discovery
MOCK_CONTAINER="172.23.0.1| "; MOCK_NETWORK=""
GW="$(tp_discover_gateway netsphere-auth netsphere-internal || true)"
[[ "$(printf '%s' "$GW" | cut -f1)" == "172.23.0.1" ]] && ok "PROXY-DEPLOY-001 actual Docker gateway discovered (172.23.0.1)" || bad "PROXY-DEPLOY-001 got '$GW'"

# PROXY-DEPLOY-002: exact /32
[[ "$(tp_build_managed 172.23.0.1 "")" == "loopback,172.23.0.1/32" ]] && ok "PROXY-DEPLOY-002 gateway becomes exact /32" || bad "PROXY-DEPLOY-002 got '$(tp_build_managed 172.23.0.1 "")'"

# PROXY-DEPLOY-003: IPv6 /128
[[ "$(tp_build_managed 172.23.0.1 fd00::1)" == "loopback,172.23.0.1/32,fd00::1/128" ]] && ok "PROXY-DEPLOY-003 IPv6 gateway becomes /128" || bad "PROXY-DEPLOY-003 got '$(tp_build_managed 172.23.0.1 fd00::1)'"

# PROXY-DEPLOY-004: no broad/RFC1918-wide trust ever produced or accepted
b=1
for good in "loopback" "loopback,172.23.0.1/32" "loopback,10.0.0.5/32"; do tp_is_broad_entry "$good" && b=0; done
for bad in "loopback,uniquelocal" "true" "loopback,10.0.0.0/8" "loopback,172.16.0.0/12" "0.0.0.0/0" "::/0"; do tp_is_broad_entry "$bad" || b=0; done
[[ "$b" == "1" ]] && ok "PROXY-DEPLOY-004 broad/RFC1918-wide values rejected; exact hosts accepted" || bad "PROXY-DEPLOY-004 broad classification wrong"

# PROXY-DEPLOY-005: missing gateway → fail closed (loopback, action-required)
MOCK_CONTAINER=""; MOCK_NETWORK=""
E5="$SB/none.env"; mkenv "$E5" "loopback" ""
st="$(tp_configure_env "$E5" netsphere-auth netsphere-internal sq)"
[[ "$st" == "action-required" && "$(tp "$E5")" == "loopback" ]] && ok "PROXY-DEPLOY-005 undiscoverable gateway fails closed (stays loopback)" || bad "PROXY-DEPLOY-005 st=$st val=$(tp "$E5")"

# PROXY-DEPLOY-006: administrator-custom value preserved (no marker, public LB)
MOCK_CONTAINER="172.23.0.1| "
E6="$SB/custom.env"; mkenv "$E6" "loopback,203.0.113.9/32" ""
st="$(tp_configure_env "$E6" netsphere-auth netsphere-internal sq)"
[[ "$st" == "kept-custom" && "$(tp "$E6")" == "loopback,203.0.113.9/32" ]] && ok "PROXY-DEPLOY-006 admin custom proxy preserved (not overwritten)" || bad "PROXY-DEPLOY-006 st=$st val=$(tp "$E6")"

# PROXY-DEPLOY-007: stale generated gateway replaced (marker matches; no accumulation)
MOCK_CONTAINER="172.24.0.1| "
E7="$SB/stale.env"; mkenv "$E7" "loopback,172.19.0.1/32" "loopback,172.19.0.1/32"
st="$(tp_configure_env "$E7" netsphere-auth netsphere-internal sq)"
[[ "$st" == "refreshed" && "$(tp "$E7")" == "loopback,172.24.0.1/32" ]] && ok "PROXY-DEPLOY-007 stale managed gateway replaced (no accumulation)" || bad "PROXY-DEPLOY-007 st=$st val=$(tp "$E7")"
# ensure the stale gateway is gone
printf '%s' "$(tp "$E7")" | grep -q "172.19.0.1" && bad "PROXY-DEPLOY-007 stale gateway still present" || ok "PROXY-DEPLOY-007 old gateway removed"

# also: first-time upgrade of a plain marker-less "loopback" adds the gateway (§10)
MOCK_CONTAINER="172.25.0.1| "
E7b="$SB/upgrade.env"; mkenv "$E7b" "loopback" ""
st="$(tp_configure_env "$E7b" netsphere-auth netsphere-internal sq)"
[[ "$st" == "set" && "$(tp "$E7b")" == "loopback,172.25.0.1/32" ]] && ok "PROXY-DEPLOY-007b marker-less loopback upgraded to include gateway" || bad "PROXY-DEPLOY-007b st=$st val=$(tp "$E7b")"

# PROXY-DEPLOY-008: backend published to 127.0.0.1 only
grep -qE '^\s*-\s*"127\.0\.0\.1:8081:8081"' "$REPO_ROOT/deploy/docker-compose.production.yml" && ok "PROXY-DEPLOY-008 backend published on 127.0.0.1:8081 only" || bad "PROXY-DEPLOY-008 backend not loopback-bound"
grep -qE '0\.0\.0\.0:8081|"8081:8081"' "$REPO_ROOT/deploy/docker-compose.production.yml" && bad "PROXY-DEPLOY-008 backend appears publicly exposed" || ok "PROXY-DEPLOY-008 backend not publicly exposed"

echo; echo "PROXY-DEPLOY UNIT RESULT: PASS=$PASS FAIL=$FAIL"; [[ "$FAIL" -eq 0 ]]
