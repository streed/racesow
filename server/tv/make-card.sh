#!/usr/bin/env bash
# Render the branded RACESOW "idle" card shown on the stream when the watched
# server has no players. When top-time lines are supplied it shows the current
# map's TOP 3 instead of a bare "waiting" line, so an empty server is still
# useful to watch. Uses ffmpeg drawtext (no ImageMagick) + the vendored logo.
#
#   make-card.sh <out.png> [serverName] [statusText] [top1] [top2] [top3]
#
# topN lines are pre-formatted "N.  name              m:ss.mmm" strings (built by
# the capture from /api/game/topscores) and drawn left-aligned in a monospace
# font so the rank/name/time columns line up.
set -uo pipefail

OUT="${1:?usage: make-card.sh out.png [serverName] [statusText] [top1 top2 top3]}"
NAME="${2:-RACESOW}"
SUB="${3:-waiting for racers}"
T1="${4:-}"; T2="${5:-}"; T3="${6:-}"
F=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
FM=/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf
LOGO=/opt/tv/assets/warsow-logo.png

# drawtext treats : % \ ' specially — strip them from every dynamic string.
san() { printf '%s' "$1" | tr -d "\\\\:%'" | cut -c1-48; }
NAME="$(san "${NAME}")"; SUB="$(san "${SUB}")"
T1="$(san "${T1}")"; T2="$(san "${T2}")"; T3="$(san "${T3}")"

# base: dark bg + logo + RACE/SOW wordmark + server/map line
FILT="[1:v]scale=-1:118[logo];[0:v][logo]overlay=x=(W-w)/2:y=64[bg];[bg]"
FILT="${FILT}drawtext=fontfile=${F}:text='RACE':fontcolor=0xf2f4f8:fontsize=128:x=w/2-text_w:y=180:shadowcolor=0x000000:shadowx=3:shadowy=4,"
FILT="${FILT}drawtext=fontfile=${F}:text='SOW':fontcolor=0xe23b2e:fontsize=128:x=w/2:y=180:shadowcolor=0x000000:shadowx=3:shadowy=4,"
FILT="${FILT}drawtext=fontfile=${F}:text='${NAME}':fontcolor=0x9aa3b2:fontsize=32:x=(w-text_w)/2:y=352"

if [ -n "${T1}${T2}${T3}" ]; then
    FILT="${FILT},drawtext=fontfile=${F}:text='TOP TIMES':fontcolor=0xe23b2e:fontsize=28:x=(w-text_w)/2:y=418"
    y=470
    for L in "${T1}" "${T2}" "${T3}"; do
        [ -z "${L}" ] && continue
        # left-aligned block (monospace, fixed x) so columns line up
        FILT="${FILT},drawtext=fontfile=${FM}:text='${L}':fontcolor=0xf2f4f8:fontsize=30:x=(w-560)/2:y=${y}"
        y=$(( y + 44 ))
    done
else
    FILT="${FILT},drawtext=fontfile=${F}:text='${SUB}':fontcolor=0xe23b2e:fontsize=40:x=(w-text_w)/2:y=466"
fi

tmp="${OUT}.tmp.png"
if ffmpeg -y -hide_banner -loglevel error \
        -f lavfi -i "color=c=0x0b0e13:s=1280x720" -i "${LOGO}" \
        -filter_complex "${FILT}" -frames:v 1 "${tmp}" 2>/dev/null; then
    mv -f "${tmp}" "${OUT}"
else
    ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=0x0b0e13:s=1280x720" \
        -vf "drawtext=fontfile=${F}:text='RACESOW':fontcolor=0xe23b2e:fontsize=140:x=(w-text_w)/2:y=(h-text_h)/2" \
        -frames:v 1 "${OUT}" 2>/dev/null || true
fi
