# shellcheck shell=sh
# mapscan-lib.sh: discover the maps installed in a set of game directories,
# without re-reading every pack on every boot.
#
# Sourced by BOTH entrypoints — server/entrypoint.sh (Warsow) and
# warfork/entrypoint.sh (Warfork) — the same way crashguard.sh is, from the
# directory the entrypoint itself lives in. It defines functions only and
# must stay POSIX sh: the Warsow entrypoint runs under `set -eu` and the
# Warfork one under `set -euo pipefail`, so nothing here may leave a non-zero
# status behind or rely on bash. Every pipeline whose failure is LEGITIMATE is
# therefore guarded with `|| true` — `unzip` on a truncated pack, and a `grep
# -v` that filters everything away, both exit non-zero, and under pipefail
# either one would otherwise abort the entrypoint and bootloop the container.
#
# Why it exists: a map is playable when a maps/<name>.bsp exists inside a pk3
# in a directory the engine scans, and the only way to know is to read each
# pack's central directory. With a 4,600-pack pool that is tens of seconds on
# local disk and ruinous over NFS — measured at ~52 RPCs/sec against the
# shared map store, it hung a US boot for over twenty minutes with the server
# unreachable, and every restart paid it again.
#
# Packs are never rewritten in place (fetch-maps.sh and the mapgen worker
# always write a new file), so a pack's size and name identify its contents.
# Cache "<size>\t<name>\t<maps>" and re-read only packs the cache has never
# seen. A restart with an unchanged pool then costs one directory listing per
# directory instead of one archive read per pack. Measured on a 400-pack pool:
# 0.84s cold, 0.013s warm.
#
# INSTALLED_CACHE is where the cache lives. Callers point it at a persisted
# mount (the racelog volume) so it survives a container recreate; if it cannot
# be written the scan still works, it just stops saving anything.

# The map names inside one pack, one per line.
pack_maps() {
    # A pack that is truncated, still being written, or simply not a zip makes
    # unzip exit non-zero. Skipping it is right; aborting the boot is not.
    unzip -Z1 "$1" 2>/dev/null | sed -n 's#^maps/\([^/]*\)\.bsp$#\1#p' || true
}

