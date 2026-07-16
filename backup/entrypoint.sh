#!/bin/sh
# Self-scheduling loop for the weekly public database backup.
#
# There is no host cron: this long-lived sidecar produces a fresh backup on
# boot if the current one is missing or older than BACKUP_INTERVAL_SECONDS, then
# re-checks every BACKUP_CHECK_SECONDS. So `docker compose up` is all it takes
# for a racesow instance to keep a weekly, publicly downloadable backup current
# — even one started mid-week self-heals to a fresh file.
set -eu

: "${DATABASE_URL:?set DATABASE_URL}"
OUT_DIR="${OUT_DIR:-/backups}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-604800}"   # 7 days
CHECK="${BACKUP_CHECK_SECONDS:-86400}"          # re-evaluate daily
LATEST="$OUT_DIR/racesow-db-latest.zip"

log() { echo "[db-backup $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Stop promptly on container shutdown. This process is PID 1, for which the
# kernel ignores default signal actions — so without an explicit trap a
# `docker stop` would hang the full grace period and then SIGKILL. Backups are
# published atomically, so being killed mid-run is safe (the next run redoes it).
trap 'log "shutting down"; exit 0' TERM INT

# Interruptible sleep: run it in the background and `wait`, so a signal fires the
# trap immediately instead of after the current sleep elapses.
nap() { sleep "$1" & wait "$!"; }

mkdir -p "$OUT_DIR"

# depends_on: service_healthy already gates this, but a bare `docker run` might
# not — wait for the database before the first dump attempt.
until pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; do
  log "waiting for database ..."
  nap 3
done

log "started (interval=${INTERVAL}s, check=${CHECK}s, out=$OUT_DIR)"

while true; do
  now=$(date +%s)
  if [ -f "$LATEST" ]; then
    age=$(( now - $(stat -c %Y "$LATEST") ))
  else
    age=$INTERVAL   # force a run when there is no backup yet
  fi

  if [ "$age" -ge "$INTERVAL" ]; then
    log "generating backup (age=${age}s >= interval ${INTERVAL}s)"
    if /usr/local/bin/backup.sh; then
      log "backup complete"
    else
      log "backup FAILED (will retry at next check)"
    fi
  else
    log "backup is fresh (age=${age}s < interval ${INTERVAL}s), skipping"
  fi

  nap "$CHECK"
done
