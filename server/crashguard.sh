# shellcheck shell=sh
# ---------------------------------------------------------------------------
# crashguard.sh -- bad-map crash recovery for the supervise loop.
#
# Sourced (not executed) by server/entrypoint.sh and warfork/entrypoint.sh.
# POSIX sh only: the Warsow image's /bin/sh is dash.
#
# WHY THIS EXISTS. When a map fails to load the engine raises
# Com_Error(ERR_DROP). Where that lands decides everything, and neither landing
# is survivable on its own:
#
#   mid-session  longjmp -> Qcommon_Frame's setjmp, which returns. But
#                SV_ShutdownGame already ran: game module unloaded, clients
#                dropped, UDP socket CLOSED, svs.initialized=false. SV_Frame
#                then early-returns past its only NET_Sleep, so the process
#                spins one core at 100% answering nothing. Docker says "Up".
#
#   boot map     `+map` is executed by the Cbuf_Execute at the END of
#                Qcommon_Init, whose setjmp landing pad is Sys_Error() ->
#                _exit(1). The supervise loop then relaunches with the IDENTICAL
#                argv, five seconds later, forever. That is the bootloop -- the
#                "server refuses to start back up" symptom.
#
# The bootloop is airtight today because nothing in the loop is allowed to learn
# anything: FIRST_MAP is computed once and baked into argv above the loop, and
# the exit status is discarded by `wait "$pid" || true`. This file gives the
# loop a memory.
#
# HOW IT DECIDES WHICH MAP IS AT FAULT. Not by grepping for an error string --
# that misses the segfault class entirely (a corrupt BSP faults in the lump
# loaders and prints nothing at all) and the banner never names the map anyway.
# Instead the rule is "a load began and was never confirmed":
#
#   1. The engine prints `SpawnServer: <map>` BEFORE CM_LoadMap runs, so the
#      name is on the console even when the loader faults. cg_scan_line records
#      it in $CG_RUN/loading.
#   2. gamehealth.sh clears that file the first time the engine answers a
#      getinfo datagram -- i.e. the map is confirmed serving.
#   3. So if the engine dies with $CG_RUN/loading still populated, that map was
#      being loaded and never came up. Anything else (an OOM kill hours into a
#      healthy map, an operator restart) leaves it empty and is never blamed.
#
# The tap runs INSIDE the console drainer's read loop, so cg_scan_line must use
# shell builtins and nothing else. That loop never forks, therefore never
# reaps; one fork per console line is one zombie per console line. US Warsow
# held 5,624 of them after 18h uptime the last time that rule was broken.
#
# Set RS_CRASHGUARD=0 to disable everything here and get the previous
# fixed-argv behaviour back.
# ---------------------------------------------------------------------------

CG_ENABLED="${RS_CRASHGUARD:-1}"

# Consecutive failed loads of one map before it stops being offered. 1 would
# quarantine on a single fluke; 2 costs one extra ~5s relaunch and rules out
# transient host conditions.
CG_FAILS="${RS_CRASHGUARD_FAILS:-2}"

# A launch that survives this long is treated as a good launch for backoff
# purposes. It does NOT by itself clear blame: a server that ran for hours and
# then died loading a bad map still names that map, because the breadcrumb is
# what carries the attribution, not the runtime.
CG_HEALTHY_SECS="${RS_CRASHGUARD_HEALTHY_SECS:-90}"

# Quarantine entries older than this are forgotten, so a map broken by a
# transient local condition (a half-written pk3 mid-rsync) comes back on its own
# and only a genuinely broken map stays out. 0 disables expiry.
CG_EXPIRE_SECS="${RS_CRASHGUARD_EXPIRE_SECS:-604800}"   # 7 days

CG_BACKOFF="${RS_CRASHGUARD_BACKOFF:-5 10 30 60 120}"

# Ephemeral per-boot state (breadcrumbs). /tmp is fine: it only has to outlive
# an engine, not a container.
CG_RUN="${RS_CRASHGUARD_RUN:-${TMPDIR:-/tmp}/crashguard}"

# Durable state (the quarantine). Set by cg_init to the first writable
# candidate, so the quarantine survives a container recreate wherever a volume
# is mounted, and degrades to /tmp rather than failing when none is.
CG_STATE=""

