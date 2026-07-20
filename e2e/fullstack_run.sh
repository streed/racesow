#!/bin/sh
# ---------------------------------------------------------------------------
# Full-stack end-to-end: website + database + REAL game server, all together.
#
# Brings up e2e/docker-compose.fullstack.yml (postgres + web + warsow-race) and
# asserts the whole chain the mod depends on in production:
#
#   WEB      the site is healthy and renders its homepage.
#   GAME     the game server boots and the hrace gametype initializes.
#   CONNECT  a real client completes the connect handshake to the game server.
#   GAME->WEB  the booted game server reaches the live web over HTTP: its
#            console log shipping lands rows in the web's server_log table
#            (a real network round-trip: engine stdout -> POST /api/ingest/log
#            -> authenticated -> stored). This is the piece run.sh cannot cover,
#            because here the bytes come from an actually-running server.
#
# Usage:
#   sh e2e/fullstack_run.sh            # build what's missing, assert, tear down
#   sh e2e/fullstack_run.sh --no-build # require warsow-race:2.1.2 to exist
#   KEEP=1 sh e2e/fullstack_run.sh     # leave the stack up afterwards
# ---------------------------------------------------------------------------
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
COMPOSE="${HERE}/docker-compose.fullstack.yml"
DC="docker compose -f ${COMPOSE}"

IMAGE="${IMAGE:-warsow-race:2.1.2}"
WEB_PORT="${WEB_PORT:-8080}"
SV_PORT="${SV_PORT:-44400}"
KEEP="${KEEP:-0}"

NO_BUILD=0
for arg in "$@"; do
    case "$arg" in
        --no-build) NO_BUILD=1 ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
    esac
done

FAILED=0
log()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   ok: %s\n' "$*"; }
fail() { printf '   FAIL: %s\n' "$*" >&2; FAILED=1; }

cleanup() {
    if [ "${KEEP}" = "1" ]; then
        printf '\n>> KEEP=1: leaving stack up. Tear down: %s down -v\n' "${DC}"
        return
    fi
    log "tearing down"
    ${DC} down -v -t 5 >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# The game image build is the slow one; build it once here if absent so compose
# doesn't. (web + postgres are cheap and built/pulled by compose up.)
if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
    if [ "${NO_BUILD}" = "1" ]; then
        echo "FATAL: --no-build set but ${IMAGE} does not exist" >&2; exit 1
    fi
    log "building ${IMAGE} (engine compile; slow)"
    docker build -t "${IMAGE}" "${ROOT}/server"
fi

log "bringing up postgres + web + warsow-race"
# Build ONLY the cheap web image here; warsow-race reuses the prebuilt
# ${IMAGE} (a bare `up --build` would rebuild the slow engine image too).
${DC} build web
${DC} up -d

# --- WEB: healthy + homepage -----------------------------------------------
log "web: waiting for /api/health"
i=0
until curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "${i}" -gt 60 ] && { fail "web /api/health never came up"; ${DC} logs web | tail -30; break; }
    sleep 1
done
if curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health" 2>/dev/null | grep -q '"ok":true'; then
    ok "web healthy (/api/health -> ok)"
else
    fail "web /api/health did not report ok"
fi

home="$(curl -fsS "http://127.0.0.1:${WEB_PORT}/" 2>/dev/null || true)"
if printf '%s' "${home}" | grep -qi "<html"; then
    ok "homepage renders ($(printf '%s' "${home}" | wc -c) bytes of HTML)"
else
    fail "homepage did not return HTML"
fi

# --- GAME: boot + gametype ------------------------------------------------
log "game: waiting for 'Gametype Race initialized'"
AS_ERR='\([0-9]+, ?[0-9]+\) : ERR :|Failed to load script|uncaught exception|Script compilation failed'
i=0
booted=0
while [ "${i}" -lt 120 ]; do
    glogs="$(${DC} logs warsow-race 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
    if printf '%s' "${glogs}" | grep -q "Gametype 'Race' initialized"; then booted=1; break; fi
    if printf '%s' "${glogs}" | grep -qE "${AS_ERR}"; then
        fail "AngelScript error during boot"
        printf '%s\n' "${glogs}" | grep -E "${AS_ERR}" | head -6 | sed 's/^/      /' >&2
        break
    fi
    i=$((i + 1)); sleep 2
done
[ "${booted}" = "1" ] && ok "gametype compiled and initialized" \
    || fail "gametype did not initialize in time"

# --- CONNECT: real client handshake ---------------------------------------
if [ "${booted}" = "1" ]; then
    log "connect: real client handshake to 127.0.0.1:${SV_PORT}"
    if python3 "${HERE}/client_connect_probe.py" 127.0.0.1 "${SV_PORT}" \
        --expect-map aurora-speed1; then
        ok "client completed the connect handshake"
    else
        fail "client connect handshake failed"
    fi
fi

# --- GAME -> WEB: console logs shipped over HTTP and stored ----------------
# The booted engine's stdout is shipped to POST /api/ingest/log (LOG_SHIP=1),
# authenticated with the shared token, and stored in server_log. Its presence
# proves a real, authenticated game->web HTTP round-trip from the live server.
log "game->web: waiting for shipped console logs to land in server_log"
if ${DC} logs warsow-race 2>&1 | grep -q "shipping console logs to"; then
    ok "game server started console log shipping"
else
    fail "game server did not start log shipping (INGEST_URL/TOKEN wiring?)"
fi

count=0
i=0
while [ "${i}" -lt 30 ]; do
    count="$(${DC} exec -T postgres psql -U racesow -d racesow -tAc \
        "SELECT count(*) FROM server_log WHERE source='console'" 2>/dev/null | tr -d '[:space:]')"
    case "${count}" in ''|*[!0-9]*) count=0 ;; esac
    [ "${count}" -gt 0 ] && break
    i=$((i + 1)); sleep 2
done
if [ "${count}" -gt 0 ]; then
    ok "web stored ${count} shipped console log line(s) from the game server"
else
    fail "no console logs reached the web server_log table"
    ${DC} logs warsow-race 2>&1 | grep -i "rs_api\|ingest\|curl" | tail -10 | sed 's/^/      /' >&2 || true
fi

echo ""
if [ "${FAILED}" = "0" ]; then
    echo "OK: full-stack end-to-end passed (web + game + connect + game->web ingest)"
else
    echo "FULL-STACK END-TO-END FAILED"
    exit 1
fi
