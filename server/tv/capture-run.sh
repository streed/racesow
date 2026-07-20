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
#   TV_NAME       spectator name (ALWAYS excluded from the watch count)   (RACESOW-TV)
#   EXCLUDE_NAMES extra EXACT infra names excluded from the watch count
#                 (e.g. the relay), comma list; TV_NAME is always excluded (empty)
#   WIDTH HEIGHT FPS / VBITRATE VBUF / STREAM_ID / HLS_DIR / SERVER_NAME
#   POLL          director poll seconds                                   (4)
#   STREAM_STALL  seconds without a NEW HLS segment (ffmpeg alive but the
#                 picture is frozen) before ffmpeg is restarted            (20)
#   WATCHDOG_STALL seconds of stalled director loop before the watchdog
#                  hard-exits the container (docker restarts it)           (300)
#   HEARTBEAT_URL HEARTBEAT_TOKEN SERVER_ID   optional registry POST
set -uo pipefail

WARSOW_DIR="${WARSOW_DIR:-/warsow}"
: "${TV_CONNECT:?set TV_CONNECT=host:port of the game server}"
STATUS_ADDR="${STATUS_ADDR:-${TV_CONNECT}}"
TV_NAME="${TV_NAME:-RACESOW-TV}"
EXCLUDE_NAMES="${EXCLUDE_NAMES:-}"    # extra EXACT infra names; TV_NAME is always excluded
TV_HUD="${TV_HUD-ale_racemod}"        # race HUD applied AFTER connect ("" = keep the default HUD)
W="${WIDTH:-1280}"; H="${HEIGHT:-720}"; FPS="${FPS:-30}"
VBITRATE="${VBITRATE:-2500k}"; VBUF="${VBUF:-5000k}"
STREAM_ID="${STREAM_ID:-stream}"; HLS_DIR="${HLS_DIR:-/hls}"
SERVER_NAME="${SERVER_NAME:-RACESOW}"
API_TOP_URL="${API_TOP_URL:-}"        # web /api/game/topscores base; empty => no top-3 on the card
CARD_REFRESH="${CARD_REFRESH:-20}"    # seconds between idle-card (map + top-3) refreshes
POLL="${POLL:-4}"
STREAM_STALL="${STREAM_STALL:-20}"    # s without a new HLS segment => ffmpeg wedged, restart it
seg_last_mtime=0; seg_last_change=0; seg_stall_restarts=0   # picture-freshness tracker
DPY="${DISPLAY_NUM:-99}"; GOP=$(( FPS * 2 ))
export DISPLAY=":${DPY}" SDL_VIDEODRIVER=x11 SDL_AUDIODRIVER=dummy
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}" GALLIUM_DRIVER="${GALLIUM_DRIVER:-llvmpipe}"

OUT="${HLS_DIR}/${STREAM_ID}"; CARD="${HLS_DIR}/${STREAM_ID}.card.png"
# Start clean so a restart never accumulates stale segments; ffmpeg's
# delete_segments then keeps only the live rolling window (put /hls on a tmpfs
# so segments live in RAM and never touch disk — see the run/compose config).
rm -rf "${OUT}"; mkdir -p "${OUT}"
log(){ echo ">> [capture] $*"; }

