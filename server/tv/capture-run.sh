#!/usr/bin/env bash
# ROLE=capture: headless GL client (spectator) -> ffmpeg -> HLS, with an
# auto-director that FOLLOWS a live player and shows the branded RACESOW card
# when there is nobody to watch.
#
# The client connects DIRECTLY to the game server as a spectator (named
# ${TV_NAME}); the wswtv relay runs alongside (for future human TV clients).
# The client ignores stdin, so the director drives it through the in-game
# console via xdotool: open `~`, type `spec`/`chasenext`, Enter.
#
# One Xvfb display keeps the HLS stream continuous; ffmpeg grabs whichever
# window is raised on top:
#   - the spectator's chase view          when someone is on the server (LIVE)
#   - a fullscreen RACESOW card (feh)      when the server is empty      (IDLE)
#
# Env:
#   TV_CONNECT    host:port the spectator connects to (the GAME server)  [required]
#   STATUS_ADDR   host:port to getstatus for presence (default TV_CONNECT)
#   TV_NAME       spectator name (also excluded from the watch count)    (RACESOW-TV)
#   EXCLUDE_NAMES comma list of name prefixes that are NOT watchable      (RACESOW)
#   WIDTH HEIGHT FPS / VBITRATE VBUF / STREAM_ID / HLS_DIR / SERVER_NAME
#   POLL          director poll seconds                                   (4)
#   HEARTBEAT_URL HEARTBEAT_TOKEN SERVER_ID   optional registry POST
set -uo pipefail

WARSOW_DIR="${WARSOW_DIR:-/warsow}"
: "${TV_CONNECT:?set TV_CONNECT=host:port of the game server}"
STATUS_ADDR="${STATUS_ADDR:-${TV_CONNECT}}"
TV_NAME="${TV_NAME:-RACESOW-TV}"
EXCLUDE_NAMES="${EXCLUDE_NAMES:-RACESOW}"
W="${WIDTH:-1280}"; H="${HEIGHT:-720}"; FPS="${FPS:-30}"
VBITRATE="${VBITRATE:-2500k}"; VBUF="${VBUF:-5000k}"
STREAM_ID="${STREAM_ID:-stream}"; HLS_DIR="${HLS_DIR:-/hls}"
SERVER_NAME="${SERVER_NAME:-RACESOW}"
API_TOP_URL="${API_TOP_URL:-}"        # web /api/game/topscores base; empty => no top-3 on the card
CARD_REFRESH="${CARD_REFRESH:-20}"    # seconds between idle-card (map + top-3) refreshes
POLL="${POLL:-4}"
DPY="${DISPLAY_NUM:-99}"; GOP=$(( FPS * 2 ))
export DISPLAY=":${DPY}" SDL_VIDEODRIVER=x11 SDL_AUDIODRIVER=dummy
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}" GALLIUM_DRIVER="${GALLIUM_DRIVER:-llvmpipe}"

OUT="${HLS_DIR}/${STREAM_ID}"; CARD="${HLS_DIR}/${STREAM_ID}.card.png"
# Start clean so a restart never accumulates stale segments; ffmpeg's
# delete_segments then keeps only the live rolling window (put /hls on a tmpfs
# so segments live in RAM and never touch disk — see the run/compose config).
rm -rf "${OUT}"; mkdir -p "${OUT}"
log(){ echo ">> [capture] $*"; }

XVFB_PID=0; FEH_PID=0; FFMPEG_PID=0; CLIENT_PID=0; WID=""; FEHWID=""
cleanup(){ for p in "${CLIENT_PID}" "${FFMPEG_PID}" "${FEH_PID}" "${XVFB_PID}"; do [ "${p}" -ne 0 ] && kill "${p}" 2>/dev/null; done; exit 0; }
trap cleanup TERM INT

# --- 1. virtual display ------------------------------------------------------
Xvfb ":${DPY}" -screen 0 "${W}x${H}x24" +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
for _ in $(seq 1 60); do xdpyinfo -display ":${DPY}" >/dev/null 2>&1 && break; sleep 0.1; done
log "Xvfb up (${W}x${H})"

