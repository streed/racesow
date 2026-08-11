#!/usr/bin/env bash
#
# Racesow Warfork server entrypoint. Mirrors the essential env->cvar wiring of
# ../server/entrypoint.sh (the Warsow one) so the SAME racemod gametype reports
# to the SAME stats API and joins the SAME cross-server mesh:
#   - INGEST_URL/INGEST_TOKEN/VERSION_NAME  -> rs_api_* (finish reporting, tagged)
#   - MIRROR_*                              -> rs_mirror_* (cross-game mesh)
# then launches wf_server on the `racesow` fs_game.
set -euo pipefail

WF_DIR=${WF_DIR:-/warfork}
FS_GAME=${FS_GAME:-racesow}
MOD_DIR="${WF_DIR}/${FS_GAME}"

# Bad-map crash recovery, shared verbatim with the Warsow tier
# (server/crashguard.sh). This tier needs it most: Warfork still runs upstream's
# fatal GClip_SetBrushModel, so an unloadable map in the ~4,250-pk3 mirror takes
# the server down where Warsow shrugs it off. Sourced before the console tap and
# the supervise loop, both of which call into it.
CRASHGUARD_SH="${CRASHGUARD_SH:-$(dirname "$0")/crashguard.sh}"
if [ -r "${CRASHGUARD_SH}" ]; then
    # shellcheck disable=SC1090
    . "${CRASHGUARD_SH}"
else
    echo ">> WARNING: ${CRASHGUARD_SH} not found; bad-map crash recovery is OFF" >&2
    CG_ENABLED=0
    cg_init()      { :; }
    cg_scan_line() { :; }
    cg_arm()       { :; }
    cg_verdict()   { :; }
    cg_sleep()     { sleep 5; }
    cg_pick_map()  { printf '%s' "$1"; }
fi

# The shared RS_Api* natives (server/enginepatches/g_rs_api.cpp) build their libc
# write paths from $WARSOW_DIR: the live top-scores cache the gametype re-reads
# for `top`, and the undelivered-report spool. That module is shared with the
# Warsow image (base = $WARSOW_DIR); on Warfork the engine base is $WF_DIR, so
# WARSOW_DIR must point at it or the native writes to a dead /warsow/... path the
# engine never reads back (breaks `top` and the live cross-server record refresh).
export WARSOW_DIR="${WF_DIR}"

SV_HOSTNAME=${SV_HOSTNAME:-Racesow Warfork}
SV_MAXCLIENTS=${SV_MAXCLIENTS:-16}
SV_PUBLIC=${SV_PUBLIC:-1}
SV_PORT=${SV_PORT:-44410}
SV_HTTP_PORT=${SV_HTTP_PORT:-44411}
G_GAMETYPE=${G_GAMETYPE:-hrace}          # our racemod gametype (hrace.gt), not stock `race`
MAP=${MAP:-wfrace1}                       # TODO: g_maplist rotation over the shared pool
RCON_PASSWORD=${RCON_PASSWORD:-}
INGEST_URL=${INGEST_URL:-}
INGEST_TOKEN=${INGEST_TOKEN:-}
VERSION_NAME=${VERSION_NAME:-wf 2.16}     # leaderboard tag; MUST be a wf tag or finishes mislabel as wsw
SV_UPLOADS_BASEURL=${SV_UPLOADS_BASEURL:-}
MIRROR_PEERS=${MIRROR_PEERS:-}
MIRROR_SECRET=${MIRROR_SECRET:-}
MIRROR_PORT=${MIRROR_PORT:-44451}
MIRROR_TAG=${MIRROR_TAG:-}
# In-game server hopping (hrace/serverhop.as): shared server list + this box's
# game (auto-derived from the -ws / -wf MIRROR_TAG suffix, so no per-box config).
HOP_SERVERS="${HOP_SERVERS:-eu-ws;Racesow EU Warsow;warsow;eu.frankfurt.racesow.org:44400|us-ws;Racesow US Warsow;warsow;us.east.racesow.org:44400|eu-wf;Racesow EU Warfork;warfork;eu.frankfurt.racesow.org:44410|us-wf;Racesow US Warfork;warfork;us.east.racesow.org:44410}"
HOP_GAME="${HOP_GAME:-}"
if [ -z "${HOP_GAME}" ]; then
    case "${MIRROR_TAG}" in
        *-wf) HOP_GAME="warfork" ;;
        *-ws) HOP_GAME="warsow" ;;
    esac
