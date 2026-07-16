#!/usr/bin/env bash
# pre-deploy-notify.sh — warn players on the game server(s) that a deploy is
# about to restart the server, via Warsow rcon (a connectionless UDP command).
#
# Run this right before a deploy that recreates the game-server container, so
# players get a heads-up instead of a silent disconnect mid-run. A rebuild +
# restart is typically ~1-2 minutes, so the notice tells them ~2 minutes.
#
#   RCON_PASSWORD=... scripts/pre-deploy-notify.sh
#   RCON_PASSWORD=... TARGETS="eu.frankfurt.racesow.org:44400 us.east.racesow.org:44400" \
#       scripts/pre-deploy-notify.sh
#
# RCON_PASSWORD must match the server's rcon_password (server/docker-compose.yml
# RCON_PASSWORD env -> `set rcon_password` in entrypoint.sh). TARGETS is a
# space-separated list of <host>:<game-udp-port> (default: the local server).
set -euo pipefail

RCON_PASSWORD="${RCON_PASSWORD:-}"
TARGETS="${TARGETS:-127.0.0.1:44400}"   # space-separated host:port game ports
REPEAT="${REPEAT:-3}"                    # send the notice a few times so nobody misses it
GAP="${GAP:-4}"                          # seconds between repeats
LEAD="${LEAD:-8}"                        # seconds to let players read before the deploy proceeds
MSG_DEFAULT='^1[DEPLOY]^7 A server update is rolling out now - the server will ^3restart^7 and be back in ^2~2 minutes^7. Sorry for interrupting your run!'
MSG="${DEPLOY_MSG:-$MSG_DEFAULT}"

[ -n "$RCON_PASSWORD" ] || { echo "ERROR: RCON_PASSWORD is required (must match the server's rcon_password)." >&2; exit 1; }
command -v nc >/dev/null 2>&1 || { echo "ERROR: nc (netcat) not found." >&2; exit 1; }

# Warsow connectionless rcon packet: four 0xFF bytes + "rcon <pass> <command>".
# `say <text>` broadcasts to every connected player as server chat.
send_rcon() {
    local host="$1" port="$2"; shift 2
    printf '\377\377\377\377rcon %s %s\n' "$RCON_PASSWORD" "$*" \
        | nc -u -w1 "$host" "$port" >/dev/null 2>&1 || true
}

echo ">> broadcasting deploy notice to: ${TARGETS}"
for r in $(seq 1 "$REPEAT"); do
    for t in $TARGETS; do
        host="${t%:*}"; port="${t##*:}"
        echo ">>   rcon say -> ${host}:${port} (${r}/${REPEAT})"
        send_rcon "$host" "$port" "say \"${MSG}\""
    done
    [ "$r" -lt "$REPEAT" ] && sleep "$GAP"
done

echo ">> notice sent; giving players ${LEAD}s to read before the deploy proceeds..."
sleep "$LEAD"
echo ">> pre-deploy notice complete."
