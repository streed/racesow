#!/usr/bin/env bash
# gamehealth.sh — Docker HEALTHCHECK + watchdog for the race game servers.
#
# WHY THIS EXISTS. `restart: unless-stopped` only reacts to the container's main
# process EXITING. The engine has a failure mode where it does neither: a fatal
# game error (e.g. a map whose brush models won't load ->
# "GClip_SetBrushModel: NULL model in 'trigger_multiple'") tears down the game
# module, and the process then spins at 100% CPU servicing nothing. The port
# stops answering, no players can join, and Docker still reports the container
# healthy because nothing exited. EU Warfork sat wedged like that for 38 hours
# on 2026-08-08 before anyone noticed.
#
# So health here is not "is the process alive" — it is "does the engine still
# answer its own protocol". We send the same out-of-band `getinfo` datagram the
# master-server browser sends and require an `infoResponse` back. That is the
# exact probe that distinguished dead-from-alive during the incident: a wedged
# engine answers nothing at all.
#
# (An earlier version of this comment claimed the socket "stays bound, so there
# is no ICMP refusal either". That was extrapolated from a SIGSTOP rehearsal,
# not from the real wedge, and it is wrong: the ERR_DROP path reaches
# SV_ShutdownGame, which calls NET_CloseSocket on the UDP sockets before it
# unwinds. Either way the probe behaves the same — no infoResponse comes back —
# which is why the recovery logic never depended on the distinction.)
#
# RECOVERY. After $RS_HEALTH_FAILS consecutive misses we kill the engine, and
# the layer above brings it back:
#   - Warsow:  entrypoint.sh's supervise loop relaunches it after ~5s; the
#              container never goes down.
#   - Warfork: same supervise loop (added alongside this script for exactly
#              this reason — see warfork/entrypoint.sh).
# The engine MUST be a child of the entrypoint, never PID 1: the kernel drops
# in-namespace signals to PID 1 unless it installed a handler, so `kill -9 1`
# from in here returns success and does nothing. kill_engine() refuses that case
# loudly rather than pretending it restarted something.
#
# ADMIN FORCE-RESTART. The same wedge that eats `getinfo` also eats RCON, so the
# admin panel's `quit`-over-RCON restart cannot reach a wedged server. Instead
# the panel raises a flag and this script — a separate process, unaffected by
# whatever the engine is doing — collects it on its next run via an OUTBOUND
# poll. That keeps remote boxes (US) working with no inbound port, no Docker
# socket, and no shared secret beyond the ingest token the box already holds.
#
# Exit status is the health status: 0 healthy, 1 not. Killing the engine reports
# unhealthy, which is honest — at that instant the server is down.
set -u

PORT="${SV_PORT:-44400}"
FAIL_LIMIT="${RS_HEALTH_FAILS:-6}"          # consecutive misses before a kill
GRACE="${RS_HEALTH_GRACE:-240}"             # seconds a freshly launched engine gets
PIDFILE="${ENGINE_PIDFILE:-/tmp/engine.pid}"
STATE="${TMPDIR:-/tmp}/gamehealth.fails"
# The crash guard's breadcrumb dir (crashguard.sh CG_RUN). This script owns the
# CONFIRMATION half of the attribution: the entrypoint records which map the
# engine is loading, and only a real infoResponse proves that map came up.
CG_RUN="${RS_CRASHGUARD_RUN:-${TMPDIR:-/tmp}/crashguard}"

log() { echo ">> gamehealth: $*"; }

now="$(date +%s)"

# The engine's PID, as recorded by the entrypoint just after launch. The pgrep
# fallback covers a container started from an older image whose entrypoint does
# not write the file yet.
engine_pid() {
    local p=""
    [ -r "${PIDFILE}" ] && p="$(cat "${PIDFILE}" 2>/dev/null)"
    if [ -n "${p}" ] && [ -d "/proc/${p}" ]; then
        printf '%s' "${p}"
        return 0
    fi
    pgrep -f 'w[sf]_server\.x86_64' 2>/dev/null | head -1
}

# SIGTERM, then SIGKILL if it is still there. Bounded well inside the compose
# healthcheck timeout — a healthcheck killed for running long would leave the
# engine half-signalled and the cooldown unwritten.
kill_engine() {
    local why="$1" pid i
    pid="$(engine_pid)"
    if [ -z "${pid}" ]; then
        log "wanted a restart (${why}) but found no engine process"
        return 1
    fi
    if [ "${pid}" = "1" ]; then
        log "engine is PID 1 — the kernel ignores in-namespace signals to it, cannot restart from here." \
            "Rebuild this image so entrypoint.sh supervises the engine instead of exec'ing it."
        return 1
    fi
    log "restarting engine pid ${pid} (${why})"
    kill -TERM "${pid}" 2>/dev/null || true
    for i in 1 2 3; do
        sleep 1
        [ -d "/proc/${pid}" ] || { log "engine exited"; break; }
    done
    if [ -d "/proc/${pid}" ]; then
        log "engine ignored SIGTERM, sending SIGKILL"
        kill -KILL "${pid}" 2>/dev/null || true
    fi
    echo 0 > "${STATE}" 2>/dev/null || true
    return 0
}

