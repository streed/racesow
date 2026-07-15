#!/usr/bin/env bash
# fetch-maps.sh — mirror race map .pk3 packs from livesow.net into server/maps/.
#
# Scrapes http://livesow.net/race/maplist.php for pk3 download links and
# downloads every pack not already present in server/maps/ — the directory
# the game server mounts read-only and symlinks into the mod dir on start
# (see server/docker-compose.yml). The full list is ~4300 packs / ~12.5 GB,
# so expect the first run to take a while.
#
# Safe by design:
#   - idempotent: existing non-empty .pk3 files are skipped; rerun to top up
#   - atomic: downloads go to a hidden temp file and are only renamed into
#     place after the transfer completes, the file passes a zip integrity
#     check, and the data is flushed to disk
#   - a pack that fails to download or verify never lands in the maps dir;
#     failures are listed in <dest>/.fetch-failed.txt and retried on rerun
#   - single-instance: concurrent runs against the same dir are refused
#   - when new packs land in the live maps dir, the warsow-race container is
#     restarted so the server actually loads them (--no-restart to skip)
#
# Usage:
#   scripts/fetch-maps.sh                 # download everything missing
#   scripts/fetch-maps.sh --limit 20      # stop after 20 downloads (testing)
#   scripts/fetch-maps.sh --jobs 8        # parallel downloads (default 4)
#   scripts/fetch-maps.sh --dest DIR      # download somewhere else
#   scripts/fetch-maps.sh --force         # re-download packs already present
#   scripts/fetch-maps.sh --dry-run       # list what would be downloaded
#   scripts/fetch-maps.sh --no-restart    # don't restart the game server
#
# The maplist source can be overridden for testing:
#   MAPLIST_URL=file:///tmp/maplist.html scripts/fetch-maps.sh --dry-run
set -euo pipefail

MAPLIST_URL="${MAPLIST_URL:-http://livesow.net/race/maplist.php}"
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${REPO_ROOT}/server/maps"
JOBS=4
LIMIT=0
FORCE=0
DRY_RUN=0
RESTART=1

while [ $# -gt 0 ]; do
    case "$1" in
        --dest)       DEST="${2:?--dest needs a directory}"; shift ;;
        --jobs)       JOBS="${2:?--jobs needs a number}"; shift ;;
        --limit)      LIMIT="${2:?--limit needs a number}"; shift ;;
        --force)      FORCE=1 ;;
        --dry-run)    DRY_RUN=1 ;;
        --no-restart) RESTART=0 ;;
        -h|--help)    sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
    shift
done

die() { echo "ERROR: $*" >&2; exit 1; }
say() { printf '>> %s\n' "$*"; }

command -v curl  >/dev/null 2>&1 || die "curl is not installed / not in PATH"
command -v flock >/dev/null 2>&1 || die "flock is not installed / not in PATH"
case "${JOBS}"  in ''|*[!0-9]*) die "--jobs must be a positive integer" ;; esac
case "${LIMIT}" in *[!0-9]*)    die "--limit must be a number" ;; esac
[ "${JOBS}" -ge 1 ] || die "--jobs must be a positive integer"

STATE="$(mktemp -d)"
trap 'rm -rf "${STATE}"' EXIT

# --- Fetch the map list and extract unique pk3 URLs ---------------------------
say "fetching map list from ${MAPLIST_URL}"
curl -gfsSL --connect-timeout 15 --max-time 120 "${MAPLIST_URL}" > "${STATE}/maplist.html" \
    || die "could not fetch the map list"

# Lines look like: <a href="http://livesow.net/wsw/race/<name>.pk3">pk3</a> ...
# Several map names can share one pack, so the same href repeats — dedupe.
grep -o 'href="[^"]*\.pk3"' "${STATE}/maplist.html" \
    | sed 's/^href="//; s/"$//' | sort -u > "${STATE}/urls" || true

total=$(wc -l < "${STATE}/urls")
[ "${total}" -gt 0 ] || die "no .pk3 links found in the map list — has the page format changed?"
say "found ${total} unique pk3 pack(s)"

