#!/usr/bin/env bash
# =====================================================================
# SEC-PROXY-001 / PROXY-DEPLOY-001 — dynamic reverse-proxy (Docker gateway) trust.
#
# The backend trusts X-Forwarded-* ONLY from configured proxy hops (TRUST_PROXY,
# app default "loopback"). In the shipped topology the backend runs in a container
# behind the host Nginx (published on 127.0.0.1:8081), so its peer is the Docker
# bridge GATEWAY, not loopback. This library DISCOVERS the actual gateway of the
# network the auth-service container is on and appends it as an EXACT host route
# (/32 for IPv4, /128 for IPv6). It NEVER trusts a whole private range, keywords
# ("uniquelocal"/"linklocal"), or "true", and FAILS CLOSED (keeps just "loopback"
# + an action-required warning) when the gateway cannot be determined safely.
#
# Sourced by install.sh and update.sh; unit-tested with a mock `docker`.
# =====================================================================

# --- validation --------------------------------------------------------------
tp_valid_ipv4() {  # $1=addr → 0 if a real, non-broad IPv4 host address
  local a="$1"
  [[ "$a" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local o; for o in "${BASH_REMATCH[@]:1}"; do (( o >= 0 && o <= 255 )) || return 1; done
  [[ "$a" == "0.0.0.0" || "$a" == "255.255.255.255" ]] && return 1
  return 0
}
tp_valid_ipv6() {  # $1=addr → 0 if a plausible, non-broad IPv6 host address
  local a="$1"
  [[ "$a" == *:* ]] || return 1
  [[ "$a" =~ ^[0-9A-Fa-f:]+$ ]] || return 1
  [[ "$a" == "::" || "$a" == "::1" ]] && return 1   # unspecified/loopback are not a gateway
  return 0
}
# True (0) if a TRUST_PROXY value contains a dangerously broad entry (never add one).
tp_is_broad_entry() {
  local e; e="$(printf '%s' "$1" | tr -d '[:space:]' | tr 'A-Z' 'a-z')"
  # Exact trust-everyone/nothing tokens, or wildcard keywords, anywhere in the list.
  printf '%s' "$e" | grep -qE '(^|,)(true|false|\*|0\.0\.0\.0/0|::/0|0\.0\.0\.0|::|uniquelocal|linklocal)(,|$)' && return 0
  # Whole private/large CIDR blocks (the classic RFC1918 supernets or a small prefix).
  printf '%s' "$e" | grep -qE '(^|,)(10\.0\.0\.0/8|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+/1[0-6]|192\.168\.[0-9]+\.[0-9]+/(1[0-6])|fc00::/7|fe80::/10)(,|$)' && return 0
  return 1
}

# --- discovery ---------------------------------------------------------------
# Print "<ipv4gw>\t<ipv6gw>" (either may be empty) for the network the given
# container is attached to; fall back to inspecting the named network. Requires a
# working `docker`. Returns non-zero and prints nothing on any ambiguity/failure
# (fail-closed — the caller keeps loopback and warns).
tp_discover_gateway() {  # $1=container-name  $2=network-name
  local container="$1" network="$2" v4="" v6="" line
  # Docker CLI invocation (install.sh sets TP_DOCKER="sudo docker").
  local -a DK; read -r -a DK <<< "${TP_DOCKER:-docker}"
  command -v "${DK[0]}" >/dev/null 2>&1 || return 1
  # Prefer the container's real attachment (authoritative for the peer address).
  line="$("${DK[@]}" inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$v.Gateway}}|{{$v.GlobalIPv6Gateway}} {{end}}' "$container" 2>/dev/null || true)"
  # Fall back to (or supplement with) the named network's IPAM gateways.
  if [[ -z "${line// /}" ]]; then
    line="$("${DK[@]}" network inspect -f '{{range .IPAM.Config}}{{.Gateway}}|{{end}}' "$network" 2>/dev/null || true)"
  fi
  [[ -n "${line// /}" ]] || return 1
  # Collect candidate v4/v6 gateways; require exactly one distinct v4 (no guessing
  # across multiple unrelated networks).
  local tok gw
  local -a v4s=() v6s=()
  for tok in $line; do
    gw="${tok%%|*}"
    local rest="${tok#*|}"; local g6="${rest%%|*}"
    if [[ -n "$gw" ]] && tp_valid_ipv4 "$gw"; then v4s+=("$gw"); fi
    if [[ -n "$g6" ]] && tp_valid_ipv6 "$g6"; then v6s+=("$g6"); fi
  done
  # de-dup
  local uniq4; uniq4="$(printf '%s\n' "${v4s[@]:-}" | sort -u | sed '/^$/d')"
  local uniq6; uniq6="$(printf '%s\n' "${v6s[@]:-}" | sort -u | sed '/^$/d')"
  local n4; n4="$(printf '%s\n' "$uniq4" | sed '/^$/d' | wc -l | tr -d ' ')"
  local n6; n6="$(printf '%s\n' "$uniq6" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "$n4" == "1" ]]; then v4="$uniq4"; elif [[ "$n4" -gt 1 ]]; then return 1; fi  # ambiguous → fail closed
  if [[ "$n6" == "1" ]]; then v6="$uniq6"; fi   # multiple v6 → skip v6 (v4 still usable)
  [[ -n "$v4" || -n "$v6" ]] || return 1
  printf '%s\t%s\n' "$v4" "$v6"
}

# --- build managed value -----------------------------------------------------
tp_build_managed() {  # $1=ipv4gw(optional)  $2=ipv6gw(optional) → "loopback[,gw/32][,gw6/128]"
  local out="loopback"
  [[ -n "${1:-}" ]] && tp_valid_ipv4 "$1" && out="${out},${1}/32"
  [[ -n "${2:-}" ]] && tp_valid_ipv6 "$2" && out="${out},${2}/128"
  printf '%s' "$out"
}

# --- env-file helpers --------------------------------------------------------
tp_env_get() { grep -E '^TRUST_PROXY=' "$1" 2>/dev/null | head -1 | cut -d= -f2- || true; }
tp_marker_get() { grep -E '^# awamer-managed-trust-proxy=' "$1" 2>/dev/null | head -1 | cut -d= -f2- || true; }
tp_norm() { printf '%s' "$1" | tr -d '[:space:]' | tr 'A-Z' 'a-z'; }

# Atomically set TRUST_PROXY=<value> and its managed-marker in the env file,
# preserving mode. Removes any prior marker + TRUST_PROXY lines first.
tp_env_write() {  # $1=env_file  $2=value
  local f="$1" val="$2" tmp; tmp="$(mktemp)"
  grep -vE '^(# awamer-managed-trust-proxy=|TRUST_PROXY=)' "$f" > "$tmp" 2>/dev/null || true
  { printf '# awamer-managed-trust-proxy=%s\n' "$val"; printf 'TRUST_PROXY=%s\n' "$val"; } >> "$tmp"
  cat "$tmp" > "$f"; rm -f "$tmp"; chmod 600 "$f" 2>/dev/null || true
}

# --- the decision (PROXY-DEPLOY-001 §8/§9/§10) -------------------------------
# Echoes one status token on stdout for the caller/tests:
#   set|migrated|refreshed|kept-custom|action-required
tp_configure_env() {  # $1=env_file  $2=container  $3=network  [$4=say-fn]
  local f="$1" container="$2" network="$3" sayfn="${4:-:}"
  [[ -f "$f" ]] || { printf 'no-env\n'; return 0; }

  local gw v4="" v6=""
  if gw="$(tp_discover_gateway "$container" "$network")"; then
    v4="$(printf '%s' "$gw" | cut -f1)"; v6="$(printf '%s' "$gw" | cut -f2)"
  fi
  local managed; managed="$(tp_build_managed "$v4" "$v6")"

  local cur gen; cur="$(tp_env_get "$f")"; gen="$(tp_marker_get "$f")"
  local hasline; hasline="$(grep -E '^TRUST_PROXY=' "$f" || true)"

  # Fail-closed: gateway not determinable → keep loopback only, never broaden.
  if [[ "$managed" == "loopback" ]]; then
    if [[ -z "$hasline" ]]; then
      tp_env_write "$f" "loopback"
      "$sayfn" "TRUST_PROXY set to 'loopback' (secure default). ACTION REQUIRED: could not auto-discover the Docker proxy gateway — if the backend runs behind Docker NAT, add the exact gateway host route (e.g. loopback,172.x.y.1/32; see 'docker network inspect $network')."
      printf 'action-required\n'; return 0
    fi
    "$sayfn" "TRUST_PROXY left as '${cur}'. ACTION REQUIRED: could not auto-discover the Docker proxy gateway to confirm it; verify TRUST_PROXY includes the exact gateway host route."
    printf 'action-required\n'; return 0
  fi

  # No line yet → write the managed value.
  if [[ -z "$hasline" ]]; then
    tp_env_write "$f" "$managed"; "$sayfn" "TRUST_PROXY set to '${managed}' (loopback + discovered Docker gateway, exact host route)."
    printf 'set\n'; return 0
  fi
  # Known legacy broad default → migrate to the managed value.
  if [[ "$(tp_norm "$cur")" == "loopback,uniquelocal" ]]; then
    tp_env_write "$f" "$managed"; "$sayfn" "Migrated broad TRUST_PROXY ('loopback, uniquelocal') to '${managed}' (SEC-PROXY-001)."
    printf 'migrated\n'; return 0
  fi
  # Installer previously generated it and the admin has not edited it since →
  # safe to refresh (replaces a stale gateway; never accumulates).
  if [[ -n "$gen" && "$(tp_norm "$cur")" == "$(tp_norm "$gen")" ]]; then
    if [[ "$(tp_norm "$cur")" == "$(tp_norm "$managed")" ]]; then
      "$sayfn" "TRUST_PROXY already '${cur}' (current Docker gateway) — unchanged."
      printf 'unchanged\n'; return 0
    fi
    tp_env_write "$f" "$managed"; "$sayfn" "Refreshed managed TRUST_PROXY to '${managed}' (Docker gateway changed from '${cur}')."
    printf 'refreshed\n'; return 0
  fi
  # A plain "loopback" with no marker (e.g. first upgrade to Docker-gateway trust)
  # is a generated default → upgrade it to include the discovered gateway.
  if [[ "$(tp_norm "$cur")" == "loopback" && -z "$gen" ]]; then
    tp_env_write "$f" "$managed"; "$sayfn" "Upgraded TRUST_PROXY 'loopback' → '${managed}' (added discovered Docker gateway)."
    printf 'set\n'; return 0
  fi
  # Otherwise the administrator has customized it → NEVER overwrite. Preserve it;
  # warn if broad or if the discovered gateway is missing.
  if tp_is_broad_entry "$cur"; then
    "$sayfn" "WARNING: TRUST_PROXY ('${cur}') is broad — trust ONLY exact proxy host routes (e.g. loopback,${v4:-172.x.y.1}/32), never whole private ranges. Left unchanged (custom)."
  elif [[ -n "$v4" ]] && ! printf '%s' "$(tp_norm "$cur")" | grep -qF "${v4}/32"; then
    "$sayfn" "TRUST_PROXY ('${cur}') is administrator-customized — preserved. NOTE: the discovered Docker gateway ${v4}/32 is not listed; add it if you need accurate per-client IPs."
  else
    "$sayfn" "TRUST_PROXY ('${cur}') is administrator-customized — preserved unchanged."
  fi
  printf 'kept-custom\n'; return 0
}
