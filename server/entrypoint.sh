#!/bin/sh
# ---------------------------------------------------------------------------
# Warsow 2.1.2 dedicated race server launcher.
#
# All tunables are provided through environment variables (see docker-compose
# .yml / the README). The server is kept alive with a restart loop, mirroring
# the community start.sh so a crash or map-change fault comes straight back up.
# ---------------------------------------------------------------------------
set -eu

WARSOW_DIR="${WARSOW_DIR:-/warsow}"
FS_GAME="${FS_GAME:-racemod}"

# --- Configurable server identity / networking ------------------------------
SV_HOSTNAME="${SV_HOSTNAME:-Dockerized Warsow Race}"
SV_MAXCLIENTS="${SV_MAXCLIENTS:-16}"
SV_PUBLIC="${SV_PUBLIC:-0}"                 # 1 = advertise to master servers
SV_PORT="${SV_PORT:-44400}"
RCON_PASSWORD="${RCON_PASSWORD:-}"
G_GAMETYPE="${G_GAMETYPE:-hrace}"
MAP_ROTATION="${MAP_ROTATION:-2}"           # 0 none, 1 sequential, 2 random
EXTRA_ARGS="${EXTRA_ARGS:-}"

cd "${WARSOW_DIR}"

# --- Expose mounted map packs to the engine ---------------------------------
# Warsow only scans pk3 files that live directly inside a game directory
# (basewsw / the mod dir). Symlink any pk3s from the read-only /warsow/maps_extra
# mount into the mod dir so extra map packs load without rebuilding the image.
MAPS_EXTRA="${WARSOW_DIR}/maps_extra"
if [ -d "${MAPS_EXTRA}" ]; then
    for pk in "${MAPS_EXTRA}"/*.pk3; do
        [ -e "${pk}" ] || continue
        ln -sf "${pk}" "${WARSOW_DIR}/${FS_GAME}/$(basename "${pk}")" 2>/dev/null || true
    done
fi

# --- Discover every installed map -------------------------------------------
# A map is playable if a maps/<name>.bsp exists inside a pk3 in one of the two
# directories the engine actually scans: basewsw and the mod dir.
INSTALLED="$(for dir in "${WARSOW_DIR}/basewsw" "${WARSOW_DIR}/${FS_GAME}"; do
        for pk in "${dir}"/*.pk3; do
            [ -e "${pk}" ] && unzip -Z1 "${pk}" 2>/dev/null
        done
    done | sed -n 's#^maps/\([^/]*\)\.bsp$#\1#p' | sort -u)"

# --- Build the map list from mappool.txt ------------------------------------
# One map name per line; blank lines and '#' comments ignored. Only keep maps
# that are actually installed so the server never rotates onto a missing map.
MAPPOOL_FILE="${WARSOW_DIR}/${FS_GAME}/mappool.txt"
REQUESTED=""
if [ -f "${MAPPOOL_FILE}" ]; then
    REQUESTED="$(grep -vE '^\s*(#|$)' "${MAPPOOL_FILE}" | tr -d '\r' | awk '{print $1}')"
fi

MAPLIST=""
if [ -n "${REQUESTED}" ]; then
    for m in ${REQUESTED}; do
        if echo "${INSTALLED}" | grep -qx "${m}"; then
            MAPLIST="${MAPLIST}${m} "
        else
            echo ">> skipping '${m}' from mappool: not installed"
        fi
    done
fi
# Fall back to every installed map if the pool is empty / none matched.
if [ -z "${MAPLIST}" ]; then
    MAPLIST="$(echo "${INSTALLED}" | tr '\n' ' ')"
fi
MAPLIST="$(echo "${MAPLIST}" | sed 's/  */ /g;s/^ //;s/ $//')"
FIRST_MAP="${MAPLIST%% *}"
: "${FIRST_MAP:=race}"

echo "=============================================================="
echo " Warsow 2.1.2 dedicated race server"
echo "   hostname   : ${SV_HOSTNAME}"
echo "   gametype   : ${G_GAMETYPE}   (fs_game=${FS_GAME})"
echo "   maxclients : ${SV_MAXCLIENTS}   public=${SV_PUBLIC}   port=${SV_PORT}"
echo "   first map  : ${FIRST_MAP}"
echo "   map pool   : ${MAPLIST:-<none found>}"
echo "=============================================================="

# --- Assemble launch arguments ----------------------------------------------
set -- \
    +set fs_basepath "${WARSOW_DIR}" \
    +set fs_usehomedir 0 \
    +set fs_game "${FS_GAME}" \
    +set dedicated 1 \
    +set sv_port "${SV_PORT}" \
    +set sv_hostname "${SV_HOSTNAME}" \
    +set sv_maxclients "${SV_MAXCLIENTS}" \
    +set sv_public "${SV_PUBLIC}" \
    +set g_gametype "${G_GAMETYPE}" \
    +set g_maprotation "${MAP_ROTATION}" \
    +set g_maplist "${MAPLIST}"

[ -n "${RCON_PASSWORD}" ] && set -- "$@" +set rcon_password "${RCON_PASSWORD}"
set -- "$@" +exec configs/server/server.cfg
[ -n "${EXTRA_ARGS}" ] && set -- "$@" ${EXTRA_ARGS}
set -- "$@" +map "${FIRST_MAP}"

# --- Restart loop -----------------------------------------------------------
trap 'echo "Shutting down."; exit 0' INT TERM
while true; do
    echo ">> launching wsw_server.x86_64 $*"
    "${WARSOW_DIR}/wsw_server.x86_64" "$@" || true
    echo ">> server exited, restarting in 5s..."
    sleep 5
done
