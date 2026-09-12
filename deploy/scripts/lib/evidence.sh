#!/usr/bin/env bash
# =====================================================================
# NetSphere Terminal (Awamer) — Installation Evidence & Diagnostics library
# =====================================================================
#
# A sourceable Bash library that turns the installer (and its helper
# scripts) into a system that produces STRUCTURED, SANITIZED evidence for
# every installation run — enough to reconstruct what happened, diagnose a
# failure, and support a later production-readiness evaluation.
#
# Design goals:
#   * Never overwrite a previous run (failed runs are evidence too).
#   * Never write a secret to disk (automatic redaction, not developer
#     discipline).
#   * No external dependencies beyond coreutils (JSON is emitted by a
#     small pure-Bash escaper — no python/jq required at runtime).
#   * Safe to `source` inside `set -euo pipefail` scripts.
#
# Usage (from an installer):
#   source "$(dirname "$0")/lib/evidence.sh"
#   evidence_init                       # creates the run directory
#   ev_phase "PREFLIGHT" "System preflight"
#   preflight_check "Disk >= 5G" PASS "12G free"
#   run_cmd nginx 05-nginx.log "Install nginx" -- sudo apt-get install -y nginx
#   evidence_finalize SUCCESS           # writes manifest + report + final state
#
# Evidence IDs:  installation-specific issues use INSTALL-XXX (see
# docs/INSTALLATION_TROUBLESHOOTING.md); pre-existing deployment issues keep
# their DEPLOY-XXX ids. Machine error codes use AW-INSTALL-<PHASE>-NNN.
# =====================================================================

# ----- Guard against double-sourcing ---------------------------------
if [[ -n "${_AWAMER_EVIDENCE_SOURCED:-}" ]]; then return 0 2>/dev/null || true; fi
_AWAMER_EVIDENCE_SOURCED=1

# The installer/helper revision this library ships with. Bump on changes.
EVIDENCE_LIB_VERSION="1.0.0"

# ----- Globals populated by evidence_init ----------------------------
EV_RUN_ID=""
EV_RUN_DIR=""
EV_META_DIR=""          # internal .manifest working dir (sanitized, kept in run)
EV_STARTED_UTC=""
EV_STATUS="UNKNOWN"
EV_CURRENT_PHASE="INIT"

# ----- Structured file names (stable contract) -----------------------
EV_F_SYSTEM="00-system-info.txt"
EV_F_PREFLIGHT="01-preflight.log"
EV_F_PACKAGES="02-packages.log"
EV_F_POSTGRES="03-postgresql.log"
EV_F_MIGRATIONS="04-migrations.log"
EV_F_NGINX="05-nginx.log"
EV_F_CERTBOT="06-certbot.log"
EV_F_DOCKER="07-docker.log"
EV_F_APP="08-application.log"
EV_F_HEALTH="09-health-readiness.log"
EV_F_ERRORS="10-errors.log"
EV_F_WARNINGS="11-warnings.log"
EV_F_ACTIONS="12-actions.log"
EV_F_FINAL="13-final-state.txt"
EV_F_REPORT="INSTALLATION_REPORT.md"
EV_F_MANIFEST="installation-manifest.json"