# Diagnostics go to STDERR, never stdout. cg_pick_map returns the chosen map on
# stdout and the caller reads it through a command substitution, so a single
# stray log line on stdout would be concatenated into the map name and the
# engine would be launched with `+map ">> crashguard: ...bravo-run"`. Both
# streams land in `docker logs` either way.
cg_log() { echo ">> crashguard: $*" >&2; }

# --- console tap -------------------------------------------------------------
# BUILTIN-ONLY. See the zombie note in the header before adding anything here:
# no pipelines, no command substitution, no external binaries.
cg_scan_line() {
    case "$1" in
        *"SpawnServer: "*)
            _cg_m="${1##*SpawnServer: }"
            # The engine writes ANSI colour escapes when stdout is a tty (and
            # both compose files allocate one), so the name really arrives as
            # "wamphi1<ESC>[0m". Cut at the first character that cannot appear
            # in a map name: that handles the escape, a trailing field and a
            # stray CR in one builtin expansion, with no fork. Getting this
            # wrong is silent and total — a quarantine keyed on "wamphi1<ESC>[0m"
            # matches no pool entry, so the bad map is never actually skipped.
            _cg_m="${_cg_m%%[!a-zA-Z0-9_.-]*}"
            # Never clobber a good breadcrumb with a malformed line.
            if [ -n "${_cg_m}" ]; then
                printf '%s\n' "${_cg_m}" > "${CG_RUN}/loading" 2>/dev/null
                : > "${CG_RUN}/lasterr" 2>/dev/null
            fi
            ;;
        *"ERROR: "*)
            # Keep the FIRST error after a load began; later ones are usually
            # teardown noise and the first is the cause.
            [ -s "${CG_RUN}/lasterr" ] || \
                printf '%s\n' "${1#*ERROR: }" > "${CG_RUN}/lasterr" 2>/dev/null
            ;;
    esac
}

# --- state -------------------------------------------------------------------
cg_init() {
    [ "${CG_ENABLED}" = "1" ] || { cg_log "disabled (RS_CRASHGUARD=0)"; return 0; }

    mkdir -p "${CG_RUN}" 2>/dev/null || true
    : > "${CG_RUN}/loading" 2>/dev/null || true
    : > "${CG_RUN}/lasterr" 2>/dev/null || true
    printf '0\n' > "${CG_RUN}/streak" 2>/dev/null || true

    # Prefer a mounted volume so the quarantine survives `docker compose up -d`.
    for _cg_d in "${RS_CRASHGUARD_STATE:-}" "${MOD_DIR:-}/racelog" "${CG_RUN}"; do
        [ -n "${_cg_d}" ] || continue
        mkdir -p "${_cg_d}" 2>/dev/null || continue
        if : > "${_cg_d}/.cg-write-test" 2>/dev/null; then
            rm -f "${_cg_d}/.cg-write-test" 2>/dev/null || true
            CG_STATE="${_cg_d}"
            break
        fi
    done
    [ -n "${CG_STATE}" ] || CG_STATE="${CG_RUN}"
    [ -f "${CG_STATE}/quarantine.tsv" ] || : > "${CG_STATE}/quarantine.tsv" 2>/dev/null || true

    _cg_n="$(cg_quarantined | wc -w 2>/dev/null || echo 0)"
    cg_log "armed; state=${CG_STATE}; ${_cg_n} map(s) quarantined"
}

# Space-delimited list of currently-quarantined map names (expired ones dropped).
cg_quarantined() {
    [ -f "${CG_STATE}/quarantine.tsv" ] || return 0
    _cg_now="$(date +%s)"
    # NB: do NOT name an awk variable `exp` (or `log`, `index`, `split`, ...) --
    # they are built-in function names and awk rejects the program outright.
    # That failure is invisible if stderr is discarded: the filter silently
    # yields nothing and every quarantined map is re-admitted.
    awk -F'\t' -v now="${_cg_now}" -v fails="${CG_FAILS}" -v maxage="${CG_EXPIRE_SECS}" '
        NF >= 3 && $2 + 0 >= fails && (maxage + 0 == 0 || now - ($3 + 0) < maxage) { printf "%s ", $1 }
    ' "${CG_STATE}/quarantine.tsv" || cg_log "WARNING: could not read the quarantine at ${CG_STATE}"
}

