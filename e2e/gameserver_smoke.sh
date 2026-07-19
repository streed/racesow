#!/bin/sh
# ---------------------------------------------------------------------------
# Game-server boot + client-connect smoke test.
#
# Everything in run.sh tests the reporting natives in isolation; this boots the
# REAL server image and proves the two things that only a live server can:
#
#   BOOT     the hrace gametype (AngelScript) COMPILES and reaches
#            "Gametype 'Race' initialized" with no script error/exception.
#            (The .as compiles at server boot, never at Docker-build time, so
#            nothing else in CI catches a broken gametype script.)
#   CONNECT  a real client completes the connectionless handshake
#            (getchallenge -> getinfo/getstatus -> connect -> client_connect)
#            against the server's game port. See client_connect_probe.py.
#
# Usage:
#   sh e2e/gameserver_smoke.sh            # build the image if missing, then test
#   sh e2e/gameserver_smoke.sh --build    # force a rebuild first
#   sh e2e/gameserver_smoke.sh --no-build # require the image to already exist
#
# Env:
#   IMAGE    image tag to run   (default warsow-race:2.1.2)
#   SV_PORT  host UDP port       (default 44400)
# ---------------------------------------------------------------------------
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"

IMAGE="${IMAGE:-warsow-race:2.1.2}"
SV_PORT="${SV_PORT:-44400}"
CONTAINER="rs-e2e-server-$$"
EXPECT_MAP="aurora-speed1"      # first alphabetically among the test maps
BOOT_TIMEOUT=120

BUILD=auto
for arg in "$@"; do
    case "$arg" in
        --build)    BUILD=1 ;;
        --no-build) BUILD=0 ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
    esac
done

log() { printf '\n== %s\n' "$*"; }

cleanup() {
    docker logs "${CONTAINER}" > "${LOGFILE:-/dev/null}" 2>&1 || true
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

LOGFILE="$(mktemp)"

# --- image -----------------------------------------------------------------
have_image() { docker image inspect "${IMAGE}" >/dev/null 2>&1; }
if [ "${BUILD}" = "1" ] || { [ "${BUILD}" = "auto" ] && ! have_image; }; then
    log "building ${IMAGE} from ${ROOT}/server (this compiles the engine; slow)"
    docker build -t "${IMAGE}" "${ROOT}/server"
elif [ "${BUILD}" = "0" ] && ! have_image; then
    echo "FATAL: --no-build set but image ${IMAGE} does not exist" >&2
    exit 1
fi

# --- boot ------------------------------------------------------------------
# A single public=0 server, no ingest, map rotation off so it stays on the map
# we assert. The test maps (aurora-speed1/coldrun) are mounted the same way the
# mirror-test stack mounts them, so a real race map boots instead of the "ui"
# menu background (on which the gametype has nothing to race).
log "booting ${CONTAINER} on udp/${SV_PORT}"
docker run -d --name "${CONTAINER}" \
    -p "${SV_PORT}:44400/udp" \
    -v "${ROOT}/server/mirror-test-maps:/warsow/maps_extra:ro" \
    -e SV_HOSTNAME="racesow-e2e" \
    -e SV_PUBLIC=0 \
    -e SV_MAXCLIENTS=8 \
    -e MAP_ROTATION=0 \
    -e G_GAMETYPE=hrace \
    -e LOG_SHIP=0 \
    "${IMAGE}" >/dev/null

# --- wait for the gametype to compile + initialize -------------------------
log "waiting up to ${BOOT_TIMEOUT}s for 'Gametype Race initialized'"
AS_ERR='\([0-9]+, ?[0-9]+\) : ERR :|Failed to load script|uncaught exception|Script compilation failed'
deadline=$(( $(date +%s) + BOOT_TIMEOUT ))
booted=0
while [ "$(date +%s)" -lt "${deadline}" ]; do
    logs="$(docker logs "${CONTAINER}" 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
    if printf '%s' "${logs}" | grep -q "Gametype 'Race' initialized"; then
        booted=1; break
    fi
    if printf '%s' "${logs}" | grep -qE "${AS_ERR}"; then
        echo "FAIL: AngelScript error during boot:" >&2
        printf '%s\n' "${logs}" | grep -E "${AS_ERR}" | head -8 | sed 's/^/   /' >&2
        exit 1
    fi
    if ! docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null | grep -q true; then
        echo "FAIL: container exited before initializing the gametype" >&2
        docker logs "${CONTAINER}" 2>&1 | tail -30 | sed 's/^/   /' >&2
        exit 1
    fi
    sleep 2
done
if [ "${booted}" -ne 1 ]; then
    echo "FAIL: server did not initialize the gametype within ${BOOT_TIMEOUT}s" >&2
    docker logs "${CONTAINER}" 2>&1 | tail -40 | sed 's/^/   /' >&2
    exit 1
fi
echo "   ok: gametype compiled and initialized"

# --- a real client connects ------------------------------------------------
log "connect handshake against 127.0.0.1:${SV_PORT}"
python3 "${HERE}/client_connect_probe.py" 127.0.0.1 "${SV_PORT}" \
    --expect-map "${EXPECT_MAP}"

# --- no AngelScript errors surfaced during the connect either --------------
if docker logs "${CONTAINER}" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -qE "${AS_ERR}"; then
    echo "FAIL: AngelScript error appeared after connect:" >&2
    docker logs "${CONTAINER}" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "${AS_ERR}" | head -8 | sed 's/^/   /' >&2
    exit 1
fi

echo ""
echo "OK: game-server boot + client-connect smoke passed"
