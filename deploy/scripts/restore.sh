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
if [[ "$BACKUP_FILE" == *.gpg ]]; then
    gpg --batch --decrypt "$BACKUP_FILE" | gunzip -c
else
    gunzip -c "$BACKUP_FILE"
fi | sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# DB-LEAST-PRIVILEGE: the dump is taken --no-owner --no-acl, so the restored
# objects belong to the cluster admin with no grants. Re-provision (ownership →
# awamer_migrator, runtime grants) and run pending migrations BEFORE the
# backend starts — otherwise awamer_app has no access (fails closed).
echo "Re-applying least-privilege roles and grants..."
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production run --rm db-provision
echo "Applying any pending migrations as the schema owner..."
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production run --rm migrate

echo "Restarting auth-service..."
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production up -d auth-service

# Recovery verification: the backend must report READY against the restored DB.
for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:8081/readyz >/dev/null 2>&1; then
        echo "✓ Restore complete — backend READY on the restored database"
        exit 0
    fi
    sleep 2
done
echo "✗ Backend did not become READY after restore — check: docker compose logs auth-service migrate"
exit 1