# --- 2. idle card (feh, persistent background layer) -------------------------
# The card shows the current map's TOP 3 times (from API_TOP_URL) when the
# server is empty, or a waiting line otherwise. Regenerated periodically; feh
# --reload picks up the new file (make-card writes atomically).
current_map(){
  local addr="${1}" host port resp
  host="${addr%:*}"; port="${addr##*:}"
  exec 5<>"/dev/udp/${host}/${port}" 2>/dev/null || { echo ""; return; }
  printf '\xff\xff\xff\xffgetstatus\n' >&5 2>/dev/null
  resp="$(timeout 1 cat <&5 2>/dev/null | tr -d '\000')"
  exec 5<&- 5>&- 2>/dev/null || true
  # info string (line 2) is \key\value\...; pull the mapname value
  printf '%s\n' "${resp}" | sed -n '2p' | tr '\\' '\n' | awk 'p{print;exit} $0=="mapname"{p=1}'
}
fmt_time(){   # ms -> race clock: 12345 -> 12.345, 92560 -> 1:32.560
  local ms="${1:-0}"
  case "${ms}" in ''|*[!0-9]*) echo "--"; return;; esac
  local m=$(( ms / 60000 )) sec=$(( (ms % 60000) / 1000 )) mss=$(( ms % 1000 ))
  if [ "${m}" -gt 0 ]; then printf '%d:%02d.%03d' "${m}" "${sec}" "${mss}"
  else printf '%d.%03d' "$(( ms / 1000 ))" "${mss}"; fi
}
refresh_card(){
  local map="" t1="" t2="" t3="" body rank=0 line time name
  map="$(current_map "${STATUS_ADDR}" 2>/dev/null)"
  if [ -n "${API_TOP_URL}" ] && [ -n "${map}" ]; then
    body="$(curl -fsS -m 3 "${API_TOP_URL}?map=${map}" 2>/dev/null || true)"
    while IFS= read -r line; do
      case "${line}" in
        '"'[0-9]*)
          time="$(printf '%s' "${line}" | sed -E 's/^"([0-9]+)".*/\1/')"
          name="$(printf '%s' "${line}" | sed -E 's/^"[0-9]+"[[:space:]]+"([^"]*)".*/\1/' | sed 's/\^[0-9]//g')"
          rank=$(( rank + 1 ))
          printf -v line '%d.  %-16.16s  %s' "${rank}" "${name}" "$(fmt_time "${time}")"
          case ${rank} in 1) t1="${line}";; 2) t2="${line}";; 3) t3="${line}";; esac
          [ "${rank}" -ge 3 ] && break ;;
      esac
    done <<< "${body}"
  fi
  local title="${SERVER_NAME}"; [ -n "${map}" ] && title="${SERVER_NAME}  -  ${map}"
  /opt/tv/make-card.sh "${CARD}" "${title}" "waiting for racers" "${t1}" "${t2}" "${t3}"
}

refresh_card
feh --fullscreen --hide-pointer --no-menus --zoom fill --reload 5 "${CARD}" >/tmp/feh.log 2>&1 &
FEH_PID=$!
sleep 0.5; FEHWID="$(xdotool search --class feh 2>/dev/null | head -1)"
log "idle card up (feh win ${FEHWID:-?})"

# --- 3. continuous ffmpeg capture -> HLS ------------------------------------
start_ffmpeg(){
  ffmpeg -hide_banner -loglevel warning -nostdin \
    -f x11grab -draw_mouse 0 -framerate "${FPS}" -video_size "${W}x${H}" -i ":${DPY}" \
    -vf format=yuv420p -c:v libx264 -preset veryfast -tune zerolatency -profile:v main \
    -g "${GOP}" -keyint_min "${GOP}" -sc_threshold 0 \
    -b:v "${VBITRATE}" -maxrate "${VBITRATE}" -bufsize "${VBUF}" \
    -f hls -hls_time 2 -hls_list_size 6 -hls_flags delete_segments+program_date_time \
    -hls_segment_type mpegts -hls_segment_filename "${OUT}/seg_%05d.ts" "${OUT}/index.m3u8" \
    >/tmp/ffmpeg.log 2>&1 &
  FFMPEG_PID=$!
}
start_ffmpeg
log "ffmpeg -> ${OUT}/index.m3u8"

# --- 4. spectator client, driven via the in-game console (xdotool) ----------
# The client recreates its window during connect/map-load, so re-read the CURRENT
# window (WM_CLASS warsow.x86_64) before every input — a stale id loses all keys.
curwid(){ xdotool search --class 'warsow.x86_64' 2>/dev/null | tail -1; }
cmd(){   # send one console command to the client
  local w; w="$(curwid)"; [ -z "${w}" ] && return
  xdotool windowfocus "${w}" 2>/dev/null || true
  xdotool key --clearmodifiers grave;  sleep 0.20
  xdotool type --clearmodifiers -- "$*"; sleep 0.10
  xdotool key --clearmodifiers Return; sleep 0.10
  xdotool key --clearmodifiers grave;  sleep 0.15
}
raise_client(){ local w; w="$(curwid)"; [ -n "${w}" ] && xdotool windowraise "${w}" 2>/dev/null || true; }
raise_card(){   [ -n "${FEHWID}" ] && xdotool windowraise "${FEHWID}" 2>/dev/null || true; }