fi
MAP_ROTATION=${MAP_ROTATION:-2}
EXTRA_ARGS=${EXTRA_ARGS:-}

# --- Shared map pool ---------------------------------------------------------
# The engine only scans pk3s that live directly inside a game dir (basewf / the
# mod dir), so symlink the read-only shared pool (the SAME ./server/maps the
# Warsow server uses, mounted at ${WF_DIR}/maps_extra) into the racesow fs_game
# dir. Zero-copy: no duplicate storage. Warfork loads both IBSP + FBSP Warsow
# map pk3s (verified). sv_pure 0 (server.cfg) so loose/symlinked paks load.
MAPS_EXTRA="${WF_DIR}/maps_extra"
if [ -d "${MAPS_EXTRA}" ]; then
    n=0
    for pk in "${MAPS_EXTRA}"/*.pk3; do
        [ -e "${pk}" ] || continue
        ln -sf "${pk}" "${MOD_DIR}/$(basename "${pk}")" 2>/dev/null && n=$((n+1)) || true
    done
    echo ">> shared map pool: linked ${n} pk3s from ${MAPS_EXTRA}"
fi

# --- Discover installed maps + build the rotation ----------------------------
# A map is playable if maps/<name>.bsp exists in a pk3 in a scanned dir.
INSTALLED="$(for dir in "${WF_DIR}/basewf" "${MOD_DIR}"; do
        for pk in "${dir}"/*.pk3; do
            [ -e "${pk}" ] && unzip -Z1 "${pk}" 2>/dev/null
        done
    done | sed -n 's#^maps/\([^/]*\)\.bsp$#\1#p' | sort -u)"
# Drop maps a moderator has blocked (same central list as the Warsow servers).
# Fail-safe: any fetch error blocks nothing, so a blip never empties rotation.
if [ -n "${INGEST_URL}" ]; then
    BLOCKED="$(curl -fsS --max-time 5 "${INGEST_URL%/api/ingest}/api/game/blocked-maps" 2>/dev/null \
        | tr -d '\r' | grep -vE '^\s*(//|$)' | awk '{print tolower($1)}' || true)"
    [ -n "${BLOCKED}" ] && INSTALLED="$(echo "${INSTALLED}" | grep -vxiF "${BLOCKED}" || true)"
fi
# Curated rotation from mappool.txt — the SAME file the Warsow servers use
# (server/configs/mappool.txt, baked into the image), so the map cycle is
# consistent across both games. One map per line; '#'/blank ignored; only keep
# maps actually installed. Fall back to every installed map if none match.
MAPPOOL_FILE="${MOD_DIR}/mappool.txt"
REQUESTED=""
[ -f "${MAPPOOL_FILE}" ] && REQUESTED="$(grep -vE '^\s*(#|$)' "${MAPPOOL_FILE}" | tr -d '\r' | awk '{print $1}')"
MAPLIST=""
if [ -n "${REQUESTED}" ]; then
    for m in ${REQUESTED}; do
        echo "${INSTALLED}" | grep -qx "${m}" && MAPLIST="${MAPLIST}${m} " || echo ">> mappool: skipping '${m}' (not installed)"
    done
fi
[ -z "${MAPLIST}" ] && MAPLIST="$(echo "${INSTALLED}" | tr '\n' ' ')"
MAPLIST="$(echo "${MAPLIST}" | sed 's/  */ /g;s/^ //;s/ $//')"
# Cap at the engine's 1024-char command-buffer boundary (see design/memory:
# a chopped `set g_maplist` line runs its tail as garbage commands).
if [ "${#MAPLIST}" -gt 1000 ]; then
    MAPLIST="$(echo "${MAPLIST}" | awk '{out="";for(i=1;i<=NF;i++){c=(out==""?$i:out" "$i);if(length(c)>1000)break;out=c}print out}')"
    echo ">> NOTE: g_maplist capped to fit the engine command buffer (curate a mappool for a chosen rotation)"
