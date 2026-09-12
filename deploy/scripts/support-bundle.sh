#!/usr/bin/env bash
# =====================================================================
# NetSphere Terminal (Awamer) — Installation support bundle (§37, §38, §39)
# =====================================================================
#
# Packages ONE installation evidence run into a sanitized archive that is
# safe to send for review:
#
#   awamer-installation-<RUN_ID>.tar.gz
#
# Safety guarantees:
#   * DENYLIST (§38): known secret-bearing files are never included.
#   * RE-REDACTION (§37): every text file is re-run through the redactor as
#     it is staged, even though the installer already redacted on write.
#   * BLOCKING SECRET SCAN (§39): the staged bundle is scanned for secret
#     patterns; if any survive, bundle creation is REJECTED (not merely
#     warned) so a leaking archive can never be produced.
#
# Usage:
#   ./deploy/scripts/support-bundle.sh                # latest run
#   ./deploy/scripts/support-bundle.sh 2026-09-12_162500
#   ./deploy/scripts/support-bundle.sh --out /tmp     # choose output dir
# =====================================================================

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/evidence.sh
source "${HERE}/lib/evidence.sh"

OUT_DIR="$(pwd)"
if [[ "${1:-}" == "--out" ]]; then OUT_DIR="$2"; shift 2; fi

RUN_ARG="${1:-}"
ROOT="$(evidence_root)"

# §56: RUN_ID must be a strict basename — no slashes, no traversal, no absolute
# paths. Reject anything that could escape EVIDENCE_ROOT before touching disk.
if [[ -n "$RUN_ARG" ]]; then
    if [[ "$RUN_ARG" == /* || "$RUN_ARG" == *".."* || "$RUN_ARG" == */* || "$RUN_ARG" != "$(basename "$RUN_ARG")" ]]; then
        echo "Invalid RUN_ID '$RUN_ARG' (must be a plain run directory name, no path components)." >&2
        exit 2
    fi
    SRC="${ROOT}/${RUN_ARG}"
else
    SRC="$(evidence_latest_run)"
fi

if [[ -z "$SRC" || ! -d "$SRC" ]]; then
    echo "No installation evidence run found under: $ROOT" >&2
    exit 1
fi

