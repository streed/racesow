#!/usr/bin/env bash
# backup-db.sh — consistent online snapshot of data/db.sqlite.
#
# Uses better-sqlite3's backup API inside the running racesow-web container
# (safe against concurrent writes; captures WAL contents), gzips the result
# into backups/db/ and prunes snapshots older than RETENTION_DAYS (14).
#
# Run manually, or nightly via the systemd timer:
#   systemd/install.sh full     # installs + enables racesow-db-backup.timer
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${REPO_ROOT}/backups/db"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TMP="${REPO_ROOT}/data/.backup-tmp.sqlite"

die() { echo "ERROR: $*" >&2; exit 1; }

docker inspect -f '{{.State.Running}}' racesow-web 2>/dev/null | grep -qx true \
    || die "racesow-web is not running — it owns the DB file and the sqlite driver"

mkdir -p "${OUT_DIR}"
rm -f "${TMP}"

# /data inside the container is the repo's ./data bind mount, so the snapshot
# lands next to the live DB and is gzipped from the host side.
docker exec racesow-web node -e '
  require("better-sqlite3")("/data/db.sqlite", { readonly: true })
    .backup("/data/.backup-tmp.sqlite")
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); })'

[ -s "${TMP}" ] || die "backup produced no file at ${TMP}"
gzip -c "${TMP}" > "${OUT_DIR}/db-${STAMP}.sqlite.gz"
rm -f "${TMP}"

find "${OUT_DIR}" -name 'db-*.sqlite.gz' -mtime +"${RETENTION_DAYS}" -delete

echo "backup: ${OUT_DIR}/db-${STAMP}.sqlite.gz ($(du -h "${OUT_DIR}/db-${STAMP}.sqlite.gz" | cut -f1)); $(find "${OUT_DIR}" -name 'db-*.sqlite.gz' | wc -l) snapshot(s) kept"