fi
# Prefer a real installed map to spawn on; fall back to the MAP env default.
[ -n "${MAPLIST%% *}" ] && FIRST_MAP="${MAPLIST%% *}" || FIRST_MAP="${MAP}"
# The engine's last-resort map (sv_defaultmap), read by SV_CheckDefaultMap when
# the server is dead with no map. It MUST differ from the boot map: the only
# moment it is consulted is when the boot map failed to come up, so aiming it at
# FIRST_MAP makes the fallback retry the map that just died and the server never
# recovers. Verified on the Warsow image: sv_defaultmap=FIRST_MAP turned a
# recoverable bad boot map into a server that never spawned a level.
# Second pool entry; empty when the pool is too short, in which case we emit
# nothing and the engine keeps its compiled default (wfdm1).
FALLBACK_MAP="${MAPLIST#* }"
FALLBACK_MAP="${FALLBACK_MAP%% *}"
[ "${FALLBACK_MAP}" = "${MAPLIST}" ] && FALLBACK_MAP=""

# --- generated, env-driven config (exec'd LAST so it wins over default.cfg) ----
# configs/server holds the generated env.cfg; topscores/race, racelog and demos
# must exist before launch because the RS_Api* native writes into them with plain
# libc (it does NOT mkdir), and a missing topscores/race/ makes the first live
# top-scores fetch fail — `top` stays empty until a local finish creates it.
mkdir -p "${MOD_DIR}/configs/server" "${MOD_DIR}/topscores/race" "${MOD_DIR}/racelog" "${MOD_DIR}/demos"
ENV_CFG="${MOD_DIR}/configs/server/env.cfg"
{
    echo "// generated by entrypoint.sh from the container environment - do not edit"
    echo "set sv_hostname \"${SV_HOSTNAME}\""
    echo "set sv_maxclients \"${SV_MAXCLIENTS}\""
    echo "set sv_public \"${SV_PUBLIC}\""
    echo "set g_gametype \"${G_GAMETYPE}\""
    echo "set g_maprotation \"${MAP_ROTATION}\""
    [ -n "${MAPLIST}" ]            && echo "set g_maplist \"${MAPLIST}\""
    # Idle map rotation (hrace/maprotate.as) reads this private copy of the
    # rotation list rather than g_maplist — an AngelScript Cvar handle on that
    # engine-owned cvar would re-register it with an empty default and wipe it.
    #
    # This line is NOT optional on Warfork. RACE_PickIdleMap fails open when the
    # cvar is empty: it falls back to GetMapsByFilter, i.e. EVERY installed map.
    # Warfork mounts the whole ~4,250-pk3 mirror, and a chunk of those maps are
    # unloadable on this engine — rotating onto one raises
    # "GClip_SetBrushModel: NULL model in 'trigger_multiple'", which reaches
    # Com_Error(ERR_DROP) -> SV_ShutdownGame: the game module is unloaded, every
    # client dropped, and the UDP socket CLOSED (NET_CloseSocket, sv_init.c).
    # The process itself keeps running -- SV_Frame then early-returns past its
    # only NET_Sleep, so it spins one core at 100% answering nothing. The
    # container never exits, so nothing restarts it. That wedged EU Warfork on
    # 2026-08-06 and again on 2026-08-08 (38h), and US Warfork on 2026-08-09
    # (12h, on aryshok_mew).
    #
    # Warsow is immune to this PARTICULAR map defect at the ENGINE level, not
    # because of this cvar: racemod_2.1 already patched that call site to print,
    # unlink and return instead of G_Error (see wsw game/g_clip.cpp). Warfork
    # still runs upstream's fatal version, which is why all three wedges were
    # Warfork. Confining rotation to the vetted mappool (below) reduces the
    # exposure; it does not remove it.
    [ -n "${MAPLIST}" ]            && echo "set rs_idle_pool \"${MAPLIST}\""
    # Arm the engine's own map-load recovery on a RACE map. SV_Frame's
    # `!svs.initialized` branch calls SV_CheckDefaultMap() -> `map
    # $sv_defaultmap`, which is exactly the state the teardown above leaves
    # behind. It ships enabled, but sv_defaultmap defaults to the stock DM map
    # wfdm1 and nothing ever set it, so the one free recovery a race server gets
    # dumped everyone onto deathmatch — which is why a mysterious
    # `SpawnServer: wfdm1` shows up in the logs before a wedge.
    # FALLBACK_MAP (computed above) is the SECOND pool entry, never the boot map.
    # NOTE it is a ONE-SHOT -- svc.autostarted latches and SV_ShutdownGame
    # memsets svs, not svc -- so the SECOND failed load in one process still
    # wedges; crashguard.sh + gamehealth.sh cover that.
    [ -n "${FALLBACK_MAP}" ]       && echo "set sv_defaultmap \"${FALLBACK_MAP}\""
    [ -n "${RCON_PASSWORD}" ]      && echo "set rcon_password \"${RCON_PASSWORD}\""
    [ -n "${SV_UPLOADS_BASEURL}" ] && echo "set sv_uploads_baseurl \"${SV_UPLOADS_BASEURL}\""
    echo "set sv_demodir \"\""
    # Per-client demo capture does not exist on Warfork: its Client type has no
    # demoStart/demoStop/demoCancel, so warfork/scriptpatches/patch-scripts-as2024.py
    # stubs those 6 call sites out. With capture stubbed, reporting a demo
    # POINTER would register a download link for a file that is never written —
    # every Warfork PB used to mint a permanent 404 on the site. rs_record_demos
    # gates BOTH the capture calls and RACE_ReportWrDemo (hrace/player.as), so
    # turning it off here is exactly "no demos on Warfork". Ghost replays are
    # independent (RS_Ghost* natives) and stay on. Flip this back to 1 when the
    # 3 Client demo natives get registered in the Warfork game module.
    echo "set rs_record_demos \"0\""
    if [ -n "${INGEST_URL}" ]; then
        base="${INGEST_URL%/api/ingest}"
        echo "set rs_api_url \"${INGEST_URL}\""
        echo "set rs_api_version \"${VERSION_NAME}\""
        [ -n "${INGEST_TOKEN}" ] && echo "set rs_api_token \"${INGEST_TOKEN}\""
        echo "set rs_api_top_url \"${base}/api/game/topscores\""
        echo "set rs_api_ghost_url \"${base}/api/ingest/ghost\""
        echo "set rs_wr_ghost_url \"${base}/api/game/ghost\""
        echo "set rs_api_flag_url \"${base}/api/game/flag\""
        echo "set rs_api_blocked_url \"${base}/api/game/blocked-maps\""
        echo "set rs_api_mapweapons_url \"${base}/api/game/map-weapons\""
        echo "set rs_api_motd_url \"${base}/api/game/motd\""
        echo "set rs_api_announce_url \"${base}/api/game/announcements\""
        echo "set rs_api_ranks_url \"${base}/api/game/ranks\""
        echo "set rs_api_player_record_url \"${base}/api/game/player-record\""
        echo "set rs_api_savedstart_get_url \"${base}/api/game/saved-start\""
        echo "set rs_api_savedstart_post_url \"${base}/api/ingest/saved-start\""
        echo "set rs_api_lastmaps_url \"${base}/api/game/last-maps\""
        echo "set rs_api_awards_url \"${base}/api/game/awards\""
        # Tournaments (hrace/tournament.as): the shared calendar feed the
        # gametype polls, and the server-token-authed POST a player's
        # "/tournament <code>" redeems through. Empty = feature off in-game.
        # A LIVE tournament is announced in-game on join, on start, and every
        # rs_tourney_announce_interval seconds (default 600, archived).
        echo "set rs_api_tourney_url \"${base}/api/game/tournament\""
        echo "set rs_api_tourney_join_url \"${base}/api/game/tournament/join\""
    fi
    # Cross-server (cross-GAME) player mesh. Empty peers/tag = off. Uses the same
    # RS_Mirror* natives + wire protocol as the Warsow servers, so a Warfork node
    # meshes with them directly (see docs/warfork-port-design.md §11).
    if [ -n "${MIRROR_PEERS}" ] && [ -n "${MIRROR_TAG}" ]; then
        echo "set rs_mirror_tag \"${MIRROR_TAG}\""
        echo "set rs_mirror_port \"${MIRROR_PORT}\""
        echo "set rs_mirror_peers \"${MIRROR_PEERS}\""
        [ -n "${MIRROR_SECRET}" ] && echo "set rs_mirror_secret \"${MIRROR_SECRET}\""
    elif [ -n "${MIRROR_PEERS}" ]; then
        echo ">> WARNING: MIRROR_PEERS set but MIRROR_TAG empty; mesh stays OFF." >&2
    fi
    # In-game server hopping (/servers, /hop) - hrace/serverhop.as.
    if [ -n "${HOP_SERVERS}" ] && [ -n "${HOP_GAME}" ]; then
        echo "set rs_hop_servers \"${HOP_SERVERS}\""
        echo "set rs_hop_game \"${HOP_GAME}\""
    fi
} > "${ENV_CFG}"

