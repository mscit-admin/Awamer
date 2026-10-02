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
#
# Encryption at rest: set BACKUP_GPG_RECIPIENT (a key id / e-mail in the
# operator's GPG keyring — public key only on this host) in .env.production and
# the dump is written as netsphere-<ts>.sql.gz.gpg. Without it the dump is
# written UNENCRYPTED (it holds password hashes and AES-GCM-sealed secrets) with
# mode 600 in a mode-700 directory, and a warning is printed.
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

# Backups are owner-only: never readable by other local users.
umask 077
BACKUP_DIR="${REPO_ROOT}/backups"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
OUTFILE="${BACKUP_DIR}/netsphere-${TIMESTAMP}.sql.gz"
if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
    command -v gpg >/dev/null || { echo "Error: BACKUP_GPG_RECIPIENT is set but gpg is not installed"; exit 1; }
    OUTFILE="${OUTFILE}.gpg"
fi

echo "Backing up to $OUTFILE..."
# --no-owner/--no-acl: restore.sh re-applies ownership + least-privilege grants
# with deploy/db/provision-roles.sh, so the dump stays portable.
dump() {
    sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production exec -T postgres \
        pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl | gzip -9
}
if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
    dump | gpg --batch --yes --trust-model always --encrypt --recipient "$BACKUP_GPG_RECIPIENT" > "$OUTFILE"
else
    dump > "$OUTFILE"
    echo "⚠  Backup is NOT encrypted (set BACKUP_GPG_RECIPIENT to encrypt at rest)."
fi
chmod 600 "$OUTFILE"

SIZE=$(du -h "$OUTFILE" | cut -f1)
echo "✓ Backup complete: $OUTFILE ($SIZE)"

# Optional: prune old backups (keep last 14)
find "$BACKUP_DIR" \( -name "netsphere-*.sql.gz" -o -name "netsphere-*.sql.gz.gpg" \) -mtime +14 -delete
echo "✓ Pruned backups older than 14 days"