# Record one failed load of $1 (note in $2), incrementing its counter.
cg_record_failure() {
    _cg_map="$1"; _cg_note="$2"
    _cg_now="$(date +%s)"
    _cg_tmp="${CG_STATE}/quarantine.tsv.$$"
    # Rewrite-and-rename so a crash mid-write can never leave a truncated
    # quarantine (which would silently re-admit every map it listed).
    if awk -F'\t' -v OFS='\t' -v m="${_cg_map}" -v now="${_cg_now}" -v note="${_cg_note}" '
            $1 == m { print $1, $2 + 1, now, note; seen = 1; next }
            NF >= 3 { print }
            END { if (!seen) print m, 1, now, note }
        ' "${CG_STATE}/quarantine.tsv" > "${_cg_tmp}" 2>/dev/null &&
       mv -f "${_cg_tmp}" "${CG_STATE}/quarantine.tsv" 2>/dev/null
    then
        :
    else
        rm -f "${_cg_tmp}" 2>/dev/null || true
        cg_log "WARNING: could not persist the quarantine to ${CG_STATE}"
    fi

    _cg_ct="$(awk -F'\t' -v m="${_cg_map}" '$1 == m { print $2 + 0 }' "${CG_STATE}/quarantine.tsv" 2>/dev/null || echo '?')"
    if [ "${_cg_ct}" != '?' ] && [ "${_cg_ct}" -ge "${CG_FAILS}" ] 2>/dev/null; then
        cg_log "'${_cg_map}' failed to load ${_cg_ct}x -- quarantined, it will not be offered again"
    else
        cg_log "'${_cg_map}' failed to load (${_cg_ct}/${CG_FAILS} before quarantine)"
    fi
}

# --- map selection -----------------------------------------------------------
# Pick order, per the vetted-pool rule:
#   1. MAPLIST (mappool.txt order == most-raced first) minus quarantine minus
#      the central blocklist, re-fetched per launch so a quarantine raised by
#      ANOTHER node reaches this box's boot map.
#   2. any installed map that is not quarantined -- covers the case where
#      mappool.txt matched nothing and MAPLIST fell back to the whole mirror.
#   3. whatever we were given, unchanged, rather than refusing to start.
cg_pick_map() {
    _cg_want="$1"

    # Operator override: force a boot map, bypassing the pool, the quarantine
    # and the blocklist. This replaces the old "append EXTRA_ARGS after +map"
    # trick, which only ever worked on Warfork (Warsow appended +map last) and
    # stopped working on both once +map moved into the loop. Use it to pin a
    # server to one map, or to reproduce a crash on a map the guard has already
    # quarantined -- it deliberately does NOT consult the quarantine, so it can
    # re-run a known-bad map on purpose.
    if [ -n "${RS_FORCE_MAP:-}" ]; then
        cg_log "RS_FORCE_MAP set -- booting '${RS_FORCE_MAP}' and ignoring the quarantine"
        printf '%s' "${RS_FORCE_MAP}"
        return 0
    fi

    [ "${CG_ENABLED}" = "1" ] || { printf '%s' "${_cg_want}"; return 0; }

    _cg_skip=" $(cg_quarantined) "

    # Re-fetch the central blocklist on RELAUNCHES only. The first launch does
    # not need it: the entrypoint already subtracted the blocklist from
    # INSTALLED (and so from MAPLIST) minutes earlier, and repeating a 5s-timeout
    # fetch on the boot path just delays a healthy start. On a relaunch it is
    # exactly what we want — it is how a map another node has just had blocked
    # stops being this node's next boot map.
    _cg_st="$(cat "${CG_RUN}/streak" 2>/dev/null || echo 0)"
    case "${_cg_st}" in ''|*[!0-9]*) _cg_st=0 ;; esac
    if [ "${_cg_st}" -gt 0 ] && [ -n "${INGEST_URL:-}" ]; then
        _cg_blocked="$(curl -fsS --max-time 5 "${INGEST_URL%/api/ingest}/api/game/blocked-maps" 2>/dev/null \
            | tr -d '\r' | awk 'NF && $1 !~ /^\/\// { printf "%s ", tolower($1) }' || true)"
        # An `if`, not `[ ... ] && ...`: this is the last statement of the block,
        # and under `set -e` a false test there makes the whole block's status
        # non-zero. The callers run with -e set.
        if [ -n "${_cg_blocked}" ]; then
            _cg_skip="${_cg_skip}${_cg_blocked} "
        fi
    fi

    # Nothing to avoid, and the requested map is fine: keep it (the common path).
    case "${_cg_skip}" in
        *" ${_cg_want} "*) : ;;
        *)  printf '%s' "${_cg_want}"; return 0 ;;
    esac

    for _cg_c in ${MAPLIST:-}; do
        case "${_cg_skip}" in
            *" ${_cg_c} "*) continue ;;
            *) cg_log "boot map '${_cg_want}' is quarantined/blocked -- using '${_cg_c}' from the vetted pool"
               printf '%s' "${_cg_c}"; return 0 ;;
        esac
    done
    for _cg_c in ${INSTALLED:-}; do
        case "${_cg_skip}" in
            *" ${_cg_c} "*) continue ;;
            *) cg_log "vetted pool exhausted -- falling back to installed map '${_cg_c}'"
               printf '%s' "${_cg_c}"; return 0 ;;
        esac
    done
    cg_log "WARNING: every candidate map is quarantined or blocked; starting '${_cg_want}' anyway"
    printf '%s' "${_cg_want}"
}

