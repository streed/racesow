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
SV_UPLOADS_BASEURL="${SV_UPLOADS_BASEURL:-}"  # client-reachable HTTP pak mirror (optional)
INGEST_URL="${INGEST_URL:-}"                # central stats /api/ingest; empty = no direct reporting
INGEST_TOKEN="${INGEST_TOKEN:-}"            # per-server bearer token for the ingest endpoint
VERSION_NAME="${VERSION_NAME:-wsw 2.1}"     # game version records file under on the stats site
EXTRA_ARGS="${EXTRA_ARGS:-}"

cd "${WARSOW_DIR}"

# --- Ensure the stats output dirs are writable by the server user -----------
# The racemod writes records to topscores/ and (our fork) per-finish events to
# racelog/events.log under the mod dir. These are bind-mounted from the host;
# if the host pre-created events.log as another user the append silently fails
# (the mod now logs it, but pre-creating here as our uid avoids it entirely).
MOD_DIR="${WARSOW_DIR}/${FS_GAME}"

# Clear any stale extracted game modules. The engine unpacks libgame_x86_64.so
# from modules_racesow_21pure.pk3 into a tempmodules_* dir and reuses it if
# present; wiping it guarantees the current (patched) module is re-extracted
# after an image rebuild or module change.
rm -rf "${MOD_DIR}"/tempmodules_* 2>/dev/null || true

for d in "${MOD_DIR}/racelog" "${MOD_DIR}/topscores/race"; do
    mkdir -p "${d}" 2>/dev/null || true
done
if [ -w "${MOD_DIR}/racelog" ]; then
    touch "${MOD_DIR}/racelog/events.log" 2>/dev/null || true
fi
if [ -e "${MOD_DIR}/racelog/events.log" ] && [ ! -w "${MOD_DIR}/racelog/events.log" ]; then
    echo ">> WARNING: ${MOD_DIR}/racelog/events.log is not writable by $(id -un) (uid $(id -u));" \
         "race finishes will NOT be recorded. Fix host ownership (chown $(id -u) on ./server/racelog)."
fi

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

# --- Export downloadable paks for the optional HTTP pak server ---------------
# When the pakshare volume is mounted (see docker-compose.yml pakserver), copy
# the mod dir's pk3s there (dereferencing map-pack symlinks) so nginx can serve
# them at <SV_UPLOADS_BASEURL>/racemod/<pak>. Called before every server
# (re)launch so pak changes and first-run volume-ownership races self-heal.
export_pakshare() {
    [ -d /pakshare ] || return 0
    mkdir -p /pakshare/racemod 2>/dev/null || true
    for pk in "${MOD_DIR}"/*.pk3; do
        [ -e "${pk}" ] && cp -Lf "${pk}" /pakshare/racemod/ 2>/dev/null || true
    done
}
export_pakshare

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

# The engine executes env.cfg through a 1024-char per-command buffer
# (MAX_STRING_CHARS): a longer `set g_maplist "..."` line gets chopped there,
# corrupting the list and executing the tail as garbage commands. With a big
# map mirror (scripts/fetch-maps.sh) the full installed list runs to tens of
# KB, so cap it at a map-name boundary. Rotation then covers only the maps
# that fit — curate mappool.txt to choose which maps rotate.
MAPLIST_MAX=1000
if [ "${#MAPLIST}" -gt "${MAPLIST_MAX}" ]; then
    installed_count=$(echo "${MAPLIST}" | wc -w)
    MAPLIST="$(echo "${MAPLIST}" | awk -v max="${MAPLIST_MAX}" '{
        out = ""
        for (i = 1; i <= NF; i++) {
            cand = (out == "" ? $i : out " " $i)
            if (length(cand) > max) break
            out = cand
        }
        print out
    }')"
    kept_count=$(echo "${MAPLIST}" | wc -w)
    echo ">> WARNING: ${installed_count} maps installed, but g_maplist only holds ${kept_count}"
    echo ">>          (the engine caps command lines at 1024 chars). Rotation uses the"
    echo ">>          first ${kept_count} alphabetically; set mappool.txt to pick the rotation."
fi

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

# --- Environment-derived cvars ------------------------------------------------
# The engine caps the command line at MAX_NUM_ARGVS words, so everything that
# can wait until config-exec time goes into a generated env.cfg (executed
# after server.cfg so it wins overlaps). Only cvars needed before configs run
# stay on the command line: fs_* (filesystem bootstrap), dedicated, sv_port
# (socket opens during init) and sv_http (latched; the built-in HTTP server
# would start during init — it stays off: pk3 downloads use the patched UDP
# transfer over the game port instead, which needs no extra ports and avoids
# Docker-NAT issues; see the pakserver service for the HTTP alternative).
ENV_CFG="${MOD_DIR}/configs/server/env.cfg"
{
    echo "// generated by entrypoint.sh from the container environment — do not edit"
    echo "set sv_hostname \"${SV_HOSTNAME}\""
    echo "set sv_maxclients \"${SV_MAXCLIENTS}\""
    echo "set sv_public \"${SV_PUBLIC}\""
    echo "set g_gametype \"${G_GAMETYPE}\""
    echo "set g_maprotation \"${MAP_ROTATION}\""
    echo "set g_maplist \"${MAPLIST}\""
    [ -n "${RCON_PASSWORD}" ]      && echo "set rcon_password \"${RCON_PASSWORD}\""
    # HTTP pak mirror: when set, the engine redirects pak downloads there
    # instead of the (patched) UDP transfer. Must be reachable by game clients.
    [ -n "${SV_UPLOADS_BASEURL}" ] && echo "set sv_uploads_baseurl \"${SV_UPLOADS_BASEURL}\""
    # Direct-to-API race reporting: the gametype POSTs every finish to the
    # central stats ingest endpoint (racelog.as -> RS_ApiReportRace native).
    if [ -n "${INGEST_URL}" ]; then
        echo "set rs_api_url \"${INGEST_URL}\""
        echo "set rs_api_version \"${VERSION_NAME}\""
        [ -n "${INGEST_TOKEN}" ] && echo "set rs_api_token \"${INGEST_TOKEN}\""
    fi
} > "${ENV_CFG}"

# --- Assemble launch arguments ------------------------------------------------
set -- \
    +set fs_basepath "${WARSOW_DIR}" \
    +set fs_usehomedir 0 \
    +set fs_game "${FS_GAME}" \
    +set dedicated 1 \
    +set sv_http 0 \
    +set sv_port "${SV_PORT}" \
    +exec configs/server/server.cfg \
    +exec configs/server/env.cfg

[ -n "${EXTRA_ARGS}" ] && set -- "$@" ${EXTRA_ARGS}
set -- "$@" +map "${FIRST_MAP}"

# --- Restart loop -----------------------------------------------------------
trap 'echo "Shutting down."; exit 0' INT TERM
while true; do
    export_pakshare
    echo ">> launching wsw_server.x86_64 $*"
    # Force line-buffered stdout/stderr. In a detached container the engine's
    # stdout is a pipe, so glibc block-buffers it and `docker logs` looks frozen
    # mid-startup. stdbuf keeps output flowing even if no TTY is allocated.
    stdbuf -oL -eL "${WARSOW_DIR}/wsw_server.x86_64" "$@" || true
    echo ">> server exited, restarting in 5s..."
    sleep 5
done
