#!/usr/bin/env bash
# ROLE=player: a headless GL client that connects to a game server as a REAL
# player and wanders (walk + turn + jump) so there is a live "racer" for the
# TV capture to follow. A demo/test aid — NOT part of the production pipeline.
#
# The client ignores stdin, so all control goes through the in-game console
# driven by xdotool (open with `~`, type a command, Enter). Movement uses the
# console +/- action commands (+forward/+left/+moveup), which need no mouse grab.
#
#   CONNECT       host:port of the game server            (required)
#   PLAYER_NAME   in-game name                            (default Racerbot)
#   WIDTH HEIGHT FPS                                       (960 540 30 — small; it's only a bot)
set -uo pipefail

WARSOW_DIR="${WARSOW_DIR:-/warsow}"
: "${CONNECT:?set CONNECT=host:port of the game server}"
W="${WIDTH:-960}"; H="${HEIGHT:-540}"; FPS="${FPS:-30}"
NAME="${PLAYER_NAME:-Racerbot}"
DPY="${DISPLAY_NUM:-99}"
export DISPLAY=":${DPY}" SDL_VIDEODRIVER=x11 SDL_AUDIODRIVER=dummy
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}" GALLIUM_DRIVER="${GALLIUM_DRIVER:-llvmpipe}"

log() { echo ">> [player] $*"; }

Xvfb ":${DPY}" -screen 0 "${W}x${H}x24" +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
for _ in $(seq 1 40); do xdpyinfo -display ":${DPY}" >/dev/null 2>&1 && break; sleep 0.1; done

cd "${WARSOW_DIR}"
./warsow.x86_64 +set fs_basepath "${WARSOW_DIR}" +set fs_usehomedir 0 \
    +set vid_fullscreen 0 +set r_mode -1 +set vid_width "${W}" +set vid_height "${H}" \
    +set vid_customwidth "${W}" +set vid_customheight "${H}" \
    +set in_grabinput 0 +set s_module 0 +set cl_maxfps "${FPS}" \
    +set name "${NAME}" +connect "${CONNECT}" >/tmp/client.log 2>&1 &
CLIENT_PID=$!
trap 'kill $CLIENT_PID $XVFB_PID 2>/dev/null; exit 0' TERM INT

# The client RECREATES its window during connect/map-load, so a window id grabbed
# early goes stale (X BadWindow on focus) and all later input is lost. Always
# re-read the CURRENT window (match WM_CLASS "warsow.x86_64") right before input.
curwid() { xdotool search --class 'warsow.x86_64' 2>/dev/null | tail -1; }
press() { local w; w="$(curwid)"; [ -z "${w}" ] && return; xdotool windowfocus "${w}" 2>/dev/null || true; xdotool key --clearmodifiers "$1"; }
cmd() {   # one console command: open ~, type, Enter, close ~
    local w; w="$(curwid)"; [ -z "${w}" ] && return
    xdotool windowfocus "${w}" 2>/dev/null || true
    xdotool key --clearmodifiers grave; sleep 0.25
    xdotool type --clearmodifiers -- "$*"; sleep 0.10
    xdotool key --clearmodifiers Return;  sleep 0.10
    xdotool key --clearmodifiers grave;   sleep 0.20
}

# Wait for the window, then for connect + pak download + spawn.
for _ in $(seq 1 80); do [ -n "$(curwid)" ] && break; sleep 0.5; done
[ -z "$(curwid)" ] && { log "no client window; aborting"; exit 1; }
log "client window up; waiting for connect + spawn"
sleep 22
w="$(curwid)"; [ -n "${w}" ] && xdotool windowmove "${w}" 0 0 2>/dev/null || true

press Escape; sleep 0.6      # dismiss the racemod MOTD
cmd "join"                   # ensure we're spawned INTO the race (not spectating)
sleep 0.5
cmd "+forward"               # always moving forward
cmd "+right"                 # gentle constant turn -> sweep the map in a loop
log "walking; entering wander loop"

# Keep moving: forward is held and a constant slow turn makes it circle rather
# than grind a wall; frequent jumps + occasional strafe read as a live racer
# bunny-hopping. (Each console command toggles the console, so this is naturally
# paced ~1 action/sec.)
n=0
while kill -0 "${CLIENT_PID}" 2>/dev/null; do
    cmd "+moveup"; cmd "-moveup"                 # bunny jump
    n=$(( n + 1 ))
    if [ $(( n % 4 )) -eq 0 ]; then              # periodically flip turn + strafe
        cmd "-right"; cmd "+left"; sleep 1.2; cmd "-left"; cmd "+right"
        cmd "+moveright"; sleep 0.4; cmd "-moveright"
    fi
    sleep 0.5
done
