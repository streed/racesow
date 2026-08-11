#!/bin/sh
# Contract test for the bad-map crash guard (server/crashguard.sh, driven by
# server/entrypoint.sh's restart loop).
#
# The behaviour under test is the one that was missing when a map killed the
# server: the supervise loop must LEARN from a failed launch. Concretely --
#   1. a boot map the engine dies on is not retried forever,
#   2. the next launch picks a different map from the vetted pool,
#   3. the failure is recorded durably and reported to the API,
#   4. a host-level fault (socket bind) is NOT blamed on the map,
#   5. a healthy launch quarantines nothing.
#
# Runs the REAL entrypoint against a sandbox WARSOW_DIR with a fake wsw_server
# that fails on a nominated map and records every map it was asked to load.
#
#   sh server/test/crashguard.test.sh
#
# NOTE: run this under dash (as CI and the image do), not bash:
#   docker run --rm -v "$PWD:/w" -w /w ubuntu:24.04 sh server/test/crashguard.test.sh
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ENTRYPOINT="${HERE}/../entrypoint.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT INT TERM

fail() { echo "FAIL: $*" >&2; [ -n "${BOX:-}" ] && sed -n '1,80p' "${BOX}/entrypoint.log" >&2; exit 1; }

# A fake Warsow install whose "engine" fails on $2 (a map name, or "" for none)
# with the error text in $3. Records each map it is asked to load.
sandbox() {
    box="${TMP}/$1"; badmap="$2"; errtext="$3"
    mkdir -p "${box}/racemod/configs/server" "${box}/basewsw" "${box}/racemod/racelog"
    # A curated pool: the entrypoint keeps only maps that are "installed", so
    # fake a pk3 listing by making the pool exactly these three names.
    printf '%s\n' alpha-run bravo-run charlie-run > "${box}/racemod/mappool.txt"
    cat > "${box}/fake-unzip" <<'UNZ'
#!/bin/sh
# stand-in for `unzip -Z1 <pk3>`: report the three maps of the fake pool
printf 'maps/alpha-run.bsp\nmaps/bravo-run.bsp\nmaps/charlie-run.bsp\n'
UNZ
    chmod +x "${box}/fake-unzip"
    : > "${box}/basewsw/fake.pk3"

    cat > "${box}/wsw_server.x86_64" <<EOF
#!/bin/sh
printf '%s\n' "\$@" > "${box}/launch-args.txt"
map=""; prev=""
for a in "\$@"; do
    [ "\${prev}" = "+map" ] && map="\${a}"
    prev="\${a}"
done
printf '%s\n' "\${map}" >> "${box}/maps-tried.txt"
# The real engine prints this BEFORE CM_LoadMap; it is the crash guard's anchor.
# The trailing ESC[0m is NOT decoration: both compose files allocate a tty, so
# the engine really emits colour escapes and the name arrives as
# "alpha-run<ESC>[0m". A tap that does not strip it quarantines a name that
# matches no pool entry, and the bad map is never skipped.
printf 'SpawnServer: %s\033[0m\n' "\${map}"
if [ -n "${badmap}" ] && [ "\${map}" = "${badmap}" ]; then
    echo "********************"
    echo "ERROR: ${errtext}"
    echo "********************"
    exit 1
fi
echo "server is up and serving \${map}"
sleep 30
EOF
    chmod +x "${box}/wsw_server.x86_64"
    echo "${box}"
}

# Drive the entrypoint for $2 seconds. Backoff is compressed to 1s and a single
# failure quarantines, so a few seconds covers several relaunches.
drive() {
    box="$1"; secs="$2"; shift 2
    PATH="${box}:${PATH}"                       # fake-unzip is not used; see note
    env -i PATH="${PATH}" HOME="${HOME}" \
        WARSOW_DIR="${box}" \
        RS_CRASHGUARD_FAILS=1 \
        RS_CRASHGUARD_BACKOFF="1 1 1" \
        RS_CRASHGUARD_HEALTHY_SECS=5 \
        RS_CRASHGUARD_STATE="${box}/cgstate" \
        RS_CRASHGUARD_RUN="${box}/cgrun" \
        "$@" \
        timeout "${secs}" sh "${ENTRYPOINT}" > "${box}/entrypoint.log" 2>&1 || true
}

