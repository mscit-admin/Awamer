#!/usr/bin/env bash
# =====================================================================
# Awamer Terminal — Post-reboot validation (§43)
# =====================================================================
#
# Run AFTER a server reboot to verify the stack came back up cleanly.
# Results are written as a NEW, clearly-linked evidence run so the reboot
# check never overwrites the original installation evidence (§2).
#
# Usage:
#   ./deploy/scripts/validate-after-reboot.sh
#   ./deploy/scripts/validate-after-reboot.sh --link 2026-09-12_162500
#
# Verifies: PostgreSQL, Docker, application containers, Nginx, /healthz,
# /readyz. Exit code is non-zero if any mandatory check fails (§33).
# =====================================================================

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=lib/evidence.sh
source "${HERE}/lib/evidence.sh"

LINK=""
if [[ "${1:-}" == "--link" ]]; then LINK="$2"; shift 2; fi

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8081}"

evidence_init "reboot-$(date -u +%Y-%m-%d_%H%M%S)" >/dev/null
ev_phase "REBOOT" "Post-reboot validation"
[[ -n "$LINK" ]] && ev_action "Linked to installation run: $LINK" && _ev_kv_set linked_install_run "$LINK"
_ev_kv_set run_kind "post-reboot-validation"

FAIL=0
check_service() {
    local svc="$1" state
    state="$(systemctl is-active "$svc" 2>/dev/null || echo unknown)"
    local result="PASS"; [[ "$state" == "active" ]] || result="FAIL"
    ev_log "$EV_F_APP" "service ${svc}: ${state} (${result})"
    phase_record "service:${svc}" "$result" "-"
    [[ "$result" == "FAIL" ]] && { ev_error "REBOOT" "service ${svc}" 1 "AW-INSTALL-READY-001" "service not active after reboot"; FAIL=1; }
    echo "  ${svc} .......... ${result}"
}

echo "[reboot] Validating services after reboot…"
check_service postgresql
check_service docker
check_service nginx

# Containers
if run_cmd REBOOT "$EV_F_DOCKER" "docker compose ps" -- sudo docker compose -f deploy/docker-compose.production.yml ps; then
    _ev_kv_set docker_containers "checked"
else
    ev_warn "docker compose ps unavailable after reboot"
fi

# Health / readiness
hz="$(probe_http "/healthz" "${HEALTH_URL}/healthz" 200)"; hz_rc=$?
rz="$(probe_http "/readyz"  "${HEALTH_URL}/readyz" 200)"; rz_rc=$?
_ev_kv_set health_healthz "$hz"; _ev_kv_set health_readyz "$rz"
echo "  /healthz ......... ${hz}"
echo "  /readyz .......... ${rz}"
[[ $hz_rc -eq 0 ]] || { ev_error "REBOOT" "/healthz probe" 1 "AW-INSTALL-READY-001" "healthz != 200 after reboot"; FAIL=1; }
[[ $rz_rc -eq 0 ]] || { ev_error "REBOOT" "/readyz probe" 1 "AW-INSTALL-READY-001" "readyz != 200 after reboot"; FAIL=1; }

if [[ $FAIL -eq 0 ]]; then
    evidence_finalize SUCCESS
    echo
    echo "REBOOT VALIDATION: SUCCESS"
    echo "Evidence: $(evidence_dir)"
    exit 0
else
    evidence_finalize FAILED "REBOOT" "post-reboot validation" 1 "AW-INSTALL-READY-001"
    echo
    echo "REBOOT VALIDATION: FAILED"
    echo "Evidence: $(evidence_dir)"
    exit 1
fi