start_client(){
  cd "${WARSOW_DIR}"
  ./warsow.x86_64 +set fs_basepath "${WARSOW_DIR}" +set fs_usehomedir 0 \
    +set vid_fullscreen 0 +set r_mode -1 +set vid_width "${W}" +set vid_height "${H}" \
    +set vid_customwidth "${W}" +set vid_customheight "${H}" \
    +set in_grabinput 0 +set s_module 0 +set cl_maxfps "${FPS}" \
    +set name "${TV_NAME}" +set racemod_seenintro 1 +exec profiles/stream.cfg \
    +connect "${TV_CONNECT}" >/tmp/client.log 2>&1 &
  CLIENT_PID=$!
}

# Align the window to 0,0 so ffmpeg grabs it. The SERVER-SIDE director forces
# this client to spectator and drives its chasecam, so there is deliberately NO
# client-side spec/chase here (typing those into the console leaks onto the
# stream). Returns non-zero until the window exists.
init_client(){
  WID="$(curwid)"
  [ -z "${WID}" ] && return 1
  xdotool windowmove "${WID}" 0 0 2>/dev/null || true
  # Warsow pops the team/join menu for a spectator on connect; it is open by the
  # time we get here, so a single Escape closes it. (The director keeps us a
  # spectator without re-triggering it.)
  xdotool windowfocus "${WID}" 2>/dev/null || true
  xdotool key --clearmodifiers Escape
  return 0
}

boot_client(){
  start_client
  for _ in $(seq 1 90); do WID="$(xdotool search --class 'warsow.x86_64' 2>/dev/null | head -1)"; [ -n "${WID}" ] && break; sleep 0.5; done
  sleep 18                                            # connect + pak download + spawn
  init_client && log "spectator initialised (win ${WID})" || log "spectator: no window yet"
}

watchable(){ /opt/tv/getstatus.sh "${STATUS_ADDR}" "${EXCLUDE_NAMES}" 2>/dev/null || echo 0; }
heartbeat(){
  [ -z "${HEARTBEAT_URL:-}" ] && return
  curl -fsS -m 3 -X POST "${HEARTBEAT_URL}" -H "Authorization: Bearer ${HEARTBEAT_TOKEN:-}" \
    -H 'Content-Type: application/json' \
    -d "{\"stream_id\":\"${STREAM_ID}\",\"server_id\":${SERVER_ID:-null},\"status\":\"$1\",\"players\":$2}" >/dev/null 2>&1 || true
}

# --- 5. director -------------------------------------------------------------
boot_client
state="init"
card_age=0
log "director running (connect=${TV_CONNECT}, exclude=${EXCLUDE_NAMES})"
while true; do
  kill -0 "${XVFB_PID}"  2>/dev/null || cleanup
  kill -0 "${FFMPEG_PID}" 2>/dev/null || { log "ffmpeg died; restart"; start_ffmpeg; }
  if [ "${CLIENT_PID}" -ne 0 ] && ! kill -0 "${CLIENT_PID}" 2>/dev/null; then
    log "client died; reconnecting"; boot_client; state="init"
  fi

  n="$(watchable)"; case "${n}" in ''|*[!0-9]*) n=0;; esac
  if [ "${n}" -gt 0 ]; then
    if [ "${state}" != "live" ]; then
      raise_client                         # show the game (director drives the cam)
      state="live"; log "LIVE: following (${n} on server)"
    fi
    heartbeat live "${n}"
  else
    if [ "${state}" != "idle" ]; then
      raise_card                           # RACESOW card on top
      state="idle"; card_age="${CARD_REFRESH}"; log "IDLE: showing card"
    fi
    # refresh the card (current map + top 3) on entering idle and every CARD_REFRESH s
    card_age=$(( card_age + POLL ))
    if [ "${card_age}" -ge "${CARD_REFRESH}" ]; then refresh_card; card_age=0; fi
    heartbeat idle 0
  fi
  sleep "${POLL}"
done