# --- Claim the destination ------------------------------------------------------
mkdir -p "${DEST}"
DEST="$(cd -- "${DEST}" && pwd -P)"      # canonical, so the live-dir check works
LIVE_MAPS="$(cd -- "${REPO_ROOT}/server/maps" 2>/dev/null && pwd -P || true)"

# One run per destination: parallel invocations would race on temp files and
# double-download. The lock file is hidden so the pk3 machinery ignores it.
exec 9> "${DEST}/.fetch-maps.lock"
flock -n 9 || die "another fetch-maps.sh run is already working on ${DEST}"

# Sweep temp files stranded by an interrupted earlier run (safe under the lock).
find "${DEST}" -maxdepth 1 -name '.part-*' -delete 2>/dev/null || true

# --- Figure out what is missing ------------------------------------------------
: > "${STATE}/todo"
skipped=0
declare -A seen_names
while IFS= read -r url; do
    name="${url##*/}"
    if [ -n "${seen_names[${name}]:-}" ]; then
        say "WARNING: duplicate pack name '${name}' — keeping ${seen_names[${name}]}, ignoring ${url}"
        continue
    fi
    seen_names["${name}"]="${url}"
    if [ "${FORCE}" = "0" ] && [ -s "${DEST}/${name}" ]; then
        skipped=$((skipped + 1))
    else
        printf '%s\n' "${url}" >> "${STATE}/todo"
    fi
done < "${STATE}/urls"

todo=$(wc -l < "${STATE}/todo")
if [ "${LIMIT}" -gt 0 ] && [ "${todo}" -gt "${LIMIT}" ]; then
    head -n "${LIMIT}" "${STATE}/todo" > "${STATE}/todo.limited"
    mv "${STATE}/todo.limited" "${STATE}/todo"
    say "limiting this run to ${LIMIT} of ${todo} missing pack(s) (--limit)"
    todo="${LIMIT}"
fi
say "${skipped} already present, ${todo} to download"

if [ "${todo}" -eq 0 ]; then
    say "nothing to do"
    exit 0
fi

if [ "${DRY_RUN}" = "1" ]; then
    sed 's/^/   would download: /' "${STATE}/todo"
    say "dry run — nothing downloaded"
    exit 0
fi

# --- Download -------------------------------------------------------------------
# Each worker gets one "index<TAB>url" line. Progress lines are printed only for
# downloads and failures; results are tallied in ${STATE}/ok and ${STATE}/failed
# (O_APPEND keeps concurrent single-line writes intact).
: > "${STATE}/ok"
: > "${STATE}/failed"