# --- launch bookkeeping ------------------------------------------------------
cg_arm() {
    [ "${CG_ENABLED}" = "1" ] || return 0
    # The tap fills this in from the engine's own SpawnServer line. Seed it with
    # the map we asked for so a crash BEFORE that line still attributes: at boot
    # the engine can die inside Qcommon_Init with nothing useful on stdout.
    printf '%s\n' "$1" > "${CG_RUN}/loading" 2>/dev/null || true
    : > "${CG_RUN}/lasterr" 2>/dev/null || true
}

# cg_verdict <exit-status> <seconds-the-engine-ran>
cg_verdict() {
    [ "${CG_ENABLED}" = "1" ] || return 0
    _cg_st="$1"; _cg_ran="$2"

    # Let the console drainer catch up. It is a separate process reading the
    # FIFO, and the engine's dying words -- the ERROR banner in particular --
    # are usually still buffered at the instant `wait` returns. Reading the
    # breadcrumbs too early would miss the error text, and with it the
    # socket-error exclusion below, which is what stops a host-level fault from
    # walking the quarantine through the entire map pool one relaunch at a time.
    # Attribution itself does not depend on this (cg_arm seeded the map name
    # before launch); only the classification does.
    [ -n "${CONSOLE_FIFO:-}" ] && sleep 1

    _cg_map="$(cat "${CG_RUN}/loading" 2>/dev/null || true)"
    _cg_err="$(cat "${CG_RUN}/lasterr" 2>/dev/null || true)"

    # Conditions that are the HOST's fault, not the map's. Blaming the map here
    # would walk the quarantine straight through the whole pool, one map per
    # relaunch, and end with a server that refuses every map it owns.
    case "${_cg_err}" in
        *"Couldn't open any socket"*|*"Couldn't open loopback socket"*|*"Couldn't open network socket"*)
            cg_log "engine exited on a socket error, not a map fault -- not quarantining anything"
            cg_bump_streak "${_cg_ran}"
            return 0
            ;;
    esac

    if [ -z "${_cg_map}" ]; then
        # gamehealth.sh saw this engine answer getinfo, so whatever killed it
        # happened after the map was already serving. Not a load failure.
        cg_log "engine exited after ${_cg_ran}s with no map load in flight (status ${_cg_st})"
        cg_bump_streak "${_cg_ran}"
        return 0
    fi

    cg_log "engine exited (status ${_cg_st}, ${_cg_ran}s) while loading '${_cg_map}' -- never confirmed serving"
    if [ -n "${_cg_err}" ]; then
        cg_log "  last error: ${_cg_err}"
    fi
    cg_record_failure "${_cg_map}" "${_cg_err:-no error text (possible segfault)}"
    cg_report "${_cg_map}" "${_cg_err}" "${_cg_st}"
    cg_bump_streak "${_cg_ran}"
}

