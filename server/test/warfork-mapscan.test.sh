#!/usr/bin/env bash
# Contract test for the Warfork entrypoint's shared map pool + installed-map
# scan (warfork/entrypoint.sh, server/mapscan-lib.sh).
#
# This is the half of the Warfork boot that talks to the shared map store, and
# it is the half that hurts when it is wrong: the pool feeds fs_cdpath, the map
# rotation and the boot map, and reading it over NFS without the pack cache
# hangs the server for twenty minutes on every restart.
#
#   bash server/test/warfork-mapscan.test.sh
#
# Needs zip + unzip. bash, not sh: the entrypoint under test is a bash script
# (set -euo pipefail), and this test exists partly to prove the POSIX library
# it sources survives pipefail.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENTRYPOINT="${HERE}/../../warfork/entrypoint.sh"

command -v zip   >/dev/null 2>&1 || { echo "SKIP: zip is required"; exit 0; }
command -v unzip >/dev/null 2>&1 || { echo "SKIP: unzip is required"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT INT TERM

fail() { echo "FAIL: $*" >&2; exit 1; }

# A pk3 holding maps/<name>.bsp for each name given.
mkpak() {   # mkpak <path.pk3> <map name>...
    pak="$1"; shift
    d="${TMP}/pak.$$.$RANDOM"; mkdir -p "${d}/maps"
    for m in "$@"; do echo "$m" > "${d}/maps/${m}.bsp"; done
    ( cd "${d}" && zip -qr "${pak}" maps )
    rm -rf "${d}"
}

sandbox() {
    box="${TMP}/wf-$1"
    mkdir -p "${box}/racesow/configs/server" "${box}/racesow/racelog" "${box}/basewf"
    cat > "${box}/wf_server.x86_64" <<EOS
#!/bin/sh
printf '%s\n' "\$@" > "${box}/launch-args.txt"
exit 0
EOS
    chmod +x "${box}/wf_server.x86_64"
    echo "${box}"
}

run_entrypoint() {
    # The supervise loop relaunches the fake server every 5s; kill it during
    # the first sleep. timeout's 124 is the expected status.
    box="$1"; shift
    env -i PATH="${PATH}" HOME="${HOME}" WF_DIR="${box}" \
        CRASHGUARD_SH="${HERE}/../crashguard.sh" \
        MAPS_EXTRA="${box}/maps_extra" MAPS_FALLBACK="${box}/maps_fallback" \
        "$@" timeout 6 bash "${ENTRYPOINT}" > "${box}/entrypoint.log" 2>&1 || true
    [ -f "${box}/launch-args.txt" ] || {
        cat "${box}/entrypoint.log" >&2
        fail "fake wf_server was never launched"
    }
}

cdpath_of() { grep -A1 '^fs_cdpath$' "$1/launch-args.txt" | tail -1; }
cachefile()  { echo "$1/racesow/racelog/.installed-maps.cache"; }

# --- Case 1: a live store is the fs_cdpath, and its maps are installed -------
BOX1="$(sandbox store)"
mkdir -p "${BOX1}/maps_extra" "${BOX1}/maps_fallback"
: > "${BOX1}/maps_extra/.racesow-map-store"
mkpak "${BOX1}/maps_extra/pool.pk3" alpha bravo
printf '%s\n' bravo > "${BOX1}/racesow/mappool.txt"
run_entrypoint "${BOX1}"

[ "$(cdpath_of "${BOX1}")" = "${BOX1}/shared" ] || fail "a live store must be the fs_cdpath"
[ "$(readlink "${BOX1}/shared/racesow")" = "${BOX1}/maps_extra" ] || \
    fail "fs_cdpath must be ONE symlink to the pool, not a per-pack mirror"
[ "$(grep -A1 '^+map$' "${BOX1}/launch-args.txt" | tail -1)" = "bravo" ] || \
    fail "a map that exists only in the store must be bootable from the pool"
grep -qx 'set sv_mapscan "60"' "${BOX1}/racesow/configs/server/env.cfg" || \
    fail "sv_mapscan must default to 60s, the same rescan schedule as Warsow"
[ -s "$(cachefile "${BOX1}")" ] || fail "the pack cache must be written to the racelog mount"

# --- Case 2: the second boot reads no packs at all ---------------------------
# The whole point of the cache: an unchanged pool costs a directory listing,
# not one archive read per pack.
run_entrypoint "${BOX1}"
grep -q '>> map scan: 1 pack(s), 1 from cache, 0 read' "${BOX1}/entrypoint.log" || {
    grep '>> map scan' "${BOX1}/entrypoint.log" >&2 || true
    fail "an unchanged pool must be served entirely from the cache"
}

# --- Case 3: an unreachable store falls back to the local snapshot -----------
# A mount that never came up is an empty directory. Warfork used to point
# straight at the snapshot for exactly this reason; now it prefers the store
# and degrades, so a dead transatlantic link costs freshness, not the pool.
BOX3="$(sandbox store-down)"
mkdir -p "${BOX3}/maps_extra" "${BOX3}/maps_fallback"
mkpak "${BOX3}/maps_fallback/pool.pk3" charlie
run_entrypoint "${BOX3}"
[ "$(readlink "${BOX3}/shared/racesow")" = "${BOX3}/maps_fallback" ] || \
    fail "an unreachable store must fall back to the snapshot"
grep -q 'map store .* is unreachable; using the local snapshot' "${BOX3}/entrypoint.log" || \
    fail "falling back to the snapshot must be logged"
[ "$(grep -A1 '^+map$' "${BOX3}/launch-args.txt" | tail -1)" = "charlie" ] || \
    fail "the snapshot's maps must still be bootable"

# --- Case 4: the snapshot warms the cache for the store ----------------------
# The cache is keyed on pack size+name, not path, so the identical pack read
# from local disk answers for the one in the store. This is what keeps a cold
# boot off the twenty-minute NFS scan.
BOX4="$(sandbox warm)"
mkdir -p "${BOX4}/maps_extra" "${BOX4}/maps_fallback"
: > "${BOX4}/maps_extra/.racesow-map-store"
mkpak "${TMP}/shared-pool.pk3" delta echo
cp "${TMP}/shared-pool.pk3" "${BOX4}/maps_fallback/pool.pk3"
cp "${TMP}/shared-pool.pk3" "${BOX4}/maps_extra/pool.pk3"
# ...plus one pack only the store has: the maps added since the last sync.
mkpak "${BOX4}/maps_extra/fresh.pk3" foxtrot
run_entrypoint "${BOX4}"

grep -q '>> map scan (warming the cache from .*maps_fallback): 1 pack(s), 0 from cache, 1 read' \
    "${BOX4}/entrypoint.log" || {
    grep '>> map scan' "${BOX4}/entrypoint.log" >&2 || true
    fail "the warming pass must read the snapshot's packs from local disk"
}
# The real scan then reads ONLY the store-only pack; the shared one is a hit.
grep -q '>> map scan: 2 pack(s), 1 from cache, 1 read' "${BOX4}/entrypoint.log" || {
    grep '>> map scan' "${BOX4}/entrypoint.log" >&2 || true
    fail "the store scan must reuse the warmed cache and read only what is new"
}
printf '%s\n' foxtrot > "${BOX4}/racesow/mappool.txt"
run_entrypoint "${BOX4}"
[ "$(grep -A1 '^+map$' "${BOX4}/launch-args.txt" | tail -1)" = "foxtrot" ] || \
    fail "a store-only map must be installed and bootable"

# --- Case 5: a corrupt pack is skipped, not fatal ----------------------------
# The entrypoint runs under `set -euo pipefail`, where a non-zero `unzip` in a
# pipeline aborts the script — which restarts the container, forever, with no
# engine and no error. The library guards it; prove the guard.
BOX5="$(sandbox corrupt)"
mkdir -p "${BOX5}/maps_extra" "${BOX5}/maps_fallback"
mkpak "${BOX5}/maps_extra/good.pk3" golf
head -c 64 /dev/urandom > "${BOX5}/maps_extra/truncated.pk3"
run_entrypoint "${BOX5}"
[ "$(grep -A1 '^+map$' "${BOX5}/launch-args.txt" | tail -1)" = "golf" ] || \
    fail "a corrupt pack must be skipped, leaving the good maps bootable"

# --- Case 6: no pool at all is a warning, never a crash ----------------------
BOX6="$(sandbox nopool)"
run_entrypoint "${BOX6}"
[ "$(cdpath_of "${BOX6}")" = "" ] || fail "no pool must launch with no fs_cdpath"

# --- Case 7: a cached pool is listed without touching a single pack ----------
# This is what makes a store over NFS affordable. Asking find for each pack's
# size costs one stat per pack -- 4,600 round trips, measured at 415 s EU->US
# against 0 for the listing alone -- so the cache is keyed on the pack NAME and
# a hit reads nothing. Proven by making every pack unopenable after the cache
# is warm: the scan must still name its maps.
BOX7="$(sandbox cachedonly)"
mkdir -p "${BOX7}/maps_extra"
: > "${BOX7}/maps_extra/.racesow-map-store"
mkpak "${BOX7}/maps_extra/golf.pk3" golf
mkpak "${BOX7}/maps_extra/hotel.pk3" hotel
printf '%s\n' golf > "${BOX7}/racesow/mappool.txt"
run_entrypoint "${BOX7}"
grep -q '>> map scan: 2 pack(s), 0 from cache, 2 read' "${BOX7}/entrypoint.log" || {
    grep '>> map scan' "${BOX7}/entrypoint.log" >&2 || true
    fail "the first scan must read both packs"
}

chmod 000 "${BOX7}/maps_extra/golf.pk3" "${BOX7}/maps_extra/hotel.pk3"
run_entrypoint "${BOX7}"
chmod 644 "${BOX7}/maps_extra/golf.pk3" "${BOX7}/maps_extra/hotel.pk3"
grep -q '>> map scan: 2 pack(s), 2 from cache, 0 read' "${BOX7}/entrypoint.log" || {
    grep '>> map scan' "${BOX7}/entrypoint.log" >&2 || true
    fail "a warm cache must not open any pack"
}
[ "$(grep -A1 '^+map$' "${BOX7}/launch-args.txt" | tail -1)" = "golf" ] || \
    fail "a map known only from the cache must still be bootable"

# And the listing itself must never ask for the size: that is the stat.
grep -q "printf '%f" "$(dirname "$0")/../mapscan-lib.sh" || \
    fail "the pool listing must ask find for names and paths only"

echo "OK: warfork map pool + scan contract tests passed"