# §56/§57: resolve the canonical path and ensure it stays UNDER EVIDENCE_ROOT
# (defends against a symlinked run directory pointing elsewhere).
_root_real="$(cd "$ROOT" 2>/dev/null && pwd -P || echo "$ROOT")"
_src_real="$(cd "$SRC" 2>/dev/null && pwd -P || echo "")"
if [[ -z "$_src_real" || ( "$_src_real" != "$_root_real" && "$_src_real" != "$_root_real"/* ) ]]; then
    echo "Refusing: run directory resolves outside the evidence root ($_root_real)." >&2
    exit 2
fi
RUN_ID="$(basename "$SRC")"

# ----- DENYLIST (§38): never include these, by name or extension ------
# If uncertain whether a file contains secrets, EXCLUDE it (§38).
DENY_NAMES=( ".env" ".env.production" ".env.local" "secrets" "kv.tsv" )
DENY_GLOBS=( "*.env" "*.key" "*.pem" "*.p12" "*.pfx" "*.crt.key" "*.sql" "*.dump"
             "*id_rsa*" "*id_ed25519*" "*.kdbx" "*.pgpass" "*.htpasswd" )

is_denied() {
    local base; base="$(basename "$1")"
    local n g
    for n in "${DENY_NAMES[@]}"; do [[ "$base" == "$n" ]] && return 0; done
    for g in "${DENY_GLOBS[@]}"; do
        # shellcheck disable=SC2053
        [[ "$base" == $g ]] && return 0
    done
    return 1
}

# ----- Secret scan (§39) ---------------------------------------------
# A leak exists when a sensitive KEY=VALUE (or KEY: VALUE) survives with a
# VALUE that is NOT a redaction marker, or when raw private-key / bearer
# material appears. We check the captured VALUE directly (rather than stripping
# markers and re-scanning) so an already-redacted value whose LINE happens to
# contain flags — e.g. `…trustStorePassword=[REDACTED] -Dhttps.proxyHost=…` —
# is not a false positive.
# scan_file <file>  -> returns 0 if a REAL leak is present
scan_file() {
    local f="$1"
    # Sensitive assignments whose value is present and not a [REDACTED…] marker.
    if grep -oEi "(${_EV_SENSITIVE_WORDS})[A-Za-z0-9_.-]*[[:space:]]*[=:][[:space:]]*[^[:space:]]+" "$f" 2>/dev/null \
         | grep -vEi '[=:][[:space:]]*\[REDACTED' | grep -q .; then
        return 0
    fi
    # Raw private-key blocks or non-redacted bearer tokens.
    if grep -qEi 'BEGIN [A-Z ]*PRIVATE KEY|BEGIN OPENSSH PRIVATE KEY' "$f" 2>/dev/null; then
        return 0
    fi
    if grep -oEi 'authorization[[:space:]]*[=:][[:space:]]*(bearer[[:space:]]+)?[A-Za-z0-9._~+/-]+' "$f" 2>/dev/null \
         | grep -vEi '[=:][[:space:]]*\[REDACTED' | grep -q .; then
        return 0
    fi
    # Credential-bearing URIs (§8): scheme://user:pass@host — a leak unless the
    # userinfo was already redacted to [REDACTED]@.
    if grep -oEi '[a-z][a-z0-9+.-]*://[^@/[:space:]]+@' "$f" 2>/dev/null \
         | grep -vEi '://\[REDACTED\]@' | grep -q .; then
        return 0
    fi
    return 1
}

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
DEST="${STAGE}/awamer-installation-${RUN_ID}"
mkdir -p "$DEST"

echo "==> Staging sanitized evidence for run ${RUN_ID}"
excluded=0 staged=0
while IFS= read -r -d '' f; do
    rel="${f#"$SRC"/}"
    # skip the internal working store entirely (may contain raw kv values)
    case "$rel" in .manifest/*) excluded=$((excluded+1)); continue;; esac
    if is_denied "$f"; then
        echo "   [EXCLUDE] $rel  (denylist)"
        excluded=$((excluded+1)); continue
    fi
    mkdir -p "$DEST/$(dirname "$rel")"
    if [[ ! -s "$f" ]]; then
        # empty file — safe text, copy as-is
        : > "$DEST/$rel"
    elif LC_ALL=C grep -Iq . "$f" 2>/dev/null; then
        # text file — RE-REDACT as we copy (§37)
        redact_stream < "$f" > "$DEST/$rel"
    else
        # binary — exclude unless it is an expected safe type (none by default)
        echo "   [EXCLUDE] $rel  (binary; excluded for safety)"
        excluded=$((excluded+1)); rmdir "$DEST/$(dirname "$rel")" 2>/dev/null || true; continue
    fi
    staged=$((staged+1))
done < <(find "$SRC" -type f -print0)

# Re-emit the machine-readable manifest from the (already sanitized) source so
# the bundle always carries a manifest even though .manifest/ is excluded.
[[ -f "$SRC/${EV_F_MANIFEST}" ]] && redact_stream < "$SRC/${EV_F_MANIFEST}" > "$DEST/${EV_F_MANIFEST}"

echo "==> Staged ${staged} file(s), excluded ${excluded}."

# ----- BLOCKING secret scan (§39) ------------------------------------
echo "==> Scanning staged bundle for secret patterns…"
REAL_LEAKS=""
while IFS= read -r -d '' lf; do
    if scan_file "$lf"; then
        REAL_LEAKS+="${lf#"$DEST"/}"$'\n'
    fi
done < <(find "$DEST" -type f -print0)

if [[ -n "${REAL_LEAKS//[$'\n ']/}" ]]; then
    echo "✗ SECRET SCAN FAILED — bundle REJECTED (§39). Offending file(s):" >&2
    printf '   %s\n' $REAL_LEAKS >&2
    echo "No archive was created. Investigate the redactor before retrying." >&2
    exit 3
fi
echo "✓ Secret scan clean."

# ----- Archive -------------------------------------------------------
mkdir -p "$OUT_DIR"
ARCHIVE="${OUT_DIR%/}/awamer-installation-${RUN_ID}.tar.gz"
tar -czf "$ARCHIVE" -C "$STAGE" "awamer-installation-${RUN_ID}"

echo
echo "✓ Support bundle created:"
echo "   $ARCHIVE"
echo
echo "Contains ONLY sanitized installation evidence. Safe to send for review."
echo "See docs/INSTALLATION_EVIDENCE.md for what is and isn't included."