echo ">> ${SV_HOSTNAME}: gametype=${G_GAMETYPE} port=${SV_PORT} mirror=${MIRROR_TAG:-off} version=\"${VERSION_NAME}\""

# --- launch (sv_port6 must be set independently; env.cfg exec'd last) ----------
set -- \
    +set fs_basepath "${WF_DIR}" \
    +set fs_usehomedir 0 \
    +set fs_game "${FS_GAME}" \
    +set dedicated 1 \
    +set sv_port "${SV_PORT}" \
    +set sv_port6 "${SV_PORT}" \
    +set sv_http 1 \
    +set sv_http_port "${SV_HTTP_PORT}" \
    +exec configs/server/server.cfg \
    +exec configs/server/env.cfg
# NOTE: `+map` is deliberately NOT baked into "$@". It is appended per launch
# inside the supervise loop so the boot map can change between relaunches — a
# fixed +map above the loop is what turns one bad boot map into an unbreakable
# 5-second bootloop. EXTRA_ARGS still lands after it, so WF_EXTRA_ARGS keeps
# working as the operator override.
[ -n "${EXTRA_ARGS}" ] && set -- "$@" ${EXTRA_ARGS}

# --- console tap --------------------------------------------------------------
# The crash guard attributes a failed load to a map by reading the engine's own
# `SpawnServer: <map>` line, so the console has to pass through this shell. This
# tier has never had a console FIFO (docker-compose.warfork.yml sets LOG_SHIP,
# but nothing here consumes it — log SHIPPING is still not implemented on
# Warfork), so this is the minimal version: echo every line straight back out so
# `docker logs` is unchanged, and hand it to the tap.
#
# Three safety properties, ported deliberately from server/entrypoint.sh rather
# than reinvented:
#  1. fd 9 is held O_RDWR for the whole container lifetime. On Linux that never
#     blocks, so a reader is ALWAYS present: the engine's `> FIFO` open cannot
#     block and its writes cannot EPIPE, even between engine restarts.
#  2. The drainer is respawned if it ever dies, so draining always resumes —
#     a full pipe would back-pressure and stall the engine.
#  3. The read loop uses builtins only. It never forks, so it never reaps, and
#     a fork per line would leak a zombie per line.
CONSOLE_FIFO=""
DRAINER_PID=""
console_drainer() {
    while IFS= read -r _line; do
        printf '%s\n' "${_line}"
        cg_scan_line "${_line}"
    done
}
if [ "${CG_ENABLED}" = "1" ]; then
    CONSOLE_FIFO="$(mktemp -u "${TMPDIR:-/tmp}/wf-console.XXXXXX")"
    if mkfifo "${CONSOLE_FIFO}" 2>/dev/null; then
        exec 9<> "${CONSOLE_FIFO}"
        ( while true; do console_drainer <&9; sleep 1; done ) &
        DRAINER_PID=$!
        echo ">> console tap active for the crash guard"
    else
        echo ">> WARNING: could not create the console FIFO; map attribution is OFF" >&2
        CONSOLE_FIFO=""
    fi
