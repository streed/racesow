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
# GAMETYPE DRIFT. A second failure mode that also leaves the process healthy by
# every other measure: the engine answers, the map is up, and it is running the
# WRONG GAME. A map can carry a progs/maps/<name>.as whose MAP_Gametype() hook
# names a gametype, and the engine honours it — the two stock tutorial maps
# (wtutorial1 / wftutorial1) return "tutorial". That unloads our race gametype
# script, and everything the script owns goes with it: no idle rotation to move
# off the map, and no mesh publish, so the box drops out of the server mesh and
# stays on the tutorial forever. US Warfork sat like that from 2026-08-21 to
# 2026-08-24. The maps themselves are now out of every in-script selection path
# (RACE_IsStockNonRaceMap in blockedmaps.as); this is the backstop for the ways
# in that the script does not mediate — the engine's own built-in `callvote
# map`, rcon, a newly installed map with the same hook. The reply already
# carries the answer: infoResponse ends with \gametype\<name>, so compare it
# with the gametype this container was configured to run and bounce the engine
# when they part ways.
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
# The gametype this server is supposed to be running. Both entrypoints default
# G_GAMETYPE to hrace and docker-compose.warfork.yml sets it explicitly; the
# healthcheck is a separate process, so it reads the CONTAINER env (compose),
# not the entrypoint's shell variable — hence the same default here.
WANT_GAMETYPE="${G_GAMETYPE:-hrace}"
GT_FAIL_LIMIT="${RS_HEALTH_GT_FAILS:-3}"    # consecutive wrong-gametype replies
GT_COOLDOWN="${RS_HEALTH_GT_COOLDOWN:-600}" # seconds between gametype-drift kills
GT_STATE="${TMPDIR:-/tmp}/gamehealth.gtfails"
GT_LAST="${TMPDIR:-/tmp}/gamehealth.gtkill"
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
# keeps this dependency-free (neither image ships netcat). Prints the reply on
# stdout so the caller can read the serverinfo out of it; no reply => exit 1.
probe() {
    local out
    exec 3<>"/dev/udp/127.0.0.1/${PORT}" 2>/dev/null || return 1
    if ! printf '\xff\xff\xff\xffgetinfo racesow-health' >&3 2>/dev/null; then
        exec 3<&- 3>&- 2>/dev/null
        return 1
    fi
    # ONE datagram, whole. `dd count=1` issues a single read(), which a datagram
    # socket answers with the entire reply and returns immediately. `head -c N`
    # cannot do this job: it reads until it has N bytes, so an N big enough for
    # the whole infoResponse (~600 bytes — and the gametype is its LAST key)
    # blocks until `timeout` kills head, which then discards what it buffered.
    # A wedged engine never replies at all, so `timeout` is what ends this read
    # in that case, not EOF.
    out="$(timeout 3 dd bs=4096 count=1 <&3 2>/dev/null | tr -d '\0')"
    exec 3<&- 3>&- 2>/dev/null
    case "${out}" in *infoResponse*) printf '%s' "${out}"; return 0 ;; esac
    return 1
}

# The gametype the engine says it is running, pulled out of the infoResponse's
# trailing \gametype\<name>\clients\<n>. Empty when the key is absent (an
# older engine, or a truncated reply) — the caller treats that as "no opinion"
# and never restarts on it.
reported_gametype() {
    local reply="$1" rest
    case "${reply}" in *'\gametype\'*) : ;; *) return 0 ;; esac
    # `##`, not `#`: take the LAST \gametype\, which is the engine's own trailing
    # key (it appends \gametype\<name>\clients\<n> after the serverinfo).
    rest="${reply##*\\gametype\\}"
    printf '%s' "${rest%%\\*}"
}

# Wrong gametype: count it, and once it has held for GT_FAIL_LIMIT consecutive
# probes bounce the engine so the supervise loop relaunches it on the configured
# boot map with the configured gametype.
#
# The cooldown is the important part. Unlike a wedge, this state survives the
# restart if its cause is configuration rather than a map — a box whose
# G_GAMETYPE genuinely disagrees with what the engine loads would otherwise be
# killed every GT_FAIL_LIMIT probes forever, an invisible restart loop. One kill
# per GT_COOLDOWN keeps the recovery for the case it can fix and makes the case
# it cannot fix merely noisy in the log.
gametype_drifted() {
    local got="$1" fails last
    fails="$(cat "${GT_STATE}" 2>/dev/null || echo 0)"
    case "${fails}" in ''|*[!0-9]*) fails=0 ;; esac
    fails=$((fails + 1))
    echo "${fails}" > "${GT_STATE}" 2>/dev/null || true
    log "engine is running gametype '${got}', want '${WANT_GAMETYPE}' (${fails}/${GT_FAIL_LIMIT})"
    [ "${fails}" -ge "${GT_FAIL_LIMIT}" ] || return 0

    last="$(cat "${GT_LAST}" 2>/dev/null || echo 0)"
    case "${last}" in ''|*[!0-9]*) last=0 ;; esac
    if [ "$((now - last))" -lt "${GT_COOLDOWN}" ]; then
        log "not restarting again yet — last gametype restart was $((now - last))s ago (cooldown ${GT_COOLDOWN}s)"
        return 0
    fi
    echo "${now}" > "${GT_LAST}" 2>/dev/null || true
    echo 0 > "${GT_STATE}" 2>/dev/null || true
    kill_engine "gametype drifted to '${got}', want '${WANT_GAMETYPE}'"
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

reply=""
if reply="$(probe)"; then
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

    # Answering, but is it answering as the game we asked for? A map that
    # switched g_gametype out from under us loads and replies perfectly happily
    # (see GAMETYPE DRIFT above) — the reply is the only place that shows it.
    # Nothing to check during the startup grace: the reply is still the previous
    # map's, and the boot map has not settled yet.
    gametype="$(reported_gametype "${reply}")"
    if [ "${in_grace}" = "0" ] && [ -n "${gametype}" ] && [ "${gametype}" != "${WANT_GAMETYPE}" ]; then
        gametype_drifted "${gametype}"
        exit 1   # a server running the wrong gametype is not healthy
    fi
    echo 0 > "${GT_STATE}" 2>/dev/null || true
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