cg_bump_streak() {
    if [ "${1:-0}" -ge "${CG_HEALTHY_SECS}" ] 2>/dev/null; then
        printf '0\n' > "${CG_RUN}/streak" 2>/dev/null || true
        return 0
    fi
    _cg_s="$(cat "${CG_RUN}/streak" 2>/dev/null || echo 0)"
    case "${_cg_s}" in ''|*[!0-9]*) _cg_s=0 ;; esac
    printf '%s\n' "$((_cg_s + 1))" > "${CG_RUN}/streak" 2>/dev/null || true
}

# Escalating relaunch delay. A tight 5s loop on a permanently broken box is a
# denial of service against the box itself -- the old loop re-scanned the whole
# 4,257-pk3 mirror twelve times a minute for as long as it lasted.
cg_sleep() {
    if [ "${CG_ENABLED}" != "1" ]; then sleep 5; return 0; fi
    _cg_s="$(cat "${CG_RUN}/streak" 2>/dev/null || echo 0)"
    case "${_cg_s}" in ''|*[!0-9]*) _cg_s=0 ;; esac
    _cg_i=1; _cg_delay=5
    for _cg_step in ${CG_BACKOFF}; do
        _cg_delay="${_cg_step}"
        [ "${_cg_i}" -ge "${_cg_s}" ] && break
        _cg_i=$((_cg_i + 1))
    done
    [ "${_cg_s}" -gt 1 ] && cg_log "relaunch #${_cg_s} in ${_cg_delay}s"
    sleep "${_cg_delay}"
}

# --- reporting ---------------------------------------------------------------
# Best-effort, detached, and never allowed to delay a relaunch. This rides the
# existing moderator flag queue; RS_CRASHGUARD_REPORT_URL points it at the
# dedicated map-load endpoint once that ships.
#
# This is the NETWORK-WIDE half of the recovery. The local quarantine below
# protects this box; the POST is what stops the other three nodes from each
# discovering the same bad map the hard way. Once the central side has enough
# evidence (two failures, or one on each of two DISTINCT servers) the map joins
# GET /api/game/blocked-maps, which every box already consumes: the entrypoint
# subtracts it at boot and the gametype re-fetches it every ~30s.
#
# REQUIRES A TRUSTED PER-SERVER TOKEN. The endpoint creates central state, so it
# demands an enrolled server with status='trusted'. A box on the legacy shared
# token, or one an admin has quarantined, gets a 403 and its crash is recorded
# LOCALLY only (the quarantine file) — still enough to break its own bootloop.
#
# Idempotency is structural on the server side, so nothing here needs retry
# state: the evidence row is UNIQUE per (server, map, second) and the quarantine
# is keyed by map name, so four nodes hitting one broken map yield one
# quarantine with fail_count=4, server_count=4.
cg_report() {
    [ -n "${INGEST_URL:-}" ] && [ -n "${INGEST_TOKEN:-}" ] || return 0
    _cg_url="${RS_CRASHGUARD_REPORT_URL:-${INGEST_URL%/api/ingest}/api/game/map-load}"
    _cg_map="$1"; _cg_err="$2"; _cg_st="$3"
    # Strip the characters that would break out of the JSON string. The error
    # text is engine output, not ours, so it is not trusted to be clean.
    # shellcheck disable=SC1003  # '"\\' is the 2-char set {double-quote, backslash}
    _cg_note="$(printf '[auto] map-load failure on %s (exit %s): %s' \
        "${SERVER_NAME:-${SV_HOSTNAME:-unknown}}" "${_cg_st}" "${_cg_err:-no error text}" \
        | tr -cd '[:print:]' | tr -d '"\\' | cut -c1-400)"
    (
        curl -fsS --max-time 8 -X POST \
            -H "Authorization: Bearer ${INGEST_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "{\"map\":\"${_cg_map}\",\"detector\":\"crashguard\",\"note\":\"${_cg_note}\"}" \
            "${_cg_url}" >/dev/null 2>&1 || true &
    )
    cg_log "reported '${_cg_map}' to ${_cg_url}"
}
