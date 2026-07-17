#!/usr/bin/env bash
# Dispatch to the relay or the capture role. See Dockerfile header.
set -euo pipefail

ROLE="${ROLE:-capture}"
echo ">> warsow-tv starting: ROLE=${ROLE}"
case "${ROLE}" in
    relay)   exec /opt/tv/relay-run.sh ;;
    capture) exec /opt/tv/capture-run.sh ;;
    player)  exec /opt/tv/player-run.sh ;;
    *) echo "!! unknown ROLE='${ROLE}' (want relay|capture|player)"; exit 1 ;;
esac
