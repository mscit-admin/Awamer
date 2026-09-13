#!/usr/bin/env bash
# =====================================================================
# Awamer Terminal — Database backup
# =====================================================================
#
# Creates a timestamped dump of the postgres database. Compresses with
# gzip. Files are written to ./backups/ by default.
#
# Run from project root:
#   ./deploy/scripts/backup.sh
#
# For automation, add to crontab:
#   0 3 * * * cd /opt/netsphere && ./deploy/scripts/backup.sh >> /var/log/netsphere-backup.log 2>&1
#
# Keep the last 14 daily backups:
#   find ./backups -name "netsphere-*.sql.gz" -mtime +14 -delete
# =====================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f .env.production ]]; then
    echo "Error: .env.production not found in $REPO_ROOT"
    exit 1
fi

# shellcheck disable=SC1091
source .env.production

BACKUP_DIR="${REPO_ROOT}/backups"
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
OUTFILE="${BACKUP_DIR}/netsphere-${TIMESTAMP}.sql.gz"

echo "Backing up to $OUTFILE..."
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production exec -T postgres \
    pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl \
    | gzip -9 > "$OUTFILE"

SIZE=$(du -h "$OUTFILE" | cut -f1)
echo "✓ Backup complete: $OUTFILE ($SIZE)"

# Optional: prune old backups (keep last 14)
find "$BACKUP_DIR" -name "netsphere-*.sql.gz" -mtime +14 -delete
echo "✓ Pruned backups older than 14 days"
