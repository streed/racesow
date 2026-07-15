#!/usr/bin/env bash
# backup-db.sh — consistent nightly dump of the PostgreSQL race database.
#
# Runs pg_dump inside the running racesow-postgres container (a consistent
# snapshot via a single transaction), gzips the custom-format dump into
# backups/db/ and prunes snapshots older than RETENTION_DAYS (14).
#
# Restore with:
#   gunzip -c backups/db/db-YYYYMMDD-HHMMSS.dump.gz \
#     | docker exec -i racesow-postgres pg_restore -U racesow -d racesow --clean --if-exists
#
# Run manually, or nightly via the systemd timer:
#   systemd/install.sh full     # installs + enables racesow-db-backup.timer
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${REPO_ROOT}/backups/db"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${OUT_DIR}/db-${STAMP}.dump.gz"

die() { echo "ERROR: $*" >&2; exit 1; }

docker inspect -f '{{.State.Running}}' racesow-postgres 2>/dev/null | grep -qx true \
    || die "racesow-postgres is not running"

mkdir -p "${OUT_DIR}"

# -Fc = custom format (compressed, selective restore). Pipe straight to gzip on
# the host so nothing large is written inside the container. pg_dump takes a
# consistent snapshot, so this is safe against concurrent ingest writes.
docker exec racesow-postgres pg_dump -U racesow -d racesow -Fc \
    | gzip > "${OUT}.tmp"
mv "${OUT}.tmp" "${OUT}"

[ -s "${OUT}" ] || die "backup produced no file at ${OUT}"

find "${OUT_DIR}" -name 'db-*.dump.gz' -mtime +"${RETENTION_DAYS}" -delete

echo "backup: ${OUT} ($(du -h "${OUT}" | cut -f1)); $(find "${OUT_DIR}" -name 'db-*.dump.gz' | wc -l) snapshot(s) kept"