fi

# --- supervise loop -----------------------------------------------------------
# The engine deliberately runs as a background CHILD rather than via `exec`.
# Two things depend on it not being PID 1:
#
#  1. gamehealth.sh (the Docker healthcheck) restarts a wedged engine by
#     signalling it. The kernel discards in-namespace signals to PID 1 unless
#     PID 1 installed a handler, so `kill -9 1` from inside the container
#     reports success and does nothing — verified against this very image.
#  2. A crash then costs ~5s here instead of a full container recreate, matching
#     the Warsow tier (server/entrypoint.sh) so both games behave the same and
#     the admin panel's restart copy is true of either.
#
# The TERM trap forwards the signal so `docker stop` still shuts the engine down
# cleanly (final topscores write, rs_api queue drain) instead of letting it be
# SIGKILLed when the stop grace expires.
ENGINE_PIDFILE="${ENGINE_PIDFILE:-/tmp/engine.pid}"
server_pid=""
shutdown() {
    echo "Shutting down."
    rm -f "${ENGINE_PIDFILE}" 2>/dev/null || true
    if [ -n "${server_pid}" ]; then
        kill -TERM "${server_pid}" 2>/dev/null || true
        wait "${server_pid}" 2>/dev/null || true
    fi
    [ -n "${DRAINER_PID}" ] && kill "${DRAINER_PID}" 2>/dev/null || true
    exit 0
}
trap shutdown INT TERM