# =====================================================================
# Timestamps
# =====================================================================
ev_now_utc()   { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
ev_now_local() { date +"%Y-%m-%dT%H:%M:%S%z"; }
ev_now_hms()   { date +"%H:%M:%S"; }
ev_tz() { timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || date +%Z; }

# =====================================================================
# SECRET REDACTION  (§8, §9)
# =====================================================================
# Redaction is applied to EVERYTHING written through this library. It masks:
#   * KEY=value / KEY: value / "key":"value" where KEY contains a sensitive
#     token (PASSWORD, PASS, SECRET, TOKEN, PRIVATE_KEY, AUTHORIZATION,
#     COOKIE, API_KEY, JWT, CREDENTIAL, PSK) — case-insensitive.
#   * HTTP auth / cookie headers.
#   * PEM private-key blocks (BEGIN … PRIVATE KEY … END).
# We deliberately key off the FIELD NAME, so table cells like "Result: PASS"
# are never mangled (the key there is "Result", not a secret).
_EV_SENSITIVE_WORDS='PASSWORD|PASSWD|PASS|SECRET|TOKEN|PRIVATE[_-]?KEY|PRIVKEY|AUTHORIZATION|AUTH[_-]?TOKEN|COOKIE|API[_-]?KEY|APIKEY|JWT|CREDENTIAL|ENCRYPTION[_-]?KEY|PSK|BEARER'

redact_stream() {
    # Reads stdin, writes sanitized stdout. Pure sed + awk, no deps.
    # Order matters: redact HTTP auth/cookie headers (whole value, incl. the
    # bearer token) BEFORE the generic KEY=value rule, which would otherwise
    # stop at the first space and leave the token behind.
    sed -E \
        -e "s/(Authorization[[:space:]]*:[[:space:]]*).*/\1[REDACTED]/Ig" \
        -e "s/((Set-)?Cookie[[:space:]]*:[[:space:]]*).*/\1[REDACTED]/Ig" \
        -e "s/([A-Za-z0-9_.-]*(${_EV_SENSITIVE_WORDS})[A-Za-z0-9_.-]*)([[:space:]]*[=:][[:space:]]*)([\"']?)[^\"'[:space:],}]+([\"']?)/\1\3\4[REDACTED]\5/Ig" \
    | awk '
        BEGIN{inkey=0}
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/{print "[REDACTED PRIVATE KEY BLOCK]"; inkey=1; next}
        /-----END [A-Z ]*PRIVATE KEY-----/{inkey=0; next}
        { if(!inkey) print }
    '
}

redact_text() { printf '%s\n' "$*" | redact_stream; }

# =====================================================================
# Run directory lifecycle  (§1, §2)
# =====================================================================
# Chooses the evidence root. Preference:
#   1. $AWAMER_EVIDENCE_ROOT (explicit override — used by tests)
#   2. /var/log/awamer/installation      (production default, if writable)
#   3. <repo>/installation-evidence      (fallback for non-root / dev)
_ev_choose_root() {
    if [[ -n "${AWAMER_EVIDENCE_ROOT:-}" ]]; then
        printf '%s' "$AWAMER_EVIDENCE_ROOT"; return 0
    fi
    local prod="/var/log/awamer/installation"
    if mkdir -p "$prod" 2>/dev/null && [[ -w "$prod" ]]; then
        printf '%s' "$prod"; return 0
    fi
    local repo_root
    repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
    printf '%s' "${repo_root}/installation-evidence"
}

# evidence_init [RUN_ID]
# Creates a fresh, never-overwritten run directory and seeds the working
# state. RUN_ID defaults to a UTC timestamp; collisions get a numeric suffix.
evidence_init() {
    local root run_id base
    root="$(_ev_choose_root)"
    mkdir -p "$root" || { echo "FATAL: cannot create evidence root $root" >&2; return 1; }

    run_id="${1:-$(date -u +%Y-%m-%d_%H%M%S)}"
    base="$run_id"
    local n=2
    # NEVER overwrite an existing run (failed installs are evidence, §2/§23).
    while [[ -e "${root}/${run_id}" ]]; do
        run_id="${base}_${n}"; n=$((n+1))
    done

    EV_RUN_ID="$run_id"
    EV_RUN_DIR="${root}/${run_id}"
    EV_META_DIR="${EV_RUN_DIR}/.manifest"
    EV_STARTED_UTC="$(ev_now_utc)"
    EV_STATUS="IN_PROGRESS"

    mkdir -p "$EV_RUN_DIR" "$EV_META_DIR"
    chmod 700 "$EV_RUN_DIR" 2>/dev/null || true

    # Seed the structured evidence files so they always exist.
    : > "${EV_RUN_DIR}/${EV_F_ERRORS}"
    : > "${EV_RUN_DIR}/${EV_F_WARNINGS}"
    : > "${EV_RUN_DIR}/${EV_F_ACTIONS}"

    # Scalar manifest facts.
    _ev_kv_set run_id "$EV_RUN_ID"
    _ev_kv_set status "$EV_STATUS"
    _ev_kv_set started_at_utc "$EV_STARTED_UTC"
    _ev_kv_set started_at_local "$(ev_now_local)"
    _ev_kv_set timezone "$(ev_tz)"
    _ev_kv_set installer_version "$EVIDENCE_LIB_VERSION"

    ev_action "Installation run started (RUN_ID=$EV_RUN_ID)"
    printf '%s\n' "$EV_RUN_DIR"
}

evidence_run_id() { printf '%s' "$EV_RUN_ID"; }
evidence_dir()    { printf '%s' "$EV_RUN_DIR"; }

# evidence_root  — echo the resolved evidence root (for helper scripts)
evidence_root() { _ev_choose_root; }

# evidence_latest_run  — path of the most recent run dir, or empty
evidence_latest_run() {
    local root; root="$(_ev_choose_root)"
    [[ -d "$root" ]] || return 0
    ls -1dt "$root"/*/ 2>/dev/null | head -n1 | sed 's:/*$::'
}

# evidence_attach <run_dir>  — point the library at an existing run (helpers)
evidence_attach() {
    EV_RUN_DIR="${1%/}"
    EV_RUN_ID="$(basename "$EV_RUN_DIR")"
    EV_META_DIR="${EV_RUN_DIR}/.manifest"
    mkdir -p "$EV_META_DIR" 2>/dev/null || true
    [[ -d "$EV_RUN_DIR" ]]
}

# =====================================================================
# Internal manifest working store (TSV / KV, sanitized on write)
# =====================================================================
# Fields are flattened (tabs/newlines -> spaces) so the TSV stays 1 row/line.
_ev_flat() { printf '%s' "$*" | tr '\t\n\r' '   '; }

_ev_kv_set() { # key value
    local k="$1"; shift
    # Redact by reconstructing KEY=value so a sensitive KEY masks its value even
    # when key and value arrive as separate args (defence-in-depth, §9).
    local red val
    red="$(printf '%s=%s' "$k" "$*" | redact_stream)"
    val="${red#*=}"
    printf '%s\t%s\n' "$k" "$(_ev_flat "$val")" >> "${EV_META_DIR}/kv.tsv"
}
_ev_kv_get() { # key  -> last value wins
    [[ -f "${EV_META_DIR}/kv.tsv" ]] || return 0
    awk -F'\t' -v k="$1" '$1==k{v=$2} END{print v}' "${EV_META_DIR}/kv.tsv"
}

# =====================================================================
# Low-level structured logging
# =====================================================================
# ev_log <evidence-file> <message...>   — append one sanitized, timestamped line
ev_log() {
    local f="$1"; shift
    [[ -n "$EV_RUN_DIR" ]] || return 0
    printf '[%s] [%s] %s\n' "$(ev_now_hms)" "$EV_CURRENT_PHASE" "$*" \
        | redact_stream >> "${EV_RUN_DIR}/${f}"
}

# ev_log_block <evidence-file> <heading>   — append sanitized stdin as a block
ev_log_block() {
    local f="$1" heading="$2"
    [[ -n "$EV_RUN_DIR" ]] || { cat >/dev/null; return 0; }
    {
        printf -- '----- [%s] %s -----\n' "$(ev_now_hms)" "$heading"
        redact_stream
        printf '\n'
    } >> "${EV_RUN_DIR}/${f}"
}

# =====================================================================
# Phases, actions, errors, warnings  (§7, §19, §20, §21)
# =====================================================================
# ev_phase <PHASE_ID> [human description]  — set the current phase + record it
ev_phase() {
    EV_CURRENT_PHASE="$1"
    local desc="${2:-$1}"
    ev_action "PHASE ${1}: ${desc}"
}

# ev_action <message>  — 12-actions.log (installation sequence reconstruction)
ev_action() {
    [[ -n "$EV_RUN_DIR" ]] || return 0
    printf '[%s] %s\n' "$(ev_now_utc)" "$*" | redact_stream >> "${EV_RUN_DIR}/${EV_F_ACTIONS}"
}

# ev_error <phase> <operation> <exit_code> <error_code> <message>
# Records a failed operation. Never hides or repairs (§14, §44).
ev_error() {
    local phase="$1" op="$2" code="$3" errcode="$4"; shift 4
    local msg="$*"
    [[ -n "$EV_RUN_DIR" ]] || return 0
    {
        printf '[ERROR] %s\n' "$(ev_now_utc)"
        printf 'Phase: %s\n' "$phase"
        printf 'Operation: %s\n' "$op"
        printf 'Exit code: %s\n' "$code"
        printf 'Error code: %s\n' "$errcode"
        printf 'Message: %s\n' "$msg"
        printf '\n'
    } | redact_stream >> "${EV_RUN_DIR}/${EV_F_ERRORS}"
    printf '%s\t%s\t%s\t%s\t%s\n' \
        "$(_ev_flat "$phase")" "$(_ev_flat "$op")" "$(_ev_flat "$code")" \
        "$(_ev_flat "$errcode")" "$(_ev_flat "$(redact_text "$msg")")" \
        >> "${EV_META_DIR}/errors.tsv"
}

# ev_warn <message>  — 11-warnings.log (kept separate from successes, §20)
ev_warn() {
    [[ -n "$EV_RUN_DIR" ]] || return 0
    printf '[%s] [WARN] [%s] %s\n' "$(ev_now_utc)" "$EV_CURRENT_PHASE" "$*" \
        | redact_stream >> "${EV_RUN_DIR}/${EV_F_WARNINGS}"
    printf '%s\t%s\n' "$(_ev_flat "$EV_CURRENT_PHASE")" \
        "$(_ev_flat "$(redact_text "$*")")" >> "${EV_META_DIR}/warnings.tsv"
}

# =====================================================================
# Preflight / components / migrations records  (§6, §10, §14)
# =====================================================================
# preflight_check <name> <PASS|WARN|FAIL> [notes]
preflight_check() {
    local name="$1" result="$2"; shift 2 || true
    local notes="${*:-}"
    ev_log "$EV_F_PREFLIGHT" "$(printf '%-32s %-4s %s' "$name" "$result" "$notes")"
    printf '%s\t%s\t%s\n' "$(_ev_flat "$name")" "$(_ev_flat "$result")" \
        "$(_ev_flat "$(redact_text "$notes")")" >> "${EV_META_DIR}/preflight.tsv"
    [[ "$result" == "WARN" ]] && ev_warn "preflight: $name — $notes"
    return 0
}

# component_record <name> <version_before> <version_after> <result>
component_record() {
    local name="$1" before="$2" after="$3" result="$4"
    ev_log "$EV_F_PACKAGES" "$(printf '%-20s before=%-14s after=%-14s %s' \
        "$name" "$before" "$after" "$result")"
    printf '%s\t%s\t%s\t%s\n' "$(_ev_flat "$name")" "$(_ev_flat "$before")" \
        "$(_ev_flat "$after")" "$(_ev_flat "$result")" >> "${EV_META_DIR}/components.tsv"
}

# migration_record <version> <name> <duration> <result>
migration_record() {
    local version="$1" name="$2" duration="$3" result="$4"
    ev_log "$EV_F_MIGRATIONS" "Migration ${version} (${name}) — ${result} — ${duration}"
    printf '%s\t%s\t%s\t%s\n' "$(_ev_flat "$version")" "$(_ev_flat "$name")" \
        "$(_ev_flat "$duration")" "$(_ev_flat "$result")" >> "${EV_META_DIR}/migrations.tsv"
}

# phase_record <phase> <result> <duration>  — for the phases table in the report
phase_record() {
    printf '%s\t%s\t%s\n' "$(_ev_flat "$1")" "$(_ev_flat "$2")" "$(_ev_flat "$3")" \
        >> "${EV_META_DIR}/phases.tsv"
}

# =====================================================================
# COMMAND LOGGING with timing  (§7, §31)
# =====================================================================
# run_cmd <phase> <evidence-file> <description> -- <command> [args...]
# Runs the command, capturing exit code + duration + (sanitized) output.
# Returns the command's real exit code so the caller decides mandatory-ness.
# NEVER auto-fixes on failure (§44) — it records and returns.
run_cmd() {
    local phase="$1" logfile="$2" desc="$3"; shift 3
    [[ "${1:-}" == "--" ]] && shift
    local start end dur rc out
    EV_CURRENT_PHASE="$phase"
    ev_log "$logfile" ">> ${desc}"
    ev_log "$logfile" "\$ $(redact_text "$*")"
    start=$(date +%s.%N 2>/dev/null || date +%s)
    set +e
    out="$("$@" 2>&1)"; rc=$?
    set -e
    end=$(date +%s.%N 2>/dev/null || date +%s)
    dur="$(awk -v s="$start" -v e="$end" 'BEGIN{printf "%.1fs", (e-s)}' 2>/dev/null || echo "?")"
    if [[ -n "$out" ]]; then printf '%s\n' "$out" | ev_log_block "$logfile" "output of: ${desc}"; fi
    local result="PASS"; [[ $rc -ne 0 ]] && result="FAIL"
    ev_log "$logfile" "Exit code: ${rc}   Duration: ${dur}   Result: ${result}"
    ev_action "${desc} (exit=${rc}, ${dur}, ${result})"
    return $rc
}

# =====================================================================
# System information collection  (§4, §5, §40, §41)
# =====================================================================
ev_ver() { # ev_ver <command> [version-args...]  -> version string or NOT INSTALLED
    local cmd="$1"; shift
    if command -v "$cmd" >/dev/null 2>&1; then
        "$cmd" "$@" 2>&1 | head -n1
    else
        echo "NOT INSTALLED"
    fi
}

collect_system_info() {
    local f="$EV_F_SYSTEM"
    {
        echo "===== Awamer installation — system information ====="
        echo "Run ID:            $EV_RUN_ID"
        echo "Collected (UTC):   $(ev_now_utc)"
        echo "Collected (local): $(ev_now_local)"
        echo "Timezone:          $(ev_tz)"
        echo
        echo "----- Host -----"
        echo "hostname:      $(hostname 2>/dev/null || echo unknown)"
        echo "OS:            $( . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}")"
        echo "OS version:    $( . /etc/os-release 2>/dev/null; echo "${VERSION_ID:-unknown}")"
        echo "kernel:        $(uname -r 2>/dev/null)"
        echo "architecture:  $(uname -m 2>/dev/null)"
        echo "CPU model:     $(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ //' || echo unknown)"
        echo "CPU cores:     $(nproc 2>/dev/null || echo unknown)"
        echo
        echo "----- Memory / swap -----"
        free -h 2>/dev/null || echo "free: unavailable"
        echo
        echo "----- Disk -----"
        df -h / 2>/dev/null || echo "df: unavailable"
        echo "filesystem(/): $(findmnt -no FSTYPE / 2>/dev/null || echo unknown)"
        echo
        echo "----- Component versions -----"
        printf '%-16s %s\n' "Node.js:"        "$(ev_ver node --version)"
        printf '%-16s %s\n' "npm:"            "$(ev_ver npm --version)"
        printf '%-16s %s\n' "PostgreSQL(srv):" "$(ev_ver postgres --version)"
        printf '%-16s %s\n' "psql:"           "$(ev_ver psql --version)"
        printf '%-16s %s\n' "Docker:"         "$(ev_ver docker --version)"
        printf '%-16s %s\n' "Docker Compose:" "$(docker compose version 2>/dev/null | head -n1 || echo 'NOT INSTALLED')"
        printf '%-16s %s\n' "Nginx:"          "$(ev_ver nginx -v)"
        printf '%-16s %s\n' "Certbot:"        "$(ev_ver certbot --version)"
        printf '%-16s %s\n' "OpenSSL:"        "$(ev_ver openssl version)"
        printf '%-16s %s\n' "Git:"            "$(ev_ver git --version)"
        printf '%-16s %s\n' "curl:"           "$(ev_ver curl --version)"
        echo
        echo "----- Application revision (§40) -----"
        collect_app_revision
        echo
        echo "----- Environment (sanitized, §8) -----"
        env | sort
    } | redact_stream > "${EV_RUN_DIR}/${f}"

    # Manifest scalars
    _ev_kv_set hostname "$(hostname 2>/dev/null || echo unknown)"
    _ev_kv_set os "$( . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}")"
    _ev_kv_set os_version "$( . /etc/os-release 2>/dev/null; echo "${VERSION_ID:-unknown}")"
    _ev_kv_set kernel "$(uname -r 2>/dev/null)"
    _ev_kv_set architecture "$(uname -m 2>/dev/null)"
}

collect_app_revision() {
    local repo_root
    repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
    if git -C "$repo_root" rev-parse --git-dir >/dev/null 2>&1; then
        local commit branch tag
        commit="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo unknown)"
        branch="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
        tag="$(git -C "$repo_root" describe --tags --always 2>/dev/null || echo none)"
        echo "git commit: $commit"
        echo "git branch: $branch"
        echo "git describe: $tag"
        _ev_kv_set app_commit "$commit"
        _ev_kv_set app_branch "$branch"
        _ev_kv_set app_describe "$tag"
    else
        # No git metadata (installed from archive) — synthesize a stable id (§40).
        local rid
        rid="$( (cd "$repo_root" && find . -type f \( -name '*.ts' -o -name '*.json' -o -name '*.sql' \) \
                 -not -path './installation-evidence/*' -print0 2>/dev/null \
                 | sort -z | xargs -0 cat 2>/dev/null | sha256sum | cut -c1-16) 2>/dev/null || echo unknown)"
        echo "git: NOT AVAILABLE (installed from archive)"
        echo "archive fingerprint (sha256/16): $rid"
        _ev_kv_set app_commit "archive:$rid"
        _ev_kv_set app_branch "n/a"
        _ev_kv_set app_describe "archive:$rid"
    fi
}

# ev_fingerprint <label> <file>  — SHA-256 of a NON-secret config file (§41)
ev_fingerprint() {
    local label="$1" file="$2"
    if [[ -f "$file" ]]; then
        local h; h="$(sha256sum "$file" 2>/dev/null | cut -d' ' -f1)"
        ev_log "$EV_F_SYSTEM" "fingerprint ${label}: ${h}  (${file})"
        printf '%s\t%s\n' "$(_ev_flat "$label")" "$h" >> "${EV_META_DIR}/fingerprints.tsv"
    fi
}

collect_network_baseline() { # (§5)
    local domain="${1:-}"
    {
        echo "----- Network baseline (§5) -----"
        echo "hostname: $(hostname 2>/dev/null)"
        echo "listening ports:"
        (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo "ss/netstat unavailable") | redact_stream
        echo "default route:"
        ip route show default 2>/dev/null || echo "ip route unavailable"
        echo "DNS resolvers:"
        (grep -E '^nameserver' /etc/resolv.conf 2>/dev/null || echo "resolv.conf unavailable")
        if [[ -n "$domain" ]]; then
            echo "DNS resolution of ${domain}:"
            getent hosts "$domain" 2>/dev/null || echo "  (does not resolve)"
        fi
    } | redact_stream >> "${EV_RUN_DIR}/${EV_F_SYSTEM}"
}

# =====================================================================
# Health / readiness probes  (§17, §18)
# =====================================================================
# probe_http <label> <url> [expected_status]
probe_http() {
    local label="$1" url="$2" expect="${3:-200}"
    local code time result
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)"
    time="$(curl -sk -o /dev/null -w '%{time_total}s' --max-time 10 "$url" 2>/dev/null || echo '?')"
    result="PASS"; [[ "$code" != "$expect" ]] && result="FAIL"
    ev_log "$EV_F_HEALTH" "$(printf '%-24s %-40s status=%s time=%s expect=%s %s' \
        "$label" "$url" "$code" "$time" "$expect" "$result")"
    printf '%s' "$code"
    [[ "$result" == "PASS" ]]
}

# =====================================================================
# Manual notes  (§22)  — text is STORED, never executed
# =====================================================================
evidence_note() {
    local note="$*"
    [[ -n "$EV_RUN_DIR" ]] || { echo "No active run" >&2; return 1; }
    ev_action "MANUAL NOTE: ${note}"
    ev_log "$EV_F_ACTIONS" "(operator note recorded)"
}

# =====================================================================
# JSON emit (pure Bash, no deps)  (§29)
# =====================================================================
_json_escape() {
    local s="$*"
    s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
    s="${s//$'\t'/\\t}"; s="${s//$'\n'/\\n}"; s="${s//$'\r'/\\r}"
    printf '%s' "$s"
}

# Emit a JSON array of objects from a TSV file. Args: file col1 col2 ...
_json_array_from_tsv() {
    local file="$1"; shift
    local cols=("$@")
    printf '['
    if [[ -f "$file" ]]; then
        local first=1 line
        while IFS=$'\t' read -r -a f; do
            [[ $first -eq 1 ]] && first=0 || printf ','
            printf '{'
            local i
            for i in "${!cols[@]}"; do
                [[ $i -gt 0 ]] && printf ','
                printf '"%s":"%s"' "${cols[$i]}" "$(_json_escape "${f[$i]:-}")"
            done
            printf '}'
        done < "$file"
    fi
    printf ']'
}

# Emit a JSON object of scalar key/values from kv.tsv (last value wins).
_json_object_from_kv() {
    printf '{'
    if [[ -f "${EV_META_DIR}/kv.tsv" ]]; then
        awk -F'\t' '{v[$1]=$2; if(!( $1 in seen)){order[++n]=$1; seen[$1]=1}}
                    END{for(i=1;i<=n;i++){k=order[i]; printf "%s%s\t%s", (i>1?"\x01":""), k, v[k]}}' \
            "${EV_META_DIR}/kv.tsv" \
        | while IFS=$'\t' read -r -d $'\x01' k v || [[ -n "$k" ]]; do
            [[ -n "${_kvfirst:-}" ]] && printf ',' ; _kvfirst=1
            printf '"%s":"%s"' "$(_json_escape "$k")" "$(_json_escape "$v")"
          done
    fi
    printf '}'
}

# =====================================================================
# Finalize  (§23, §24, §25, §29, §42)
# =====================================================================
# evidence_finalize <SUCCESS|FAILED|PARTIAL> [failed_phase] [failed_cmd] [exit_code] [error_code]
evidence_finalize() {
    local status="$1"; shift || true
    local fphase="${1:-}" fcmd="${2:-}" fcode="${3:-}" ferr="${4:-}"
    EV_STATUS="$status"
    _ev_kv_set status "$status"
    _ev_kv_set finished_at_utc "$(ev_now_utc)"
    _ev_kv_set finished_at_local "$(ev_now_local)"
    [[ -n "$fphase" ]] && _ev_kv_set failed_phase "$fphase"
    [[ -n "$fcmd"   ]] && _ev_kv_set failed_command "$(redact_text "$fcmd")"
    [[ -n "$fcode"  ]] && _ev_kv_set failed_exit_code "$fcode"
    [[ -n "$ferr"   ]] && _ev_kv_set failed_error_code "$ferr"

    collect_final_state
    _ev_write_manifest
    _ev_write_report
    ev_action "Installation finalized: STATUS=${status}"
}

collect_final_state() { # (§42, §32)
    {
        echo "===== Final system state (§42) ====="
        echo "Captured (UTC): $(ev_now_utc)"
        echo "Installation status: ${EV_STATUS}"
        echo
        echo "----- Services -----"
        for svc in nginx docker postgresql; do
            printf '%-12s %s\n' "$svc:" "$(systemctl is-active "$svc" 2>/dev/null || echo 'unknown')"
        done
        echo
        echo "----- Containers -----"
        (sudo docker compose -f deploy/docker-compose.production.yml ps 2>/dev/null \
            || docker ps 2>/dev/null || echo 'docker unavailable') | redact_stream
        echo
        echo "----- Listening ports -----"
        (ss -tlnp 2>/dev/null || echo 'ss unavailable') | redact_stream
        echo
        echo "----- Disk free -----"
        df -h / 2>/dev/null
        echo
        echo "----- Memory free -----"
        free -h 2>/dev/null
    } | redact_stream > "${EV_RUN_DIR}/${EV_F_FINAL}"
}

_ev_write_manifest() {
    local out="${EV_RUN_DIR}/${EV_F_MANIFEST}"
    {
        printf '{\n'
        printf '  "schema": "awamer.installation-manifest/v1",\n'
        printf '  "meta": %s,\n' "$(_json_object_from_kv)"
        printf '  "preflight": %s,\n' "$(_json_array_from_tsv "${EV_META_DIR}/preflight.tsv" check result notes)"
        printf '  "components": %s,\n' "$(_json_array_from_tsv "${EV_META_DIR}/components.tsv" name version_before version_after result)"
        printf '  "phases": %s,\n' "$(_json_array_from_tsv "${EV_META_DIR}/phases.tsv" phase result duration)"
        printf '  "migrations": %s,\n' "$(_json_array_from_tsv "${EV_META_DIR}/migrations.tsv" version name duration result)"
        printf '  "fingerprints": %s,\n' "$(_json_array_from_tsv "${EV_META_DIR}/fingerprints.tsv" label sha256)"
        printf '  "errors": %s,\n' "$(_json_array_from_tsv "${EV_META_DIR}/errors.tsv" phase operation exit_code error_code message)"
        printf '  "warnings": %s\n' "$(_json_array_from_tsv "${EV_META_DIR}/warnings.tsv" phase message)"
        printf '}\n'
    } > "$out"
}

_ev_kv() { _ev_kv_get "$1"; }

_ev_write_report() {
    local out="${EV_RUN_DIR}/${EV_F_REPORT}"
    {
        echo "# Awamer Installation Report"
        echo
        echo "## Installation Identification"
        echo
        echo '```'
        echo "Run ID:              $(_ev_kv run_id)"
        echo "Date (UTC):          $(_ev_kv started_at_utc)"
        echo "Date (local):        $(_ev_kv started_at_local)"
        echo "Timezone:            $(_ev_kv timezone)"
        echo "Server:              $(_ev_kv hostname)"
        echo "OS:                  $(_ev_kv os)"
        echo "Architecture:        $(_ev_kv architecture)"
        echo "Application revision: $(_ev_kv app_commit) ($(_ev_kv app_branch))"
        echo "Installer version:   $(_ev_kv installer_version)"
        echo '```'
        echo
        echo "## Preflight"
        echo
        echo "| Check | Result | Notes |"
        echo "| ----- | ------ | ----- |"
        _ev_md_rows "${EV_META_DIR}/preflight.tsv" 3
        echo
        echo "## Components"
        echo
        echo "| Component | Version (after) | Result |"
        echo "| --------- | --------------- | ------ |"
        _ev_md_components
        echo
        echo "## Installation Phases"
        echo
        echo "| Phase | Result | Duration |"
        echo "| ----- | ------ | -------- |"
        _ev_md_rows "${EV_META_DIR}/phases.tsv" 3
        echo
        echo "## Database"
        echo
        echo '```'
        echo "PostgreSQL:       $(_ev_kv postgres_version)"
        echo "Connectivity:     $(_ev_kv postgres_connectivity)"
        echo "Database exists:  $(_ev_kv postgres_db_exists)"
        echo "Migration start:  $(_ev_kv migration_start)"
        echo "Migration end:    $(_ev_kv migration_end)"
        echo "Migration result: $(_ev_kv migration_result)"
        echo '```'
        echo
        echo "## Nginx"
        echo
        echo '```'
        echo "Version:  $(_ev_kv nginx_version)"
        echo "nginx -t: $(_ev_kv nginx_config_test)"
        echo "service:  $(_ev_kv nginx_service)"
        echo '```'
        echo
        echo "## TLS"
        echo
        echo '```'
        echo "Domain:               $(_ev_kv tls_domain)"
        echo "Certificate existed:  $(_ev_kv tls_cert_before)"
        echo "Certificate issuance: $(_ev_kv tls_issuance)"
        echo "Certificate present:  $(_ev_kv tls_cert_after)"
        echo "Certificate expiry:   $(_ev_kv tls_expiry)"
        echo '```'
        echo
        echo "## Docker"
        echo
        echo '```'
        echo "Compose validation: $(_ev_kv docker_compose_config)"
        echo "Containers:         $(_ev_kv docker_containers)"
        echo "Health:             $(_ev_kv docker_health)"
        echo '```'
        echo
        echo "## Application"
        echo
        echo '```'
        echo "Backend:   $(_ev_kv app_backend)"
        echo "Frontend:  $(_ev_kv app_frontend)"
        echo "API:       $(_ev_kv app_api)"
        echo "WebSocket: $(_ev_kv app_websocket)"
        echo '```'
        echo
        echo "## Health"
        echo
        echo '```'
        echo "/healthz: $(_ev_kv health_healthz)"
        echo "/readyz:  $(_ev_kv health_readyz)"
        echo '```'
        echo
        echo "## Errors"
        echo
        if [[ -s "${EV_META_DIR}/errors.tsv" ]]; then
            echo "| Phase | Operation | Exit | Error code | Message |"
            echo "| ----- | --------- | ---- | ---------- | ------- |"
            _ev_md_rows "${EV_META_DIR}/errors.tsv" 5
        else
            echo "None recorded."
        fi
        echo
        echo "## Warnings"
        echo
        if [[ -s "${EV_META_DIR}/warnings.tsv" ]]; then
            echo "| Phase | Message |"
            echo "| ----- | ------- |"
            _ev_md_rows "${EV_META_DIR}/warnings.tsv" 2
        else
            echo "None recorded."
        fi
        echo
        echo "## Manual Actions"
        echo
        if grep -q 'MANUAL NOTE:' "${EV_RUN_DIR}/${EV_F_ACTIONS}" 2>/dev/null; then
            echo '```'
            grep 'MANUAL NOTE:' "${EV_RUN_DIR}/${EV_F_ACTIONS}"
            echo '```'
        else
            echo "None recorded."
        fi
        echo
        echo "## Final Installation Status"
        echo
        echo '```'
        echo "$(_ev_kv status)"
        echo '```'
        echo
        if [[ "$(_ev_kv status)" == "FAILED" ]]; then
            echo "Failed phase: $(_ev_kv failed_phase)"
            echo
            echo "Failed command: \`$(_ev_kv failed_command)\`"
            echo
            echo "Exit code: $(_ev_kv failed_exit_code)   Error code: $(_ev_kv failed_error_code)"
            echo
        fi
        echo "---"
        echo
        echo "_This report validates the INSTALLATION only. It is NOT a"
        echo "production-approval decision (§24/§49)._"
    } > "$out"
}

# _ev_md_rows <tsv> <ncols>  — render tsv as markdown table rows (pipe-escaped)
_ev_md_rows() {
    local file="$1" n="$2"
    [[ -f "$file" ]] || return 0
    awk -F'\t' -v n="$n" '{
        line="|"
        for(i=1;i<=n;i++){c=$i; gsub(/\|/,"\\|",c); line=line " " c " |"}
        print line
    }' "$file"
}

_ev_md_components() {
    local file="${EV_META_DIR}/components.tsv"
    [[ -f "$file" ]] || return 0
    awk -F'\t' '{ n=$1; a=$3; r=$4; gsub(/\|/,"\\|",n); gsub(/\|/,"\\|",a); gsub(/\|/,"\\|",r);
        printf "| %s | %s | %s |\n", n, a, r }' "$file"
}