# The sandbox has no real pk3s, so the entrypoint's installed-map discovery
# finds nothing and MAPLIST falls back through mappool.txt filtering to empty,
# then to FIRST_MAP=race. To exercise real pool selection we pre-seed the maps
# the entrypoint would have discovered by shipping a pk3 the real `unzip` can
# read. Build one with the three map entries.
make_pool_pk3() {
    box="$1"
    d="${TMP}/pk3build"
    rm -rf "${d}"; mkdir -p "${d}/maps"
    : > "${d}/maps/alpha-run.bsp"
    : > "${d}/maps/bravo-run.bsp"
    : > "${d}/maps/charlie-run.bsp"
    ( cd "${d}" && zip -qr "${box}/basewsw/pool.pk3" maps ) || fail "could not build the fixture pk3 (zip missing?)"
    rm -f "${box}/basewsw/fake.pk3"
}

# --- Case 1: the boot map kills the engine -> the loop moves on ---------------
BOX="$(sandbox bootfail alpha-run "Game Error: GClip_SetBrushModel: NULL model in 'trigger_multiple'")"
make_pool_pk3 "${BOX}"
drive "${BOX}" 12

[ -f "${BOX}/maps-tried.txt" ] || fail "the fake engine was never launched"
first="$(sed -n 1p "${BOX}/maps-tried.txt")"
[ "${first}" = "alpha-run" ] || fail "expected the first boot map to be the pool head 'alpha-run', got '${first}'"

tried="$(wc -l < "${BOX}/maps-tried.txt")"
[ "${tried}" -ge 2 ] || fail "the engine was only launched ${tried}x; the loop never relaunched"

second="$(sed -n 2p "${BOX}/maps-tried.txt")"
[ "${second}" != "alpha-run" ] || fail "the loop retried the SAME bad map ('${second}') — this is the bootloop"
case "${second}" in
    bravo-run|charlie-run) : ;;
    *) fail "the replacement map '${second}' is not from the vetted pool" ;;
esac

# The failure must be persisted, and durably (not just in the ephemeral run dir).
Q="${BOX}/cgstate/quarantine.tsv"
[ -f "${Q}" ] || fail "no quarantine file was written to the durable state dir"
grep -q '^alpha-run	' "${Q}" || fail "alpha-run was not recorded in the quarantine: $(cat "${Q}")"

# And it must never come back while it is quarantined.
grep -c '^alpha-run$' "${BOX}/maps-tried.txt" > "${TMP}/n" || true
[ "$(cat "${TMP}/n")" = "1" ] || fail "alpha-run was booted more than once despite being quarantined"

# --- Case 2: a socket error is the HOST's fault, not the map's ----------------
# Without this exclusion a bad host condition walks the quarantine through the
# whole pool, one map per relaunch, ending with a server that refuses every map.
BOX="$(sandbox sockfail alpha-run "Couldn't open any socket")"
make_pool_pk3 "${BOX}"
drive "${BOX}" 10
Q2="${BOX}/cgstate/quarantine.tsv"
if [ -s "${Q2}" ]; then
    fail "a socket error must not quarantine a map, but got: $(cat "${Q2}")"
fi
grep -q 'not a map fault' "${BOX}/entrypoint.log" || fail "expected the socket error to be classified as a host fault"

# --- Case 3: a healthy launch blames nothing ---------------------------------
BOX="$(sandbox healthy "" "")"
make_pool_pk3 "${BOX}"
drive "${BOX}" 8
Q3="${BOX}/cgstate/quarantine.tsv"
if [ -s "${Q3}" ]; then
    fail "a healthy launch must not quarantine anything, but got: $(cat "${Q3}")"
fi
[ "$(wc -l < "${BOX}/maps-tried.txt")" = "1" ] || fail "a healthy server should not have been relaunched"

# --- Case 4: RS_CRASHGUARD=0 restores the previous fixed-argv behaviour -------
BOX="$(sandbox disabled alpha-run "Game Error: GClip_SetBrushModel: NULL model")"
make_pool_pk3 "${BOX}"
drive "${BOX}" 14 RS_CRASHGUARD=0
u="$(sort -u "${BOX}/maps-tried.txt" | wc -l)"
[ "${u}" = "1" ] || fail "with the crash guard off the boot map must never change, but ${u} distinct maps were tried"

