#!/usr/bin/env bash
#
# Phase 0 spike entrypoint: update the stock Warfork dedicated server from Steam
# (anonymous) and launch the `race` gametype. Layout is auto-detected because
# Warfork ships an `.app`-style bundle (Warfork.app/Contents/Resources/basewf)
# even on Linux, and the binary name has varied (wf_server.x86_64 / wf_server).
set -euo pipefail

APPID=1136510
SERVER_DIR=${SERVER_DIR:-/app/server}
G_GAMETYPE=${G_GAMETYPE:-race}
SV_HOSTNAME=${SV_HOSTNAME:-Racesow Warfork Spike}
SV_MAXCLIENTS=${SV_MAXCLIENTS:-16}
SV_PUBLIC=${SV_PUBLIC:-0}
SV_PORT=${SV_PORT:-44400}
SV_HTTP_PORT=${SV_HTTP_PORT:-44444}
MAP=${MAP:-}
STEAM_BRANCH=${STEAM_BRANCH:-}          # e.g. "beta" -> -beta beta
SKIP_UPDATE=${SKIP_UPDATE:-0}
EXTRA_ARGS=${EXTRA_ARGS:-}

if [ "${SKIP_UPDATE}" != "1" ]; then
    echo "[entrypoint] SteamCMD app_update ${APPID} (anonymous) -> ${SERVER_DIR}"
    beta_args=""
    [ -n "${STEAM_BRANCH}" ] && beta_args="-beta ${STEAM_BRANCH}"
    steamcmd +force_install_dir "${SERVER_DIR}" +login anonymous \
        +app_update "${APPID}" ${beta_args} validate +quit
fi

# --- Locate the linux server binary + the dir that contains basewf ----------
BIN=$(find "${SERVER_DIR}" -type f \( -name 'wf_server.x86_64' -o -name 'wf_server' \) \
        -not -name '*.exe' 2>/dev/null | head -1)
if [ -z "${BIN}" ]; then
    echo "[entrypoint] FATAL: no wf_server binary under ${SERVER_DIR}" >&2
    find "${SERVER_DIR}" -maxdepth 4 -iname 'wf_server*' >&2 || true
    exit 1
fi
chmod +x "${BIN}" || true

BASEWF_DIR=$(find "${SERVER_DIR}" -type d -name basewf 2>/dev/null | head -1)
BASEPATH=$(dirname "${BASEWF_DIR:-${SERVER_DIR}}")
echo "[entrypoint] binary   : ${BIN}"
echo "[entrypoint] basepath : ${BASEPATH}"

# Drop our race server.cfg into basewf/configs so +exec finds it.
if [ -n "${BASEWF_DIR}" ] && [ -w "${BASEWF_DIR}" ]; then
    mkdir -p "${BASEWF_DIR}/configs"
    cp /opt/warfork/server.cfg "${BASEWF_DIR}/configs/racesow-spike.cfg" 2>/dev/null || true
fi

map_arg=""
[ -n "${MAP}" ] && map_arg="+map ${MAP}"

set -x
exec "${BIN}" \
    +set fs_basepath "${BASEPATH}" \
    +set fs_game basewf \
    +set dedicated 1 \
    +set sv_hostname "${SV_HOSTNAME}" \
    +set sv_maxclients "${SV_MAXCLIENTS}" \
    +set sv_public "${SV_PUBLIC}" \
    +set sv_port "${SV_PORT}" \
    +set sv_http_port "${SV_HTTP_PORT}" \
    +set g_gametype "${G_GAMETYPE}" \
    +exec racesow-spike.cfg \
    ${map_arg} \
    ${EXTRA_ARGS}