# One out-of-band getinfo, exactly as a server browser sends it. bash's /dev/udp
# keeps this dependency-free (neither image ships netcat).
probe() {
    local out
    exec 3<>"/dev/udp/127.0.0.1/${PORT}" 2>/dev/null || return 1
    if ! printf '\xff\xff\xff\xffgetinfo racesow-health' >&3 2>/dev/null; then
        exec 3<&- 3>&- 2>/dev/null
        return 1
    fi
    # A wedged engine never replies, so `timeout` is what ends this read, not EOF.
    out="$(timeout 3 head -c 128 <&3 2>/dev/null | tr -d '\0')"
    exec 3<&- 3>&- 2>/dev/null
    case "${out}" in *infoResponse*) return 0 ;; esac
    return 1
}

# Did an admin ask for a force-restart? Outbound only, authenticated with the
# per-server ingest token the box already has. The endpoint hands a pending
# request out AT MOST ONCE (it clears the flag as it answers), so a failed kill
# is not retried forever — the admin clicks again.
ops_restart_requested() {
    [ "${RS_HEALTH_OPS:-1}" = "1" ] || return 1
    [ -n "${INGEST_URL:-}" ] && [ -n "${INGEST_TOKEN:-}" ] || return 1
    local body
    body="$(curl -fsS --max-time 4 -H "Authorization: Bearer ${INGEST_TOKEN}" \
        "${INGEST_URL%/api/ingest}/api/game/ops" 2>/dev/null)" || return 1
    case "${body}" in *'"restart":true'*) return 0 ;; esac
    return 1
}

# --- main --------------------------------------------------------------------
# Startup grace. A cold boot — mounting thousands of pk3s, building g_maplist,
# compiling the gametype, loading the first map — answers nothing for a while,
# and that must never read as a wedge, or the watchdog kills the server it is
# meant to be nursing up and does it again every cycle. The entrypoint rewrites
# the pidfile on every launch, so its mtime IS the current engine's start time;
# that covers a cold container start and a post-kill relaunch with one rule.
#
# The window between a kill and the relaunch 5s later has no pidfile and no
# engine: also grace, since there is nothing to probe and nothing to signal.
in_grace=0
if [ -n "$(engine_pid)" ]; then
    started_at="$(stat -c %Y "${PIDFILE}" 2>/dev/null || echo '')"
    case "${started_at}" in
        ''|*[!0-9]*) : ;;    # no pidfile (pre-watchdog image): probe counts as normal
        *) [ "$((now - started_at))" -lt "${GRACE}" ] && in_grace=1 ;;
    esac
else
    in_grace=1
fi

# An explicit admin request outranks the probe — the server may well be
# answering getinfo and still need a bounce (a stuck map, a config reload).
if [ "${in_grace}" = "0" ] && ops_restart_requested; then
    kill_engine "admin force-restart"
    exit 1
fi

if probe; then
    echo 0 > "${STATE}" 2>/dev/null || true
    # The engine answered its own protocol, so whatever map it was loading is
    # now genuinely serving. Retire the breadcrumb to `lastgood` and clear it.
    #
    # This is what keeps the crash guard honest in BOTH directions. Clearing it
    # means a server that dies hours later — OOM, host reboot, an operator
    # `docker restart` — is never blamed on the map it happens to be running.
    # Leaving it set until this point means a map that dies during load IS
    # blamed, whether that load happened at boot or three hours in, because the
    # confirmation never arrived. Duration heuristics cannot tell those apart;
    # this can.
    if [ -s "${CG_RUN}/loading" ]; then
        cat "${CG_RUN}/loading" > "${CG_RUN}/lastgood" 2>/dev/null || true
        : > "${CG_RUN}/loading" 2>/dev/null || true
    fi
    exit 0
fi

# Still booting after a restart we caused: report unhealthy, but do not let it
# count toward another kill.
if [ "${in_grace}" = "1" ]; then
    log "no infoResponse on udp/${PORT} yet — within post-restart grace"
    exit 1
fi

fails="$(cat "${STATE}" 2>/dev/null || echo 0)"
case "${fails}" in ''|*[!0-9]*) fails=0 ;; esac
fails=$((fails + 1))
echo "${fails}" > "${STATE}" 2>/dev/null || true
log "no infoResponse on udp/${PORT} (${fails}/${FAIL_LIMIT})"

[ "${fails}" -ge "${FAIL_LIMIT}" ] && kill_engine "wedged: ${fails} consecutive probe failures with no reply"
exit 1