# --- Case 5: the SAME guarantees on the Warfork tier -------------------------
# This is the tier that actually wedges in production (Warfork still runs
# upstream's fatal GClip_SetBrushModel where Warsow's racemod tree patched it),
# and it drives a different entrypoint with a different layout and a different
# shell. The bootloop must be broken there too, or the fix misses the servers
# that need it.
WF_ENTRY="${HERE}/../../warfork/entrypoint.sh"
if [ ! -r "${WF_ENTRY}" ]; then
    echo "SKIP: ${WF_ENTRY} not found"
elif ! command -v bash >/dev/null 2>&1; then
    echo "SKIP: warfork/entrypoint.sh needs bash"
else
    box="${TMP}/warfork"
    mkdir -p "${box}/racesow/configs/server" "${box}/basewf"
    printf '%s\n' alpha-run bravo-run charlie-run > "${box}/racesow/mappool.txt"
    d="${TMP}/wfpk3"; rm -rf "${d}"; mkdir -p "${d}/maps"
    : > "${d}/maps/alpha-run.bsp"; : > "${d}/maps/bravo-run.bsp"; : > "${d}/maps/charlie-run.bsp"
    ( cd "${d}" && zip -qr "${box}/basewf/pool.pk3" maps ) || fail "could not build the warfork fixture pk3"
    # Both scanned dirs must contain at least one pk3. warfork/entrypoint.sh
    # builds INSTALLED from a `for ... [ -e ] && unzip` pipeline under
    # `set -euo pipefail`, so a game dir with NO pk3s makes the whole assignment
    # exit non-zero and the entrypoint aborts before it launches anything. In
    # production the mod dir always holds the symlinked mirror, so this only
    # bites an empty install — but it is why this fixture populates both.
    cp "${box}/basewf/pool.pk3" "${box}/racesow/pool.pk3"
    cat > "${box}/wf_server.x86_64" <<EOF
#!/bin/sh
map=""; prev=""
for a in "\$@"; do
    [ "\${prev}" = "+map" ] && map="\${a}"
    prev="\${a}"
done
printf '%s\n' "\${map}" >> "${box}/maps-tried.txt"
echo "SpawnServer: \${map}"
if [ "\${map}" = "alpha-run" ]; then
    echo "ERROR: Game Error: GClip_SetBrushModel: NULL model in 'trigger_multiple'"
    exit 1
fi
echo "server is up"
sleep 30
EOF
    chmod +x "${box}/wf_server.x86_64"

    # In the IMAGE the Dockerfile drops crashguard.sh beside /entrypoint.sh, so
    # the default `$(dirname $0)/crashguard.sh` resolves. In the source tree the
    # two live in different directories, so point at the shared copy explicitly.
    env -i PATH="${PATH}" HOME="${HOME}" \
        WF_DIR="${box}" \
        CRASHGUARD_SH="${HERE}/../crashguard.sh" \
        RS_CRASHGUARD_FAILS=1 \
        RS_CRASHGUARD_BACKOFF="1 1 1" \
        RS_CRASHGUARD_HEALTHY_SECS=5 \
        RS_CRASHGUARD_STATE="${box}/cgstate" \
        RS_CRASHGUARD_RUN="${box}/cgrun" \
        timeout 12 bash "${WF_ENTRY}" > "${box}/entrypoint.log" 2>&1 || true

    BOX="${box}"
    [ -f "${box}/maps-tried.txt" ] || fail "warfork: the fake engine was never launched"
    wf_first="$(sed -n 1p "${box}/maps-tried.txt")"
    [ "${wf_first}" = "alpha-run" ] || fail "warfork: expected pool head 'alpha-run', got '${wf_first}'"
    [ "$(wc -l < "${box}/maps-tried.txt")" -ge 2 ] || fail "warfork: the loop never relaunched"
    wf_second="$(sed -n 2p "${box}/maps-tried.txt")"
    [ "${wf_second}" != "alpha-run" ] || fail "warfork: the loop retried the same bad map — bootloop intact"
    grep -q '^alpha-run	' "${box}/cgstate/quarantine.tsv" || fail "warfork: alpha-run was not quarantined"
    BOX=""
fi

echo "OK: crash guard contract tests passed"
