#!/usr/bin/env bash
# =====================================================================
# NetSphere Terminal — Generate cryptographically strong secrets
# =====================================================================
#
# Run this AT MOST ONCE on a new install. The output is meant to be
# pasted into .env.production.
#
# After the secrets are committed, changing them will:
#   - Invalidate all JWT access tokens (users will need to re-login)
#   - Invalidate all stored MFA secrets (users must re-enroll TOTP)
#
# So treat the .env.production file as critical infrastructure: back
# it up to a secure password manager + encrypted backup.
# =====================================================================

set -e

if ! command -v openssl >/dev/null 2>&1; then
    echo "Error: openssl is required but not installed."
    echo "  sudo apt install openssl"
    exit 1
fi

generate_hex() {
    openssl rand -hex "$1"
}

generate_b64() {
    openssl rand -base64 "$1" | tr -d '\n='
}

cat <<EOF
# =====================================================================
# NetSphere production secrets — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Paste into .env.production and KEEP THIS FILE SAFE.
# =====================================================================

POSTGRES_USER=netsphere
POSTGRES_PASSWORD=$(generate_b64 32)
POSTGRES_DB=netsphere

REDIS_PASSWORD=$(generate_b64 32)

# Crypto secrets — variable names match backend/src/config/index.ts.
JWT_ACCESS_SECRET=$(generate_hex 64)
JWT_REFRESH_SECRET=$(generate_hex 64)
# Phase 10 — AES-256-GCM key for credential secrets at rest (32 bytes, base64).
CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)

BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=$(generate_b64 24)
BOOTSTRAP_ADMIN_EMAIL=admin@netsphere.local

CORS_ALLOWED_ORIGINS=https://netsphere.example.com,tauri://localhost,https://tauri.localhost

LOG_LEVEL=info
RATE_LIMIT_LOGIN_PER_MIN=10
RATE_LIMIT_API_PER_MIN=120

APP_VERSION=1.8.0
EOF
