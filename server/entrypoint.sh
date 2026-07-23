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
# Console log shipping: tee the engine's stdout to the stats site's admin log
# view (POST /api/ingest/log). Needs INGEST_URL + INGEST_TOKEN; LOG_SHIP=0 off.
LOG_SHIP="${LOG_SHIP:-1}"                    # 1 = ship console logs, 0 = disable
LOG_FLUSH_SECS="${LOG_FLUSH_SECS:-5}"       # max seconds a line waits before it is POSTed
LOG_BATCH_LINES="${LOG_BATCH_LINES:-100}"   # or POST early once this many lines have queued
# Cross-server player mirroring (UDP mesh between peered race servers).
MIRROR_PEERS="${MIRROR_PEERS:-}"            # "hostB:44450 hostC:44450"; empty = mirroring off
MIRROR_SECRET="${MIRROR_SECRET:-}"          # shared HMAC key (hex recommended: openssl rand -hex 24);
                                            # empty = source-IP allowlist mode, LAN/testing only.
                                            # Must not contain '"' or ';' (it is emitted into a cfg line).
MIRROR_PORT="${MIRROR_PORT:-44450}"         # local mirror UDP bind port
MIRROR_TAG="${MIRROR_TAG:-}"                # short server id shown as [TAG] in mirrored chat
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
    # -u: with a full map mirror this is ~12 GB of pk3s; only copy what
    # changed so restarts don't redo the whole export every time.
    for pk in "${MOD_DIR}"/*.pk3; do
        [ -e "${pk}" ] && cp -uLf "${pk}" /pakshare/racemod/ 2>/dev/null || true
    done
    # Replay demos: the engine writes per-run WR demos under demos/server/<map>/;
    # mirror them (dropping the "server/" layer) into /pakshare/demos so nginx
    # serves them at <base>/demos/<map>/<file>.wdz20 — the two-segment path the
    # web stores/validates and hrace/demos.as reconstructs.
    if [ -d "${MOD_DIR}/demos/server" ]; then
        mkdir -p /pakshare/demos 2>/dev/null || true
        cp -uLrf "${MOD_DIR}/demos/server/." /pakshare/demos/ 2>/dev/null || true
    fi
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

# --- Drop maps a moderator has blocked (central API) -------------------------
# GET /api/game/blocked-maps returns one lowercased map name per line. Removing
# them from INSTALLED here excludes them from BOTH the curated mappool and the
# fallback below — i.e. from the vote pool and the map cycle. Fail-safe: any
# fetch error (API down, no INGEST_URL) blocks nothing, so a network blip can
# never empty the rotation.
if [ -n "${INGEST_URL}" ]; then
    BLOCKED="$(curl -fsS --max-time 5 "${INGEST_URL%/api/ingest}/api/game/blocked-maps" 2>/dev/null \
        | tr -d '\r' | grep -vE '^\s*(//|$)' | awk '{print tolower($1)}' || true)"
    if [ -n "${BLOCKED}" ]; then
        before=$(echo "${INSTALLED}" | grep -c . || true)
        INSTALLED="$(echo "${INSTALLED}" | grep -vxiF "${BLOCKED}" || true)"
        after=$(echo "${INSTALLED}" | grep -c . || true)
        echo ">> blocked maps excluded from rotation: $((before - after)) (blocklist had $(echo "${BLOCKED}" | grep -c .))"
    fi
fi

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

# --- Mirror mesh sanity checks ------------------------------------------------
# The peers list rides in a single generated cfg line, so it shares the
# engine's 1024-char command buffer hazard with g_maplist above: a chopped
# line corrupts the list and executes the tail as garbage commands. Truncate
# at a host:port boundary long before that.
if [ -n "${MIRROR_PEERS}" ] && [ -z "${MIRROR_TAG}" ]; then
    echo ">> WARNING: MIRROR_PEERS is set but MIRROR_TAG is empty; player mirroring stays OFF."
    MIRROR_PEERS=""
fi

# Each MIRROR_* value is emitted as `set rs_mirror_X "..."` and exec'd by the
# engine. A '"', ';' or newline in a value closes the quoted token early, so
# the tail runs as its own console command (e.g. a stray `quit` bootloops the
# server). Reject those characters outright rather than silently corrupting
# config — a secret in particular must survive verbatim or auth fails on every
# packet with no obvious cause.
if [ -n "${MIRROR_PEERS}" ]; then
    for _mv in TAG PORT PEERS SECRET; do
        eval "_val=\${MIRROR_${_mv}}"
        case "${_val}" in
            *'"'* | *';'* | *'
'*)
                echo ">> ERROR: MIRROR_${_mv} contains a quote, semicolon or newline, which would"
                echo ">>        break the generated env.cfg line. Refusing to start. Use a value"
                echo ">>        without those characters (secrets: openssl rand -hex 24)."
                exit 1
                ;;
        esac
    done
    # A secret/tag longer than the engine's ~1000-char cfg-line budget would be
    # silently chopped — a truncated secret then mismatches every peer with no
    # error. Fail fast (no safe truncate-at-boundary exists for a key).
    if [ "${#MIRROR_SECRET}" -gt 900 ]; then
        echo ">> ERROR: MIRROR_SECRET exceeds the engine's 1024-char cfg-line buffer."
        echo ">>        Use a short key, e.g. openssl rand -hex 24."
        exit 1
    fi
    if [ "${#MIRROR_TAG}" -gt 16 ]; then
        echo ">> ERROR: MIRROR_TAG '${MIRROR_TAG}' is too long (max 16 chars)."
        exit 1
    fi
    # Source-IP allowlist mode (no shared secret) trusts any packet from a
    # peer's IP; UDP sources are spoofable, so this is LAN/testing only. Warn
    # loudly so it can't silently ship to internet-facing peers.
    if [ -z "${MIRROR_SECRET}" ]; then
        echo ">> WARNING: MIRROR_PEERS is set but MIRROR_SECRET is empty."
        echo ">>          Mirroring will run in source-IP allowlist mode (no authentication)."
        echo ">>          This is safe only on a trusted/LAN network. Set MIRROR_SECRET"
        echo ">>          (shared across all peers) for any internet-facing deployment."
    fi
fi

MIRROR_PEERS_MAX=950
if [ "${#MIRROR_PEERS}" -gt "${MIRROR_PEERS_MAX}" ]; then
    full_count=$(echo "${MIRROR_PEERS}" | wc -w)
    MIRROR_PEERS="$(echo "${MIRROR_PEERS}" | awk -v max="${MIRROR_PEERS_MAX}" '{
        out = ""
        for (i = 1; i <= NF; i++) {
            cand = (out == "" ? $i : out " " $i)
            if (length(cand) > max) break
            out = cand
        }
        print out
    }')"
    kept_count=$(echo "${MIRROR_PEERS}" | wc -w)
    echo ">> WARNING: MIRROR_PEERS lists ${full_count} peers but only ${kept_count} fit the"
    echo ">>          engine's 1024-char cfg-line buffer; the rest are dropped."
fi

echo "=============================================================="
echo " Warsow 2.1.2 dedicated race server"
echo "   hostname   : ${SV_HOSTNAME}"
echo "   gametype   : ${G_GAMETYPE}   (fs_game=${FS_GAME})"
echo "   maxclients : ${SV_MAXCLIENTS}   public=${SV_PUBLIC}   port=${SV_PORT}"
echo "   first map  : ${FIRST_MAP}"
echo "   map pool   : ${MAPLIST:-<none found>}"
if [ -n "${MIRROR_PEERS}" ]; then
    echo "   mirror     : tag=${MIRROR_TAG} port=${MIRROR_PORT} peers=${MIRROR_PEERS}"
fi
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
    # Pin the demo output dir so the WR-demo path the mod reconstructs
    # (hrace/demos.as RACE_DemoRelPath) matches what the engine writes:
    # SV_DEMO_DIR resolves to "demos/server" when sv_demodir is empty.
    echo "set sv_demodir \"\""
    # Direct-to-API race reporting: the gametype POSTs every finish to the
    # central stats ingest endpoint (racelog.as -> RS_ApiReportRace native).
    if [ -n "${INGEST_URL}" ]; then
        echo "set rs_api_url \"${INGEST_URL}\""
        echo "set rs_api_version \"${VERSION_NAME}\""
        [ -n "${INGEST_TOKEN}" ] && echo "set rs_api_token \"${INGEST_TOKEN}\""
        # Live top-scores queries hit the same API host (hrace/apitop.as):
        # in-game `top`, HUD record lines and record announcements then track
        # the central database, not just this server's local files.
        echo "set rs_api_top_url \"${INGEST_URL%/api/ingest}/api/game/topscores\""
        # Replay feature: WR ghost upload (browser viewer) + the in-game WR
        # ghost racer's fetch (hrace/demos.as + hrace/ghostbot.as). Same host.
        echo "set rs_api_ghost_url \"${INGEST_URL%/api/ingest}/api/ingest/ghost\""
        echo "set rs_wr_ghost_url \"${INGEST_URL%/api/ingest}/api/game/ghost\""
        # In-game /flag command target (hrace/commands.as Cmd_Flag). Same host.
        echo "set rs_api_flag_url \"${INGEST_URL%/api/ingest}/api/game/flag\""
        # Live map blocklist (hrace/blockedmaps.as): the gametype polls this
        # every ~30s so a map blocked in the web admin leaves the vote pool
        # without a restart. Same list the g_maplist build above already drops.
        echo "set rs_api_blocked_url \"${INGEST_URL%/api/ingest}/api/game/blocked-maps\""
        # Live MOTD (hrace/motd.as): the gametype polls this every ~60s and
        # feeds sv_MOTDString, so the message admins edit at /admin/motd shows
        # to connecting players without a restart. Until the first successful
        # fetch the server.cfg default applies.
        echo "set rs_api_motd_url \"${INGEST_URL%/api/ingest}/api/game/motd\""
        # Live per-map global ranks (hrace/ranks.as): the gametype polls this
        # every ~60s and shows each connected player's true rank in the
        # scoreboard "Pos" column - including players ranked past the local
        # top-50 board. Empty url = no-op (scoreboard falls back to the local
        # top-50 board position).
        echo "set rs_api_ranks_url \"${INGEST_URL%/api/ingest}/api/game/ranks\""
    fi
    # Cross-server player mirroring: the gametype reads these and drives the
    # RS_Mirror* natives (hrace/mirror.as). Empty peers = feature off.
    if [ -n "${MIRROR_PEERS}" ]; then
        echo "set rs_mirror_tag \"${MIRROR_TAG}\""
        echo "set rs_mirror_port \"${MIRROR_PORT}\""
        echo "set rs_mirror_peers \"${MIRROR_PEERS}\""
        [ -n "${MIRROR_SECRET}" ] && echo "set rs_mirror_secret \"${MIRROR_SECRET}\""
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

# --- Console log shipping (optional) ----------------------------------------
# When enabled, the engine's stdout/stderr is redirected into a FIFO that a
# background drainer echoes back to OUR stdout (so `docker logs` is unchanged)
# and batches to POST /api/ingest/log. The engine still launches as its own PID
# ($server_pid via a plain `>` redirect, NOT a pipeline), so the TERM trap +
# restart-loop `wait` keep targeting the engine directly.
#
# SAFETY: log shipping must never be able to stall or wedge the game server.
# Two properties guarantee that:
#  1. The parent holds the FIFO open read-write on fd 9 for the whole container
#     lifetime (O_RDWR on a FIFO never blocks on Linux). So a reader is ALWAYS
#     present — the engine's `> FIFO` open never blocks and its writes never get
#     EPIPE, even if the drainer momentarily isn't running — and a writer is
#     always present, so the drainer never sees EOF between engine restarts.
#  2. The HTTP POST is detached (backgrounded), so a slow/hung ingest endpoint
#     can never back-pressure the read loop and fill the pipe behind the engine.
# The drainer is also supervised (respawned) so draining always resumes.
LOG_INGEST_URL=""
CONSOLE_FIFO=""
SHIPPER_PID=""
HEARTBEAT_PID=""
# US = 0x1f: a control-char sentinel the heartbeat injects to force a periodic
# flush (portable time-based flush without dash-unsupported `read -t`).
SENTINEL="$(printf '\037')"
_ship_buf=""
_ship_n=0
_ship_flush() {
    [ "${_ship_n}" -gt 0 ] || return 0
    # Detach the POST so the read loop keeps draining the FIFO while curl runs
    # (a synchronous curl could fill the pipe and stall the engine). curl bounds
    # itself with --max-time; failures are ignored (best-effort logs).
    printf '%s' "${_ship_buf}" | (
        curl -fsS --max-time 6 -X POST \
            -H "Authorization: Bearer ${INGEST_TOKEN}" \
            -H "Content-Type: text/plain" \
            --data-binary @- "${LOG_INGEST_URL}" >/dev/null 2>&1 || true
    ) &
    _ship_buf=""
    _ship_n=0
}
log_shipper() {
    while IFS= read -r _line; do
        if [ "${_line}" = "${SENTINEL}" ]; then
            _ship_flush
            continue
        fi
        printf '%s\n' "${_line}"            # keep docker logs intact
        _ship_buf="${_ship_buf}${_line}
"
        _ship_n=$((_ship_n + 1))
        [ "${_ship_n}" -ge "${LOG_BATCH_LINES}" ] && _ship_flush
    done
    _ship_flush                              # drain if the read fd ever closes
}

if [ "${LOG_SHIP}" != "0" ] && [ -n "${INGEST_URL}" ] && [ -n "${INGEST_TOKEN}" ]; then
    LOG_INGEST_URL="${INGEST_URL%/api/ingest}/api/ingest/log"
    CONSOLE_FIFO="$(mktemp -u "${TMPDIR:-/tmp}/wsw-console.XXXXXX")"
    if mkfifo "${CONSOLE_FIFO}" 2>/dev/null; then
        echo ">> shipping console logs to ${LOG_INGEST_URL}"
        # Hold BOTH ends open for the whole lifetime (see SAFETY above).
        exec 9<> "${CONSOLE_FIFO}"
        # Supervised drainer: reads via the inherited fd 9, respawned if it ever
        # dies so draining (and thus the engine's back-pressure relief) resumes.
        ( while true; do log_shipper <&9; sleep 1; done ) &
        SHIPPER_PID=$!
        # Periodic flush: inject the sentinel every LOG_FLUSH_SECS so a quiet
        # server still ships its last lines promptly.
        ( while true; do sleep "${LOG_FLUSH_SECS}"; printf '%s\n' "${SENTINEL}" >&9 2>/dev/null || exit 0; done ) &
        HEARTBEAT_PID=$!
    else
        echo ">> WARNING: could not create console FIFO; log shipping disabled" >&2
        CONSOLE_FIFO=""
    fi
fi

# --- Restart loop -----------------------------------------------------------
# The engine runs as a background child with its PID recorded so the TERM
# trap can FORWARD the signal: this script is PID 1, and without forwarding,
# `docker stop` would TERM only the shell — the engine never shuts down
# cleanly (no final topscores write, no rs_api queue drain) and gets
# SIGKILLed when the grace period expires.
server_pid=""
shutdown() {
    echo "Shutting down."
    if [ -n "${server_pid}" ]; then
        kill -TERM "${server_pid}" 2>/dev/null || true
        wait "${server_pid}" 2>/dev/null || true
    fi
    # Stop log shipping WITHOUT blocking the container's stop grace: just kill
    # the heartbeat + drainer and exit. Any in-flight POST is a detached curl
    # bounded by --max-time; the last partial batch may be dropped (best-effort
    # logs). We deliberately do NOT `wait` here — the heartbeat's `sleep`
    # grandchild keeps a copy of fd 9, so waiting for the drainer to reach EOF
    # could hang up to LOG_FLUSH_SECS and blow past the 10s stop grace.
    [ -n "${HEARTBEAT_PID}" ] && kill "${HEARTBEAT_PID}" 2>/dev/null || true
    [ -n "${SHIPPER_PID}" ] && kill "${SHIPPER_PID}" 2>/dev/null || true
    exit 0
}
trap shutdown INT TERM
while true; do
    export_pakshare
    echo ">> launching wsw_server.x86_64 $*"
    # Force line-buffered stdout/stderr. In a detached container the engine's
    # stdout is a pipe, so glibc block-buffers it and `docker logs` looks frozen
    # mid-startup. stdbuf keeps output flowing even if no TTY is allocated.
    # With shipping on, redirect stdout+stderr into the FIFO (a plain `>` so $!
    # is still the engine); the background shipper echoes it back to docker logs.
    if [ -n "${CONSOLE_FIFO}" ]; then
        stdbuf -oL -eL "${WARSOW_DIR}/wsw_server.x86_64" "$@" > "${CONSOLE_FIFO}" 2>&1 &
    else
        stdbuf -oL -eL "${WARSOW_DIR}/wsw_server.x86_64" "$@" &
    fi
    server_pid=$!
    wait "${server_pid}" || true
    server_pid=""
    echo ">> server exited, restarting in 5s..."
    sleep 5
done
