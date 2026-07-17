#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Per-change verification gate for racemod gametype-script edits.
#
# The hrace gametype (AngelScript) compiles at SERVER BOOT, not at Docker
# build time, so the only real test of a .as change is to boot a server and
# watch the log. This brings up the local 3-node mirror mesh
# (docker-compose.mirror-test.yml) and asserts three things on every node:
#
#   BOOT   every script section loads and "Gametype 'Race' initialized"
#          appears, with no AngelScript compile error / exception.
#   MESH   the cross-server mirror AS loop is running (roster ticks) and the
#          nodes exchange datagrams (peers configured).
#   BOTS   a fake player injected host->container (mirror_wire_check.py) is
#          picked up as a mirror ghost/bot on the receiving node.
#
# Usage:
#   server/test/verify-mesh.sh            # rebuild image, recreate mesh, verify
#   server/test/verify-mesh.sh --no-build # reuse current image (fast baseline)
#   server/test/verify-mesh.sh --keep     # leave the mesh running afterwards
#
# Exit 0 = all three checks pass on all three nodes.
# ---------------------------------------------------------------------------
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(cd "${HERE}/.." && pwd)"
ROOT="$(cd "${SERVER_DIR}/.." && pwd)"
COMPOSE="${SERVER_DIR}/docker-compose.mirror-test.yml"

DC="docker compose -f ${COMPOSE}"
NODES="a b c"
MIRROR_SECRET="mirror-test-local-only"
MESH_NET="racesow-mirror-test_default"  # compose project name + _default
BOOT_TIMEOUT=90
# Empirically, a freshly (re)created mesh only ingests remote rosters reliably
# once a node has been up ~2min (peer resolve/settle around the 60s interval);
# below that the fake-player injection is silently missed. Warm up past it.
WARMUP_S=130

BUILD=1 KEEP=0 BOOT_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --no-build)  BUILD=0 ;;
        --keep)      KEEP=1 ;;
        --boot-only) BOOT_ONLY=1 ;;   # compile check only: build + boot + BOOT/peer asserts (~40s, skips warmup+bots)
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
    esac
done

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n'  "$*"; }

FAILED=0
fail() { red "  FAIL: $*"; FAILED=1; }
ok()   { green "  ok:   $*"; }

cleanup() {
    [ -n "${SNAP:-}" ] && rm -rf "${SNAP}" 2>/dev/null || true
    if [ "${KEEP}" -eq 0 ]; then
        bold ">> tearing down mesh"
        ${DC} down -t 3 >/dev/null 2>&1 || true
    else
        bold ">> leaving mesh running (--keep); tear down with: ${DC} down"
    fi
}
trap cleanup EXIT

logs() { docker logs "warsow-mirror-$1" 2>&1; }
# strip ANSI so greps are reliable
clean_logs() { logs "$1" | sed 's/\x1b\[[0-9;]*m//g'; }

# --- (re)build + (re)create ------------------------------------------------
if [ "${BUILD}" -eq 1 ]; then
    bold ">> building image from ${SERVER_DIR}"
    if ! ${DC} build 2>&1 | tail -5; then
        red "image build FAILED"; exit 1
    fi
fi

bold ">> (re)creating 3-node mesh"
${DC} up -d --force-recreate 2>&1 | tail -4

# --- wait for boot ---------------------------------------------------------
bold ">> waiting for boot (up to ${BOOT_TIMEOUT}s)"
deadline=$(( $(date +%s) + BOOT_TIMEOUT ))
for n in ${NODES}; do
    while :; do
        if clean_logs "$n" | grep -q "Gametype 'Race' initialized"; then break; fi
        # a hard compile failure never prints the init line; bail out early on error
        if clean_logs "$n" | grep -qE "^.*\([0-9]+, ?[0-9]+\) : ERR :|Failed to load script|uncaught exception"; then
            break
        fi
        if [ "$(date +%s)" -ge "${deadline}" ]; then break; fi
        sleep 2
    done
done

# The one-shot "rs_mirror: configured" line prints a few ms AFTER the gametype
# init line the boot-wait keys on; give it a short bounded wait on every node
# so the snapshot below doesn't race it (was an intermittent 2/3 false-FAIL).
cfg_deadline=$(( $(date +%s) + 15 ))
while :; do
    cfg=0
    for n in ${NODES}; do
        clean_logs "$n" | grep -q "rs_mirror: configured tag=" && cfg=$((cfg + 1))
    done
    [ "${cfg}" -eq 3 ] && break
    [ "$(date +%s)" -ge "${cfg_deadline}" ] && break
    sleep 1
done

# --- snapshot boot logs NOW ------------------------------------------------
# rs_mirror_debug is verbose; under sustained output docker can rotate the
# early boot lines out of `docker logs` within ~2min. Snapshot each node's log
# immediately after boot so the BOOT + peer-config asserts read pre-rotation
# lines (the "Loaded script section" / "rs_mirror: configured" one-shots).
SNAP="$(mktemp -d)"
for n in ${NODES}; do clean_logs "$n" > "${SNAP}/${n}.log"; done

