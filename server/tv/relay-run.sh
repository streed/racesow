#!/usr/bin/env bash
# ROLE=relay: the wswtv_server QTV relay. It connects OUTWARD to a game server
# and re-serves that stream to downstream spectator clients (our capture client)
# on tv_port. The tarball's basewsw/tvserver_autoexec.cfg supplies the tv_*
# defaults (tv_port 44440, tv_maxclients 64, tv_chasemode); we override a few.
#
#   TV_UPSTREAM  host:port of the game server to stream   (required)
#   TV_PORT      downstream tv port                        (default 44440)
#   TV_NAME      relay name                                (default "RACESOW[TV]")
#   TV_PASSWORD  password downstream clients must supply   (default none)
#   TV_DELAY     broadcast delay seconds                   (default 0 = live)
set -euo pipefail

: "${TV_UPSTREAM:?set TV_UPSTREAM=host:port of the game server to stream}"
TV_PORT="${TV_PORT:-44440}"
TV_NAME="${TV_NAME:-RACESOW[TV]}"
TV_DELAY="${TV_DELAY:-0}"

# The wswtv relay is OPTIONAL — the capture connects directly to the game server
# for the server-side director, so nothing needs this relay in the normal path.
# If you do run it, it MUST NOT be an open, publicly-connectable TV server:
# require a password and keep tv_public 0 (LAN/internal only). Refuse to start
# without a password so a relay can never accidentally accept the public.
: "${TV_PASSWORD:?refusing to start an open TV server — set TV_PASSWORD (people must not be able to connect)}"
TV_MAXCLIENTS="${TV_MAXCLIENTS:-2}"

cd "${WARSOW_DIR}"

set -- \
    +set fs_basepath "${WARSOW_DIR}" \
    +set fs_usehomedir 0 \
    +set dedicated 1 \
    +set tv_port "${TV_PORT}" \
    +set tv_port6 "${TV_PORT}" \
    +set tv_name "${TV_NAME}" \
    +set tv_password "${TV_PASSWORD}" \
    +set tv_maxclients "${TV_MAXCLIENTS}" \
    +set sv_public 0 \
    +set tv_public 0

# `connect <addr> [password] [name] [delay]` — the relay's outward link. Issued
# as a startup command so it reconnects on `tv_relay` restart. Delay 0 = live.
set -- "$@" +connect "${TV_UPSTREAM}" "${TV_PASSWORD}" "${TV_NAME}" "${TV_DELAY}"

echo ">> wswtv_server.x86_64 relaying ${TV_UPSTREAM} on tv_port ${TV_PORT}"
exec stdbuf -oL -eL "${WARSOW_DIR}/wswtv_server.x86_64" "$@"
