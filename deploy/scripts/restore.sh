#!/usr/bin/env bash
# =====================================================================
# Awamer Terminal — Database restore
# =====================================================================
#
# Restore a backup created by backup.sh. WIPES the existing database
# before restore — this is destructive!
#
# Usage:
#   ./deploy/scripts/restore.sh backups/netsphere-20260512-030000.sql.gz
# =====================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <backup.sql.gz>"
    exit 1
fi

BACKUP_FILE="$1"

if [[ ! -f "$BACKUP_FILE" ]]; then
    echo "Error: $BACKUP_FILE not found"
    exit 1
fi

# shellcheck disable=SC1091
source .env.production

echo "⚠  This will REPLACE all data in database '$POSTGRES_DB'."
echo "    Backup to restore: $BACKUP_FILE"
read -rp "Continue? Type the database name to confirm: " CONFIRM
if [[ "$CONFIRM" != "$POSTGRES_DB" ]]; then
    echo "Aborted."
    exit 1
fi

echo "Stopping auth-service..."
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production stop auth-service

echo "Dropping and recreating database..."
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production exec -T postgres \
    psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS $POSTGRES_DB;"
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production exec -T postgres \
    psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE $POSTGRES_DB OWNER $POSTGRES_USER;"

echo "Restoring backup..."
gunzip -c "$BACKUP_FILE" | sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production exec -T postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

echo "Restarting auth-service..."
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production up -d auth-service

echo "✓ Restore complete"