# Print every installed map name, using and refreshing INSTALLED_CACHE.
# Arguments are the directories to scan. Fields are TAB-separated throughout,
# so a pack filename containing spaces cannot split a record (map names
# themselves cannot: see RACE_MAPNAME_CHARS in the gametype).
# MAPSCAN_LABEL prefixes the summary line, so a cache-warming pass and the
# real scan are distinguishable in the boot log.
installed_maps() {
    _tmp="${TMPDIR:-/tmp}/installed.$$"
    _idx="${_tmp}.idx"; _hit="${_tmp}.hit"; _miss="${_tmp}.miss"; _new="${_tmp}.new"
    rm -f "${_idx}" "${_hit}" "${_miss}" "${_new}"
    : > "${_idx}"
    # One listing per directory: over NFS this is a readdir with attributes,
    # not a stat per file.
    #
    # -H dereferences the directory NAMED here, and only that. The Warfork
    # entrypoint hands the engine its pool as a single symlink into fs_cdpath,
    # and without -H `find` lists that symlink itself rather than descending
    # into it -- one empty listing, no maps installed, an empty rotation and
    # every vote failing, with no error anywhere to say why.
    for _dir in "$@"; do
        [ -d "${_dir}" ] || continue
        find -H "${_dir}" -maxdepth 1 -name '*.pk3' -printf '%s\t%f\t%p\n' 2>/dev/null >> "${_idx}" || true
    done
    [ -s "${_idx}" ] || { rm -f "${_idx}"; return 0; }

    # Join the pool against the cache in ONE pass. Hits come out ready to
    # reuse; misses carry the path the archive read needs. A missing, empty or
    # truncated cache simply makes every pack a miss.
    #
    # The cache is read in BEGIN rather than as awk's first input file on
    # purpose. The usual "NR == FNR" two-file idiom breaks silently when the
    # first file is EMPTY -- a first boot, or /dev/null -- because NR == FNR
    # then stays true while reading the SECOND file, so every pack is mistaken
    # for a cache line and the scan reports zero maps installed.
    _cache_src="${INSTALLED_CACHE}"
    [ -f "${_cache_src}" ] || _cache_src=""
    : > "${_hit}"; : > "${_miss}"
    awk -F'\t' -v hit="${_hit}" -v miss="${_miss}" -v cachefile="${_cache_src}" '
        BEGIN {
            while (cachefile != "" && (getline line < cachefile) > 0) {
                t1 = index(line, "\t"); if (t1 == 0) continue
                rest = substr(line, t1 + 1)
                t2 = index(rest, "\t"); if (t2 == 0) continue
                cache[substr(line, 1, t1 - 1) "\t" substr(rest, 1, t2 - 1)] = substr(rest, t2 + 1)
            }
            if (cachefile != "") close(cachefile)
        }
        {
            key = $1 "\t" $2
            if (key in cache) print key "\t" cache[key] > hit
            else              print key "\t" $3        > miss
        }
    ' "${_idx}"

    # Read only the packs the cache had never seen.
    cp "${_hit}" "${_new}"
    while IFS="$(printf '\t')" read -r _size _name _path; do
        [ -n "${_path}" ] || continue
        _maps="$(pack_maps "${_path}" | tr '\n' ' ')"
        printf '%s\t%s\t%s\n' "${_size}" "${_name}" "${_maps% }" >> "${_new}"
    done < "${_miss}"

    # wc -l, not grep -c: grep exits 1 on a zero count AND prints "0", so the
    # usual "|| echo 0" fallback appends a second 0 and the arithmetic below
    # dies on an empty hit or miss list.
    _hits=$(wc -l < "${_hit}" 2>/dev/null || echo 0)
    _misses=$(wc -l < "${_miss}" 2>/dev/null || echo 0)

    # Write back exactly the packs present now, so deleted packs stop being
    # carried forever. A failed write costs the saving, never the boot.
    # The line-count comparison is what catches a pure DELETION: that has no
    # misses at all, so keying the write on misses alone would leave the
    # removed pack in the cache for good.
    if [ -f "${INSTALLED_CACHE}" ]; then
        _cached_lines=$(wc -l < "${INSTALLED_CACHE}")
    else
        _cached_lines=-1
    fi
    _new_lines=$(wc -l < "${_new}")
    if [ "${_misses}" -gt 0 ] || [ "${_cached_lines}" != "${_new_lines}" ] \
       || [ ! -f "${INSTALLED_CACHE}" ]; then
        if mkdir -p "$(dirname "${INSTALLED_CACHE}")" 2>/dev/null \
           && cp "${_new}" "${INSTALLED_CACHE}.new" 2>/dev/null \
           && mv "${INSTALLED_CACHE}.new" "${INSTALLED_CACHE}" 2>/dev/null; then
            :
        else
            rm -f "${INSTALLED_CACHE}.new" 2>/dev/null || true
            echo ">> note: could not write ${INSTALLED_CACHE}; every boot re-reads each pack" >&2
        fi
    fi
    echo ">> ${MAPSCAN_LABEL:-map scan}: $((_hits + _misses)) pack(s), ${_hits} from cache, ${_misses} read" >&2

    # Third field of every record is the space-separated map list. A pool of
    # packs that contain no maps at all filters down to nothing, which is a
    # non-zero grep, not an error.
    cut -d"$(printf '\t')" -f3 "${_new}" | tr ' ' '\n' | grep -v '^$' | sort -u || true
    rm -f "${_idx}" "${_hit}" "${_miss}" "${_new}"
}

# warm_installed_cache <local dir> <dir the real scan will use>
#
# Prime INSTALLED_CACHE from a LOCAL copy of the pool before the real scan
# reads the remote one. The cache is keyed on size+name, not on path, so a
# pack read from the local snapshot answers for the identical pack in the NFS
# store. Without this a box whose cache is cold — a fresh install, a lost
# racelog volume, a first switch to the store — pays the full twenty-minute
# NFS scan once, with the server unreachable throughout.
#
# Skipped when the two are the same directory: that is the store-is-down case,
# where the real scan is already reading local disk. Output is discarded; only
# the cache it leaves behind matters, and a failure here costs nothing but the
# saving, so it never aborts the boot.
warm_installed_cache() {
    _warm_dir="$1"; _real_dir="${2:-}"
    [ -n "${_warm_dir}" ] && [ -d "${_warm_dir}" ] || return 0
    [ "${_warm_dir}" != "${_real_dir}" ] || return 0
    # Steady state this re-reads nothing: every snapshot pack is already
    # cached. It does rewrite the cache down to just the snapshot's packs, so
    # the real scan re-reads whatever the store has and the snapshot does not
    # — the handful of maps added since the last hourly sync, not the pool.
    MAPSCAN_LABEL="map scan (warming the cache from ${_warm_dir})" \
        installed_maps "${_warm_dir}" >/dev/null || true
}