fetch_one() {
    local idx url name out part enc
    IFS=$'\t' read -r idx url <<< "$1"
    name="${url##*/}"
    out="${DEST}/${name}"
    # '#' in a pack name would otherwise be sent as a URL fragment; the rest of
    # the observed charset (+ ! ` [ ]) passes through curl -g untouched.
    enc="${url//\#/%23}"

    # mktemp gives every worker its own glob-free temp name: pack names contain
    # [brackets] that unzip would expand as wildcard patterns, and a shared
    # <name>.part path would let parallel/interrupted runs clobber each other.
    if ! part="$(mktemp "${DEST}/.part-XXXXXXXX")"; then
        printf '[%s/%s] FAIL %s (mktemp failed)\n' "${idx}" "${TOTAL_TODO}" "${name}"
        printf '%s\ttemp-error\n' "${url}" >> "${STATE}/failed"
        return 0
    fi

    # --speed-limit/--speed-time kill stalled transfers without capping how
    # long a big pack may take on a slow link; --retry-all-errors makes curl
    # also retry mid-transfer drops (exit 18), which plain --retry ignores.
    # Retrying non-transient errors is safe: the zip check gates the install.
    if ! curl -gfsSL --connect-timeout 15 \
            --speed-limit 8192 --speed-time 60 --max-time 7200 \
            --retry 3 --retry-delay 2 --retry-all-errors \
            -o "${part}" "${enc}"; then
        rm -f "${part}"
        printf '[%s/%s] FAIL %s (download error)\n' "${idx}" "${TOTAL_TODO}" "${name}"
        printf '%s\tdownload-error\n' "${url}" >> "${STATE}/failed"
        return 0
    fi

    # pk3 files are plain zips: verify before installing so a corrupt or
    # HTML-masquerading response never reaches the game server.
    if command -v unzip >/dev/null 2>&1; then
        if ! unzip -qqt "${part}" >/dev/null 2>&1; then
            rm -f "${part}"
            printf '[%s/%s] FAIL %s (not a valid zip)\n' "${idx}" "${TOTAL_TODO}" "${name}"
            printf '%s\tbad-zip\n' "${url}" >> "${STATE}/failed"
            return 0
        fi
    elif [ "$(head -c 2 "${part}" 2>/dev/null)" != "PK" ]; then
        rm -f "${part}"
        printf '[%s/%s] FAIL %s (no zip magic)\n' "${idx}" "${TOTAL_TODO}" "${name}"
        printf '%s\tbad-zip\n' "${url}" >> "${STATE}/failed"
        return 0
    fi

    # mktemp creates the temp file 0600; the game container reads the maps dir
    # as its own non-root user (uid 999), so an unreadable pack silently drops
    # out of map discovery AND fails the engine's pk3 load. Make it world-
    # readable before it lands.
    chmod 644 "${part}"

    # Flush to disk before the rename: otherwise a hard reboot in the writeback
    # window can persist the directory entry ahead of the data, stranding a
    # short nonempty file at the final name that the -s skip then trusts forever.
    sync "${part}" 2>/dev/null || sync || true
    if ! mv "${part}" "${out}"; then
        rm -f "${part}"
        printf '[%s/%s] FAIL %s (install error)\n' "${idx}" "${TOTAL_TODO}" "${name}"
        printf '%s\tinstall-error\n' "${url}" >> "${STATE}/failed"
        return 0
    fi

    printf '[%s/%s] ok %s (%s)\n' "${idx}" "${TOTAL_TODO}" "${name}" \
        "$(du -h "${out}" | cut -f1)"
    printf '%s\n' "${url}" >> "${STATE}/ok"
}
export -f fetch_one
export DEST STATE TOTAL_TODO="${todo}"

nl -ba -w1 "${STATE}/todo" | xargs -d '\n' -n1 -P "${JOBS}" bash -c 'fetch_one "$1"' _

# --- Summary ---------------------------------------------------------------------
ok=$(wc -l < "${STATE}/ok")
failed=$(wc -l < "${STATE}/failed")
say "done: ${ok} downloaded, ${skipped} already present, ${failed} failed"
say "maps dir: ${DEST} ($(du -sh "${DEST}" 2>/dev/null | cut -f1))"

# Persist the failure list where a rerun (or a human) can find it: the temp
# state dir dies with the process. Reruns retry these automatically since the
# packs never got installed.
FAILED_LIST="${DEST}/.fetch-failed.txt"
if [ "${failed}" -gt 0 ]; then
    cp "${STATE}/failed" "${FAILED_LIST}"
    say "failed packs (also in ${FAILED_LIST}; rerun to retry):"
    sed 's/^/   /' "${STATE}/failed"
else
    rm -f "${FAILED_LIST}"
fi

# --- Load the new packs -------------------------------------------------------
# The entrypoint only symlinks/scans pk3s at container start, so a running
# server won't see new packs until restarted. Both compose files pin
# container_name: warsow-race, so plain `docker restart` works for either
# deployment regardless of compose project or cwd.
if [ "${ok}" -gt 0 ] && [ -n "${LIVE_MAPS}" ] && [ "${DEST}" = "${LIVE_MAPS}" ]; then
    if [ "${RESTART}" = "0" ]; then
        say "skipping game-server restart (--no-restart); restart later with:"
        say "   docker restart warsow-race"
    elif command -v docker >/dev/null 2>&1 \
            && [ "$(docker inspect -f '{{.State.Running}}' warsow-race 2>/dev/null)" = "true" ]; then
        say "restarting the game server to load the new packs"
        docker restart warsow-race >/dev/null
    else
        say "game server not running — the new packs load when it starts"
    fi
fi

[ "${failed}" -eq 0 ] || exit 1
