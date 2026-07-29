#!/usr/bin/env bash
# xpiry-heartbeat.sh — push liveness heartbeats for THIS box's game servers (and
# TV encoder) to xpiry.dev. Driven every 60s by racesow-xpiry-heartbeat.timer,
# or run by hand. Idempotent + single-instance (flock).
#
# The game servers are UDP on custom ports, so xpiry can't probe them from the
# outside — we probe them locally (the same connectionless "getstatus" packet
# server/tv/getstatus.sh uses) and ping the matching heartbeat monitor.
#
# HEALTH MODEL: on success we ping the monitor's OK URL (with the live player
# count as ?value=). On FAILURE we stay SILENT and let xpiry's grace period lapse
# — that way the nightly 5am restart (a brief bounce well inside the grace
# window) never pages, while a real sustained outage still trips once the grace
# period is exceeded. Set XPIRY_PING_FAIL=1 to also send an explicit /fail for
# faster (but restart-noisy) detection.
#
# WHICH monitors fire is driven purely by which XPIRY_PING_* are set in .env:
#   XPIRY_PING_WARSOW   -> UDP getstatus of 127.0.0.1:44400
#   XPIRY_PING_WARFORK  -> UDP getstatus of 127.0.0.1:44410
#   XPIRY_PING_TV       -> `docker inspect` of the warsow-tv-capture container
# So the same script runs on both boxes; each box's .env only carries its own
# three URLs (see scripts/xpiry-provision.sh output).
#
# AUTH: xpiry's ping endpoint on this account requires the API key (an
# unauthenticated ping is 401), so each box's .env must also carry XPIRY_API_KEY
# (the same key used to provision). See docs/xpiry-monitoring.md for the security
# note on that.
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# Ping URLs come from the env (systemd EnvironmentFile=.env) or, for a hand run,
# from the repo-root .env — same pattern as scripts/ingest-demos.sh.
if [ -z "${XPIRY_PING_WARSOW:-}${XPIRY_PING_WARFORK:-}${XPIRY_PING_TV:-}" ]; then
    [ -f "${REPO_ROOT}/.env" ] && { set -a; . "${REPO_ROOT}/.env"; set +a; }
fi

GAME_HOST="${XPIRY_GAME_HOST:-127.0.0.1}"
WARSOW_PORT="${XPIRY_WARSOW_PORT:-44400}"
WARFORK_PORT="${XPIRY_WARFORK_PORT:-44410}"
TV_CONTAINER="${XPIRY_TV_CONTAINER:-warsow-tv-capture}"
PING_FAIL="${XPIRY_PING_FAIL:-0}"
LOG="${XPIRY_HEARTBEAT_LOG:-}"                 # empty = quiet (systemd captures stdout)

say() {
    local line; line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
    printf '%s\n' "${line}"
    [ -n "${LOG}" ] && printf '%s\n' "${line}" >> "${LOG}" || true
}

command -v curl >/dev/null 2>&1 || { echo "curl not found" >&2; exit 3; }
if [ -z "${XPIRY_PING_WARSOW:-}${XPIRY_PING_WARFORK:-}${XPIRY_PING_TV:-}" ]; then
    say "no XPIRY_PING_* set — nothing to do (run scripts/xpiry-provision.sh first)"
    exit 0
fi
if [ -z "${XPIRY_API_KEY:-}" ]; then
    say "XPIRY_API_KEY unset — xpiry's ping endpoint requires it (401 without). Add it to .env."
    exit 3
fi

# Single instance: a slow probe/curl must not overlap the next 60s tick.
exec 9>"${REPO_ROOT}/.xpiry-heartbeat.lock"
flock -n 9 || { echo "another heartbeat run is in progress"; exit 0; }

# udp_players HOST PORT -> prints the connected-client count and exits 0 when the
# server answers getstatus; exits 1 (no output) when there's no UDP response.
# Same robust select-with-timeout probe as server/tv/getstatus.sh (no child
# pipeline, guaranteed to exit). "responded at all" is the liveness signal; the
# count is only decoration for the monitor graph.
udp_players() {
    local host="$1" port="$2" resp
    resp="$(perl -MIO::Socket::INET -MIO::Select -e '
        my ($h,$p) = @ARGV; my $r = "";
        my $s = IO::Socket::INET->new(Proto=>"udp", PeerAddr=>$h, PeerPort=>$p);
        if ($s && defined $s->send("\xff\xff\xff\xffgetstatus\x0a")) {
            $s->recv($r, 65535) if IO::Select->new($s)->can_read(1.5);
        }
        $r =~ tr/\000//d; print $r;
    ' "${host}" "${port}" 2>/dev/null)"
    [ -n "${resp}" ] || return 1
    # Player lines start at line 3: <score> <ping> "name" [team]. Count them.
    printf '%s\n' "${resp}" | awk 'NR>2 && /"/ {c++} END{print c+0}'
    return 0
}

# ping URL [query]  — POST the heartbeat; short timeout, a couple of retries.
# The ping endpoint requires the API key (see AUTH note in the header).
ping() {
    curl -fsS -m 8 --retry 2 --retry-all-errors -X POST \
        -H "Authorization: Bearer ${XPIRY_API_KEY}" \
        "$1${2:+?$2}" -o /dev/null 2>/dev/null
}

# report LABEL PING_URL up|down [value]
report() {
    local label="$1" url="$2" state="$3" value="${4:-}"
    [ -n "${url}" ] || return 0
    if [ "${state}" = up ]; then
        if ping "${url}" "${value:+value=${value}}"; then
            say "${label}: up${value:+ (${value} players)} -> ok"
        else
            say "${label}: up but ping FAILED (${url%%\?*})"
        fi
    else
        if [ "${PING_FAIL}" = 1 ]; then
            ping "${url}/fail" "error=no-response" && say "${label}: DOWN -> /fail"
        else
            say "${label}: down — staying silent (grace period will lapse)"
        fi
    fi
}

# --- Warsow / Warfork: UDP getstatus of the local server ---
if [ -n "${XPIRY_PING_WARSOW:-}" ]; then
    if n="$(udp_players "${GAME_HOST}" "${WARSOW_PORT}")"; then
        report warsow "${XPIRY_PING_WARSOW}" up "${n}"
    else
        report warsow "${XPIRY_PING_WARSOW}" down
    fi
fi
if [ -n "${XPIRY_PING_WARFORK:-}" ]; then
    if n="$(udp_players "${GAME_HOST}" "${WARFORK_PORT}")"; then
        report warfork "${XPIRY_PING_WARFORK}" up "${n}"
    else
        report warfork "${XPIRY_PING_WARFORK}" down
    fi
fi

# --- TV encoder: container is running = up. "idle" (no viewers) is NOT down. ---
if [ -n "${XPIRY_PING_TV:-}" ]; then
    if command -v docker >/dev/null 2>&1 \
       && [ "$(docker inspect -f '{{.State.Running}}' "${TV_CONTAINER}" 2>/dev/null)" = "true" ]; then
        report tv "${XPIRY_PING_TV}" up
    else
        report tv "${XPIRY_PING_TV}" down
    fi
fi

exit 0
