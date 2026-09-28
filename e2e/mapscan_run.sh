#!/usr/bin/env bash
# mapscan_run.sh: a map pack added to the map store while the server runs
# becomes playable without a restart (docs/shared-maps.md).
#
# Real image, real engine patch (enginepatches/patch-mapscan.py):
#   1. boot warsow-race with an EMPTY map store mounted as the store
#      (entrypoint.sh hands it to the engine as fs_cdpath) and MAPSCAN_SECONDS=5
#   2. copy a generated pack into the store on the host
#   3. wait for the engine's own "mapscan: +1 map(s)" line
#   4. rcon "map <name>" and wait for that map to spawn and the gametype to
#      initialise on it
#
# Usage: e2e/mapscan_run.sh <pack.pk3> [image]   (image default warsow-race:2.1.2)
set -euo pipefail

PK3="${1:?usage: $0 <pack.pk3> [image]}"
IMAGE="${2:-warsow-race:2.1.2}"
MAP="$(basename "${PK3}" .pk3)"
NAME="mapscan-$$"
RCON="ci-$$-rcon"
STORE="$(mktemp -d)"
chmod 755 "${STORE}"
# A real store always carries its sentinel: it is how the entrypoint tells an
# empty-but-healthy store from a mount that never came up.
install -m 644 /dev/null "${STORE}/.racesow-map-store"

cleanup() {
    docker rm -f "${NAME}" >/dev/null 2>&1 || true
    rm -rf "${STORE}"
}
trap cleanup EXIT

logs() { docker logs "${NAME}" 2>&1; }
wait_for() {   # wait_for <regex> <seconds> <what>
    local deadline=$(( $(date +%s) + $2 ))
    while [ "$(date +%s)" -lt "${deadline}" ]; do
        if logs | grep -qE "$1"; then return 0; fi
        if [ "$(docker inspect -f '{{.State.Running}}' "${NAME}" 2>/dev/null)" != "true" ]; then
            echo "!! container died waiting for: $3"; logs | tail -30; return 1
        fi
        sleep 2
    done
    echo "!! timed out waiting for: $3"; logs | tail -30; return 1
}

echo ">> booting ${IMAGE} with an empty map store"
docker run -d --name "${NAME}" --tty -e SV_PUBLIC=0 -e MAPSCAN_SECONDS=5 \
    -e RCON_PASSWORD="${RCON}" --ulimit nofile=16384:16384 \
    -v "${STORE}:/warsow/shared/racemod:ro" "${IMAGE}" >/dev/null
wait_for "Gametype 'Race' initialized" 240 "the first map to come up"
logs | grep -q "mapscan: +" && { echo "!! a scan reported new maps before any were added"; exit 1; }

echo ">> adding ${MAP}.pk3 to the store while the server runs"
install -m 644 "${PK3}" "${STORE}/"
wait_for "mapscan: \\+1 map\\(s\\)" 60 "the engine to pick up the new pack"
echo ">> $(logs | grep -o 'mapscan: +1 map(s), [0-9]* on the list' | tail -1)"

before="$(logs | grep -c "Gametype 'Race' initialized" || true)"
IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${NAME}")"
echo ">> rcon map ${MAP}"
python3 - "${IP}" "${RCON}" "${MAP}" <<'EOF'
import socket, sys
ip, pw, m = sys.argv[1:]
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.sendto(b"\xff\xff\xff\xffrcon " + pw.encode() + b" map " + m.encode() + b"\n", (ip, 44400))
EOF
wait_for "SpawnServer: ${MAP}" 60 "the server to spawn ${MAP}"
deadline=$(( $(date +%s) + 60 ))
while [ "$(logs | grep -c "Gametype 'Race' initialized" || true)" -le "${before}" ]; do
    [ "$(date +%s)" -lt "${deadline}" ] || { echo "!! ${MAP} spawned but the gametype never initialised"; logs | tail -30; exit 1; }
    sleep 2
done
if logs | grep -qE "Couldn't find map|ERROR: .*${MAP}"; then
    echo "!! errors while loading ${MAP}"; logs | grep -E "Couldn't find map|ERROR" | tail; exit 1
fi
echo ">> PASS: ${MAP} was added at runtime and is running, no restart"