cg_init

while true; do
    # Recomputed EVERY iteration: skips maps this box has already watched the
    # engine die on, and re-fetches the central blocklist so a map another node
    # quarantined never becomes this node's boot map.
    boot_map="$(cg_pick_map "${FIRST_MAP}")"
    cg_arm "${boot_map}"
    launched_at="$(date +%s)"
    echo ">> launching wf_server.x86_64 $* +map ${boot_map}"
    # Line-buffer so `docker logs` isn't frozen mid-startup by glibc pipe buffering.
    # With the tap up, stdout+stderr go through the FIFO (a plain `>` redirect, so
    # $! is still the ENGINE — the TERM trap and `wait` must target it directly).
    if [ -n "${CONSOLE_FIFO}" ]; then
        stdbuf -oL -eL "${WF_DIR}/wf_server.x86_64" "$@" +map "${boot_map}" > "${CONSOLE_FIFO}" 2>&1 &
    else
        stdbuf -oL -eL "${WF_DIR}/wf_server.x86_64" "$@" +map "${boot_map}" &
    fi
    server_pid=$!
    echo "${server_pid}" > "${ENGINE_PIDFILE}" 2>/dev/null || true
    # Capture the status rather than discarding it; `|| status=$?` is required
    # under `set -e`, where a bare failing `wait` would abort the script.
    status=0
    wait "${server_pid}" || status=$?
    server_pid=""
    rm -f "${ENGINE_PIDFILE}" 2>/dev/null || true
    ran=$(( $(date +%s) - launched_at ))
    echo ">> server exited (status ${status}) after ${ran}s"
    cg_verdict "${status}" "${ran}"
    cg_sleep
done
