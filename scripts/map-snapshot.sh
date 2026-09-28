#!/usr/bin/env bash
# map-snapshot.sh: refresh this box's last-known copy of the shared map store.
#
# Only for boxes that READ the store over NFS (docs/shared-maps.md). The game
# server loads maps straight from the NFS mount (MAP_STORE_DIR). This copy
# (MAP_STORE_SNAPSHOT_DIR) is what it falls back to when the store cannot be
# reached, so a transatlantic outage costs only the maps added since the last
# run, never the whole pool. On the box that owns the store, MAP_STORE_DIR is
# unset or points at its own server/maps, and this script does nothing.
# docs/map-store-runbook.md is the production setup.
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
#   scripts/map-snapshot.sh              # reads MAP_STORE_DIR etc. from .env / server/.env
#   MAP_STORE_DIR=/srv/racesow/maps scripts/map-snapshot.sh
#   MAP_SNAPSHOT_SIZE_ONLY=1 scripts/map-snapshot.sh
#                                        # compare packs by size only: for the
#                                        # first sync after seeding the snapshot
#                                        # from a local pool (runbook step E)
#   scripts/map-snapshot.sh --mount      # (root) mount the store if it is an
#                                        # fstab entry that is not mounted, then exit
# Run by racesow-map-snapshot.timer. Exit status: 0 synced or nothing to do,
# 1 refused (store unreachable or shrank), 2 misconfigured.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"

# The store paths live in whichever .env the box's game compose file reads:
# ~/racesow/.env on a box that runs docker-compose.agent.yml (US), or
# server/.env on one that runs server/docker-compose.yml (EU). Both are
# read, the process environment wins, and a relative path is resolved
# against the directory of the .env it came from, exactly as compose does.
# Only these two keys are taken from either file.
resolve() {   # resolve <path> <base dir>
    case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$2" "${1#./}" ;; esac
}
for ENV_FILE in "${REPO_ROOT}/.env" "${REPO_ROOT}/server/.env"; do
    [ -f "${ENV_FILE}" ] || continue
    base="$(dirname -- "${ENV_FILE}")"
    while IFS='=' read -r key val; do
        case "${key}" in
            MAP_STORE_DIR|MAP_STORE_SNAPSHOT_DIR)
                val="${val%\"}"; val="${val#\"}"
                if [ -z "${!key:-}" ] && [ -n "${val}" ]; then
                    [ "${val}" = "./maps" ] || val="$(resolve "${val}" "${base}")"
                    export "${key}=${val}"
                fi
                ;;
        esac
    done < <(grep -E '^(MAP_STORE_DIR|MAP_STORE_SNAPSHOT_DIR)=' "${ENV_FILE}" || true)
done

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

# --mount (run as root by the service's ExecStartPre=+): a store that is an
# fstab entry but not mounted is mounted. The fstab line is nofail, so a box
# that booted while the link was down comes up without the mount, and nothing
# else would ever retry it. The timer runs this every hour.
if [ "${1:-}" = "--mount" ]; then
    if mountpoint -q -- "${STORE}"; then
        exit 0
    fi
    if ! awk -v m="${STORE}" '$1 !~ /^#/ && $2 == m { found = 1 } END { exit !found }' /etc/fstab; then
        log "${STORE} is not an /etc/fstab mountpoint; not mounting it"
        exit 0
    fi
    if timeout 30 mount -- "${STORE}"; then
        log "mounted ${STORE}"
    else
        log "could not mount ${STORE} (link down?); the game servers keep using the snapshot"
    fi
    exit 0
fi

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
# Packs are never rewritten in place (docs/shared-maps.md), so a pack of the
# right size is the right pack: MAP_SNAPSHOT_SIZE_ONLY=1 skips the mtime
# comparison, which is what makes a snapshot seeded by hard-linking a local
# pool (whose mtimes differ from the store's) cost only the missing packs.
# rsync replaces a file by writing a new one and renaming it, so a seeded
# hard link is never modified under the pool it came from.
EXTRA=()
[ "${MAP_SNAPSHOT_SIZE_ONLY:-}" = "1" ] && EXTRA+=(--size-only)
timeout "${SYNC_TIMEOUT}" rsync -a --delete --delay-updates --partial-dir=.rsync-partial "${EXTRA[@]}" \
    --include="${SENTINEL}" --include='*.pk3' --exclude='*' \
    --chmod=F644,D755 --stats "${STORE}/" "${SNAPSHOT}/" \
    | sed -n 's/^\(Number of \(created\|deleted\|regular transferred\) files.*\)$/map-snapshot: \1/p'
log "done: $(count "${SNAPSHOT}") packs in the snapshot"
