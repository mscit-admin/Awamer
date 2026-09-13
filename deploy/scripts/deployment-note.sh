#!/usr/bin/env bash
# =====================================================================
# Awamer Terminal — Manual intervention note recorder (§22)
# =====================================================================
#
# Records an operator's manual troubleshooting action into the CURRENT (or a
# named) installation evidence run, so the installation timeline can be
# reconstructed later. The note text is STORED ONLY — never executed (§22).
#
# Usage:
#   ./deploy/scripts/deployment-note.sh "Changed DNS A record and retried certbot"
#   ./deploy/scripts/deployment-note.sh --run 2026-09-12_162500 "Opened TCP 80 in firewall"
#
# The note is appended (sanitized) to 12-actions.log of the target run.
# =====================================================================

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/evidence.sh
source "${HERE}/lib/evidence.sh"

RUN=""
if [[ "${1:-}" == "--run" ]]; then
    RUN="$2"; shift 2
fi

NOTE="$*"
if [[ -z "$NOTE" ]]; then
    echo "Usage: $0 [--run <RUN_ID>] \"note text\"" >&2
    exit 2
fi

ROOT="$(evidence_root)"
if [[ -n "$RUN" ]]; then
    TARGET="${ROOT}/${RUN}"
else
    TARGET="$(evidence_latest_run)"
fi

if [[ -z "$TARGET" || ! -d "$TARGET" ]]; then
    echo "No installation evidence run found under: $ROOT" >&2
    echo "Run the installer first, or pass --run <RUN_ID>." >&2
    exit 1
fi

evidence_attach "$TARGET"
evidence_note "$NOTE"

echo "Note recorded to run: $(basename "$TARGET")"
echo "  -> ${TARGET}/${EV_F_ACTIONS}"
