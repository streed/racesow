#!/usr/bin/env bash
# map-snapshot.sh: refresh this box's last-known copy of the shared map store.
#
# Only for boxes that READ the store over NFS (docs/shared-maps.md). The game
# server loads maps straight from the NFS mount (MAP_STORE_DIR). This copy
# (MAP_STORE_SNAPSHOT_DIR) is what it falls back to when the store cannot be
# reached, so a transatlantic outage costs only the maps added since the last
# run, never the whole pool. On the box that owns the store, MAP_STORE_DIR is
# unset or points at its own server/maps, and this script does nothing.
#
# It will never make the snapshot worse than it was:
#   * No sentinel, no sync. The store's root holds .racesow-map-store. A mount
#     that is down (or never came up and left an empty mountpoint) does not
#     show it, and --delete against an empty source would wipe the snapshot.
#   * A listing that shrinks by more than half is treated as a partial read
#     of a sick mount, not as mass deletion, and the run is refused.
#   * --delay-updates: new packs land under a temp name and are renamed in at
#     the end, so the game server never sees a half-copied pack.
#
# Usage:
#   scripts/map-snapshot.sh              # reads MAP_STORE_DIR etc. from server/.env
#   MAP_STORE_DIR=/srv/racesow/maps scripts/map-snapshot.sh
# Run by racesow-map-snapshot.timer. Exit status: 0 synced or nothing to do,
# 1 refused (store unreachable or shrank), 2 misconfigured.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
ENV_FILE="${REPO_ROOT}/server/.env"

# server/.env is the one place the store paths are configured (the compose
# file reads the same variables). Only these two keys are taken from it.
if [ -f "${ENV_FILE}" ]; then
    while IFS='=' read -r key val; do
        case "${key}" in
            MAP_STORE_DIR|MAP_STORE_SNAPSHOT_DIR)
                val="${val%\"}"; val="${val#\"}"
                [ -z "${!key:-}" ] && export "${key}=${val}"
                ;;
        esac
    done < <(grep -E '^(MAP_STORE_DIR|MAP_STORE_SNAPSHOT_DIR)=' "${ENV_FILE}" || true)
fi

STORE="${MAP_STORE_DIR:-}"
SNAPSHOT="${MAP_STORE_SNAPSHOT_DIR:-${REPO_ROOT}/server/maps-snapshot}"
case "${SNAPSHOT}" in /*) ;; *) SNAPSHOT="${REPO_ROOT}/server/${SNAPSHOT#./}" ;; esac
SENTINEL=".racesow-map-store"
LIST_TIMEOUT="${LIST_TIMEOUT:-120}"
SYNC_TIMEOUT="${SYNC_TIMEOUT:-3h}"

log() { echo "map-snapshot: $*"; }
command -v rsync >/dev/null 2>&1 || { log "rsync is required (apt install rsync)"; exit 2; }

if [ -z "${STORE}" ] || [ "${STORE}" = "./maps" ] || \
   [ "$(cd -- "${STORE}" 2>/dev/null && pwd -P)" = "${REPO_ROOT}/server/maps" ]; then
    log "this box owns the map store (MAP_STORE_DIR is its own server/maps); nothing to do"
    exit 0
fi
case "${STORE}" in /*) ;; *) log "MAP_STORE_DIR must be an absolute path, got '${STORE}'"; exit 2 ;; esac

if ! timeout 15 test -e "${STORE}/${SENTINEL}"; then
    log "store ${STORE} does not show ${SENTINEL} (link down or not mounted); keeping the snapshot as it is"
    exit 1
fi

mkdir -p "${SNAPSHOT}"
count() { timeout "${LIST_TIMEOUT}" find "$1" -maxdepth 1 -name '*.pk3' -type f -printf . | wc -c; }
if ! store_n="$(count "${STORE}")"; then
    log "listing ${STORE} timed out; keeping the snapshot as it is"
    exit 1
fi
snap_n="$(count "${SNAPSHOT}")"
if [ "${snap_n}" -gt 0 ] && [ $(( store_n * 2 )) -lt "${snap_n}" ]; then
    log "store lists ${store_n} packs but the snapshot has ${snap_n}; refusing to delete" \
        "more than half of it (a partial read of a sick mount looks exactly like this)"
    exit 1
fi

log "syncing ${store_n} packs from ${STORE} to ${SNAPSHOT} (snapshot had ${snap_n})"
timeout "${SYNC_TIMEOUT}" rsync -a --delete --delay-updates --partial-dir=.rsync-partial \
    --include="${SENTINEL}" --include='*.pk3' --exclude='*' \
    --chmod=F644,D755 --stats "${STORE}/" "${SNAPSHOT}/" \
    | sed -n 's/^\(Number of \(created\|deleted\|regular transferred\) files.*\)$/map-snapshot: \1/p'
log "done: $(count "${SNAPSHOT}") packs in the snapshot"