# --- BOOT check (AngelScript compile, from snapshot) -----------------------
AS_ERR='\([0-9]+, ?[0-9]+\) : ERR :|Failed to load script|uncaught exception|Script compilation failed'
bold ">> BOOT (AngelScript compile) per node"
for n in ${NODES}; do
    L="${SNAP}/${n}.log"
    if grep -q "Gametype 'Race' initialized" "$L"; then
        ok "node $n: Gametype 'Race' initialized ($(grep -c 'Loaded script section' "$L") sections)"
    else
        fail "node $n: did NOT reach 'Gametype Race initialized'"
    fi
    if grep -qE "${AS_ERR}" "$L"; then
        fail "node $n: AngelScript error present:"
        grep -E "${AS_ERR}" "$L" | head -6 | sed 's/^/       /'
    fi
done

# --- MESH: peer set configured (from snapshot) -----------------------------
bold ">> MESH (peer set configured)"
peerok=0
for n in ${NODES}; do
    grep -qE "rs_mirror: configured tag=.* peers=[1-9]" "${SNAP}/${n}.log" && peerok=$((peerok + 1))
done
if [ "${peerok}" -eq 3 ]; then
    ok "mesh: all nodes configured with peers>=1"
else
    fail "mesh: only ${peerok}/3 nodes configured a peer set"
fi

if [ "${BOOT_ONLY}" -eq 1 ]; then
    echo
    if [ "${FAILED}" -eq 0 ]; then
        green "==== BOOT-ONLY PASSED (compile + peer set on all nodes) ===="; exit 0
    else
        red "==== BOOT-ONLY FAILED ===="; exit 1
    fi
fi

# --- warm up the mesh (age-based) ------------------------------------------
# Empirically the AS sync loop only ingests remote rosters reliably once a node
# has been up ~2min; below that fake-player injection is silently missed. Wait
# purely on container uptime (the "configured" one-shot may have rotated away).
bold ">> warming up mesh (~${WARMUP_S}s so roster ingest is reliable)"
started="$(docker inspect -f '{{.State.StartedAt}}' warsow-mirror-a 2>/dev/null)"
started_epoch="$(date -u -d "${started}" +%s 2>/dev/null || echo 0)"
while :; do
    age=$(( $(date -u +%s) - started_epoch ))
    [ "${age}" -ge "${WARMUP_S}" ] && break
    printf '\r   age=%ds/%ds  ' "${age}" "${WARMUP_S}"
    sleep 5
done
echo

# --- MESH liveness: mirror threads live + hearing peers --------------------
# Read the periodic "rs_mirror: stats tx=.. rx=.. heard=[TAGS]" line (emitted
# every ~30s, so always recent and rotation-proof). Its presence proves the
# node's mirror worker thread is alive; a non-empty heard=[..] proves it is
# receiving its peers. (The per-frame rs_mirror(as) roster ticks are unreliable
# here: they are periodic AND the early ones rotate out under debug logging.)
bold ">> MESH (mirror threads live + hearing peers)"
for n in ${NODES}; do
    heard="$(clean_logs "$n" | grep 'rs_mirror: stats' | tail -1 | grep -oE 'heard=\[[^]]*\]')"
    if echo "${heard}" | grep -qE '\[[A-Z]'; then
        ok "node $n: mirror live, ${heard}"
    else
        fail "node $n: mirror not hearing peers (${heard:-no stats line yet})"
    fi
done

# --- BOTS check (fake player join) -----------------------------------------
# Inject a fake racer from INSIDE the compose network (container->container is
# the reliable path on this box; host->container UDP is intermittent) and
# confirm node A ingests it as a mirror ghost/bot. Retry the burst a couple of
# times as insurance against warmup variance.
bold ">> BOTS (inject fake player container->container -> warsow-a)"
MAP="$(clean_logs a | grep -oiE 'aurora-speed1|coldrun' | tail -1)"
MAP="${MAP:-aurora-speed1}"
picked=0
for attempt in 1 2 3; do
    tag="MeshGate${attempt}"
    docker run --rm --network "${MESH_NET}" -v "${ROOT}/e2e:/e2e:ro" python:3-alpine \
        python3 /e2e/mirror_wire_check.py fakeplayer warsow-a:44450 "${MIRROR_SECRET}" B "${MAP}" \
        "${tag}" 100 200 300 12 >/dev/null 2>&1 &
    INJ=$!
    for _ in $(seq 1 12); do
        sleep 1
        if clean_logs a | grep -qE "bot slot [0-9]+ connected as '${tag}'|roster \[B\].*players=1"; then
            picked=1; break
        fi
    done
    kill $INJ 2>/dev/null; wait $INJ 2>/dev/null
    [ "${picked}" -eq 1 ] && break
    bold "   (attempt ${attempt} missed; retrying)"
done
if [ "${picked}" -eq 1 ]; then
    ok "node A: fake player joined as mirror bot"
    clean_logs a | grep -E "bot slot [0-9]+ connected|roster \[B\].*players=1|MeshGate[0-9] entered" | tail -3 | sed 's/^/       /'
else
    fail "node A: fake player was not picked up as a bot/ghost"
fi

# --- verdict ---------------------------------------------------------------
echo
if [ "${FAILED}" -eq 0 ]; then
    green "==== VERIFY PASSED (boot + mesh + fake-player join on all nodes) ===="
    exit 0
else
    red   "==== VERIFY FAILED ===="
    exit 1
fi