# Mirror the game's map paks so this pure spectator never has to DOWNLOAD one on
# connect. The server offers each map's pak (and base_tex.pk3 is ~140MB) over the
# game channel; a stalled/failed download leaves the client unable to spawn, so
# tv_connected never goes green and the director loops forever "reconnecting".
# When the game's maps dir is mounted read-only at /warsow/maps_extra (same bind
# the game uses), symlink every pak into the mod's fs_game dir so they are already
# present and pure-checksum-matched — exactly what the game's own entrypoint does.
if [ -d "${WARSOW_DIR}/maps_extra" ]; then
  n=0
  for pk in "${WARSOW_DIR}/maps_extra"/*.pk3; do
    [ -e "${pk}" ] || break
    ln -sf "${pk}" "${WARSOW_DIR}/racemod/$(basename "${pk}")" 2>/dev/null && n=$(( n + 1 ))
  done
  log "linked ${n} map paks from maps_extra (no pure downloads needed)"
fi

XVFB_PID=0; FEH_PID=0; FFMPEG_PID=0; CLIENT_PID=0; WATCHDOG_PID=0; WID=""; FEHWID=""
cleanup(){ for p in "${WATCHDOG_PID}" "${CLIENT_PID}" "${FFMPEG_PID}" "${FEH_PID}" "${XVFB_PID}"; do [ "${p}" -ne 0 ] && kill "${p}" 2>/dev/null; done; exit 0; }
trap cleanup TERM INT

# --- 1. virtual display ------------------------------------------------------
rm -f "/tmp/.X${DPY}-lock" 2>/dev/null || true   # avoid stale-lock on restart/reboot
Xvfb ":${DPY}" -screen 0 "${W}x${H}x24" +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
for _ in $(seq 1 60); do xdpyinfo -display ":${DPY}" >/dev/null 2>&1 && break; sleep 0.1; done
log "Xvfb up (${W}x${H})"

# --- 2. idle card (feh, persistent background layer) -------------------------
# The card shows the current map's TOP 3 times (from API_TOP_URL) when the
# server is empty, or a waiting line otherwise. Regenerated periodically; feh
# --reload picks up the new file (make-card writes atomically).
# One-shot UDP getstatus probe -> raw response on stdout ("" on any failure or
# ~1.5s timeout). ONE perl process using select-with-timeout: no child pipeline,
# no signal-based teardown, guaranteed to exit. This replaces the old
# `timeout 1 cat </dev/udp/... | tr` pipeline: a UDP read never sees EOF, so
# every poll ended via timeout's SIGALRM/SIGTERM path, and coreutils 8.28
# `timeout` has a lost-SIGCHLD race (delivered between waitpid(WNOHANG) and
# sigsuspend) that wedges it in sigsuspend forever while it still holds the
# $()-pipe write end — freezing the whole director (both prod boxes froze
# within ~a day of boot, 2026-07-19).
udp_getstatus(){
  perl -MIO::Socket::INET -MIO::Select -e '
    my ($host, $port) = @ARGV;
    my $r = "";
    my $s = IO::Socket::INET->new(Proto => "udp", PeerAddr => $host, PeerPort => $port);
    if ($s && defined $s->send("\xff\xff\xff\xffgetstatus\x0a")) {
        $s->recv($r, 65535) if IO::Select->new($s)->can_read(1.5);
    }
    $r =~ tr/\000//d;
    print $r;
  ' "${1%:*}" "${1##*:}" 2>/dev/null
}

current_map(){
  local resp
  resp="$(udp_getstatus "${1}")"
  # info string (line 2) is \key\value\...; pull the mapname value
  printf '%s\n' "${resp}" | sed -n '2p' | tr '\\' '\n' | awk 'p{print;exit} $0=="mapname"{p=1}'
}
# The server-side director publishes the on-stream POV (the followed player's
# clean name) into serverinfo as rs_tv_pov (see hrace.as RACE_TvDirectorThink);
# read it from the same info string so the heartbeat can tell the site who we're
# watching. Empty when the director is free-flying / nobody is racing.
current_pov(){
  local resp
  resp="$(udp_getstatus "${1}")"
  printf '%s\n' "${resp}" | sed -n '2p' | tr '\\' '\n' | awk 'p{print;exit} $0=="rs_tv_pov"{p=1}'
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
# Newest mtime of the HLS manifest; ffmpeg rewrites it on every segment, so it
# advances every ~hls_time seconds while the encoder is healthy — a frozen mtime
# with ffmpeg still alive means the picture is wedged (see the main-loop guard).
manifest_mtime(){ stat -c %Y "${OUT}/index.m3u8" 2>/dev/null || echo 0; }
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
  # reset the picture-freshness tracker so the fresh encoder gets a full
  # STREAM_STALL window before the main-loop guard may judge it.
  seg_last_mtime="$(manifest_mtime)"; seg_last_change="$(date +%s)"
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
    +set cg_showhelp 0 +set cg_clientHUD "" \
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

# Apply the race HUD (ale_racemod: speed / strafe / accel / keystate / timers)
# AFTER the client has connected and the renderer is warm. Setting cg_clientHUD
# at LAUNCH instead makes the cold first-connect precache load the HUD's gfx
# under llvmpipe, which stalls the client long enough for the server to time it
# out (it enters the game, then drops); by here the client has rendered a while
# so the warm load is quick and the connection survives. (start_client also
# forces cg_clientHUD "" at launch so a value archived to config.cfg on a prior
# run can't reintroduce that stall.) Each cvar goes on its OWN console line — the
# console does not reliably split a ;-chained line, and one clean cvar per line is
# what makes it actually stick. Only called once we are in-game (see boot_client),
# so it runs once, not once-per-reconnect-retry. The idle card is raised on top,
# so the brief console never shows on the stream. TV_HUD="" keeps the default HUD.
apply_hud(){
  [ -z "${TV_HUD}" ] && return
  [ -z "$(curwid)" ] && return
  cmd "cg_clientHUD ${TV_HUD}"
  cmd "cg_showSpeed 1"
  cmd "cg_showPressedKeys 1"
  cmd "cg_showFPS 0"
  log "race HUD applied (${TV_HUD})"
}

boot_client(){
  start_client
  # Wait for the GL window (a cold llvmpipe boot can be slow); bail early if the
  # client process dies so the director can restart it.
  for _ in $(seq 1 120); do
    kill -0 "${CLIENT_PID}" 2>/dev/null || break
    WID="$(xdotool search --class 'warsow.x86_64' 2>/dev/null | head -1)"; [ -n "${WID}" ] && break
    sleep 0.5
  done
  # Wait until we are ACTUALLY in the game before dismissing the menu / applying
  # the HUD — not a fixed sleep. This is what stops the reconnect thrash (and the
  # HUD being re-applied on every retry) when a cold boot runs long: boot_client
  # doesn't "finish" until connected, so the main loop won't prematurely reconnect.
  for _ in $(seq 1 60); do
    kill -0 "${CLIENT_PID}" 2>/dev/null || break
    tv_connected && break
    sleep 1
  done
  sleep 2                                             # let the spawn/menu settle
  init_client && log "spectator initialised (win ${WID})" || log "spectator: no window yet"
  apply_hud                                           # race HUD, set warm (see apply_hud) — never at launch
  last_map="$(current_map "${STATUS_ADDR}" 2>/dev/null)"   # sync so a (re)connect isn't seen as a map change
}

# Count real players on the game server. Always exclude our own spectator by its
# EXACT name (the same identity the server-side director matches on), plus any
# extra exact infra names in EXCLUDE_NAMES (e.g. the relay).
watchable(){ /opt/tv/getstatus.sh "${STATUS_ADDR}" "${TV_NAME}${EXCLUDE_NAMES:+,${EXCLUDE_NAMES}}" 2>/dev/null || echo 0; }

# Is our spectator ACTUALLY connected to the game right now? getstatus the game
# and look for our own TV_NAME among the clients. The GL client stays alive at
# the menu after a server restart/kick/timeout, so a process-alive check is not
# enough. Returns: 0 = connected; 1 = game reachable but we are NOT in it
# (dropped); 2 = game unreachable (down/restarting — transient, don't reconnect).
tv_connected(){
  local resp
  resp="$(udp_getstatus "${STATUS_ADDR}")"
  [ -z "${resp}" ] && return 2
  printf '%s\n' "${resp}" | grep -qF "\"${TV_NAME}\"" && return 0 || return 1
}
heartbeat(){   # status players [pov]
  [ -z "${HEARTBEAT_URL:-}" ] && return
  # pov (who the director is showing) + map so the site can caption the stream;
  # JSON-escape by dropping the only chars that could break the literal.
  local pov_json="null" map_json="null"
  [ -n "${3:-}" ]        && pov_json="\"$(printf '%s' "$3"          | tr -d '"\\')\""
  [ -n "${last_map:-}" ] && map_json="\"$(printf '%s' "${last_map}" | tr -d '"\\')\""
  curl -fsS -m 3 -X POST "${HEARTBEAT_URL}" -H "Authorization: Bearer ${HEARTBEAT_TOKEN:-}" \
    -H 'Content-Type: application/json' \
    -d "{\"stream_id\":\"${STREAM_ID}\",\"server_id\":${SERVER_ID:-null},\"status\":\"$1\",\"players\":$2,\"map\":${map_json},\"pov\":${pov_json}}" >/dev/null 2>&1 || true
}

# --- 5. director -------------------------------------------------------------
last_map=""
MAP_SETTLE="${MAP_SETTLE:-14}"            # seconds to show the card while a new map loads

# On a map change Warsow re-pops the team/"join game" menu when the client
# respawns into the new map. The server-side director keeps us a spectator but
# cannot close a CLIENT-SIDE menu overlay, so it would sit on the stream until
# the next reconnect. Detect the change (the server's mapname in getstatus) and
# dismiss it exactly as on connect (a single Escape) — raising the branded card
# meanwhile so viewers see the new map's card, not the join prompt, as it loads.
handle_map_change(){
  local newmap="$1"
  log "map changed (${last_map:-?} -> ${newmap}); card up while the client reloads"
  refresh_card; raise_card; state="idle"
  sleep "${MAP_SETTLE}"                   # let the client finish loading + the menu pop
  init_client && log "join menu dismissed (win ${WID})" || log "post-map: no window yet"
  state="init"                            # re-decide live/idle + raise the right layer next tick
}

# --- 4.5 watchdog: the director must NEVER silently freeze -------------------
# The main loop touches BEAT every tick; if it goes stale the loop is wedged
# (whatever the cause), so hard-exit the container and let docker's restart
# policy boot a fresh one. kill -9 because a wedged loop can be blocked
# somewhere a TERM trap would never run (e.g. mid-$() read); killing the main
# script takes down docker --init and with it the whole namespace — a clean
# restart beats a frozen stream. Threshold is generous: a cold boot_client
# alone can legitimately run ~130s without a tick.
BEAT="/tmp/tv-director.beat"
WATCHDOG_STALL="${WATCHDOG_STALL:-300}"
touch "${BEAT}"
(
  while sleep 60; do
    last="$(stat -c %Y "${BEAT}" 2>/dev/null || echo 0)"
    if [ $(( $(date +%s) - last )) -gt "${WATCHDOG_STALL}" ]; then
      echo ">> [watchdog] director stalled >${WATCHDOG_STALL}s; exiting container for a fresh start"
      kill -9 "$$" 2>/dev/null
      exit 0
    fi
  done
) &
WATCHDOG_PID=$!

boot_client
state="init"
card_age=0
disc=0
RECONNECT_AFTER="${RECONNECT_AFTER:-8}"   # seconds dropped-but-game-up before we reconnect
log "director running (connect=${TV_CONNECT}, exclude=${EXCLUDE_NAMES})"
while true; do
  touch "${BEAT}"
  kill -0 "${XVFB_PID}"  2>/dev/null || cleanup
  kill -0 "${FFMPEG_PID}" 2>/dev/null || { log "ffmpeg died; restart"; start_ffmpeg; }

  # --- picture-freshness guard ------------------------------------------------
  # ffmpeg grabs the X display continuously (game OR idle card), so index.m3u8 is
  # rewritten every ~hls_time seconds. If it STOPS advancing while ffmpeg is still
  # alive, the encoder/X/tmpfs is wedged — the "frozen picture, healthy container"
  # case the loop-watchdog (which the loop keeps beating) can never see. Restart
  # ffmpeg; if it stays stalled across restarts, hard-exit for a clean container
  # (fresh X + client), same policy as the watchdog.
  now_s="$(date +%s)"; cur_mtime="$(manifest_mtime)"
  if [ "${cur_mtime}" != "${seg_last_mtime}" ]; then
    seg_last_mtime="${cur_mtime}"; seg_last_change="${now_s}"; seg_stall_restarts=0
  elif [ $(( now_s - seg_last_change )) -ge "${STREAM_STALL}" ]; then
    if [ "${seg_stall_restarts}" -ge 2 ]; then
      log "stream still stalled after ${seg_stall_restarts} ffmpeg restarts; exiting container for a clean restart"
      kill -9 "$$" 2>/dev/null
    fi
    log "no new HLS segment for >${STREAM_STALL}s (ffmpeg alive but wedged); restarting ffmpeg"
    kill "${FFMPEG_PID}" 2>/dev/null || true
    start_ffmpeg
    seg_stall_restarts=$(( seg_stall_restarts + 1 ))
    seg_last_change="${now_s}"   # grace: let the fresh ffmpeg fill a window
  fi

  # --- connection management: keep the spectator IN the game -----------------
  rc=2                                     # default: unknown/unreachable this tick
  if [ "${CLIENT_PID}" -eq 0 ] || ! kill -0 "${CLIENT_PID}" 2>/dev/null; then
    # (a) client process exited (crash / clean quit) -> reconnect
    log "client process gone; reconnecting"; raise_card; boot_client; state="init"; disc=0
  else
    # (b) process alive but no longer IN the game (server restart/kick/timeout).
    #     The GL client just sits at the menu, so only a getstatus probe catches it.
    tv_connected; rc=$?
    if [ "${rc}" -eq 1 ]; then
      disc=$(( disc + POLL ))
      if [ "${disc}" -ge "${RECONNECT_AFTER}" ]; then
        log "spectator dropped from game (${disc}s alive-but-out); reconnecting"
        kill "${CLIENT_PID}" 2>/dev/null || true; CLIENT_PID=0
        raise_card; boot_client; state="init"; disc=0
      fi
    else
      disc=0   # 0 = connected, 2 = game unreachable (transient — wait, don't thrash)
    fi
  fi

  # --- map change: the client re-pops the join menu on the new map -----------
  # Only when we are actually in the game (rc=0); a reconnect above already
  # re-synced last_map via boot_client, so this won't double-fire.
  if [ "${rc}" -eq 0 ]; then
    cur_map="$(current_map "${STATUS_ADDR}")"
    if [ -n "${cur_map}" ]; then
      [ -n "${last_map}" ] && [ "${cur_map}" != "${last_map}" ] && handle_map_change "${cur_map}"
      last_map="${cur_map}"
    fi
  fi

  n="$(watchable)"; case "${n}" in ''|*[!0-9]*) n=0;; esac
  if [ "${n}" -gt 0 ]; then
    if [ "${state}" != "live" ]; then
      raise_client                         # show the game (director drives the cam)
      state="live"; log "LIVE: following (${n} on server)"
    fi
    heartbeat live "${n}" "$(current_pov "${STATUS_ADDR}")"
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
