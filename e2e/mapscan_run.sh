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

IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${NAME}")"
echo ">> rcon map ${MAP}"
# While an rcon command runs, the engine redirects its console output into the
# rcon reply (qcommon/common.c, Com_BeginRedirect), and "map" spawns the new
# level inside that command. So "SpawnServer: <map>" and the gametype init come
# back over UDP and never reach docker logs. Read the spawn from the reply.
# The reply is ~1 KB datagrams of the whole script compile, so its tail is not
# something to wait on; getstatus is only answered once SV_Map has returned, so
# "mapname=<map>" with the race script's g_race_gametype=1 proves the spawn and
# the gametype init both finished.
python3 - "${IP}" "${RCON}" "${MAP}" <<'EOF'
import re, socket, sys, time
ip, pw, m = sys.argv[1:]
OOB = b"\xff\xff\xff\xff"
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.sendto(OOB + b"rcon " + pw.encode() + b" map " + m.encode() + b"\n", (ip, 44400))
reply, deadline = "", time.time() + 60
s.settimeout(15)
while time.time() < deadline:
    try:
        d = s.recvfrom(65535)[0]
    except socket.timeout:
        if reply:
            break
        continue
    if d.startswith(OOB + b"print\n"):
        reply += d[len(OOB) + 6:].decode("latin1", "replace")
reply = re.sub(r"\x1b\[[0-9;]*m", "", reply)
print("   | " + "\n   | ".join(l for l in reply.splitlines()
                              if "SpawnServer" in l or "initialized" in l or "ERROR" in l or "Couldn't" in l))
def fail(why):
    print("!! " + why); print(reply[-3000:]); sys.exit(1)
if "SpawnServer: " + m not in reply:
    fail("the rcon reply has no 'SpawnServer: %s'" % m)
if re.search(r"Couldn't find map|ERROR: .*" + re.escape(m), reply):
    fail("errors while loading %s" % m)

mapname, deadline = "?", time.time() + 30
while time.time() < deadline:
    try:
        s.sendto(OOB + b"getstatus\n", (ip, 44400))
        d = s.recvfrom(65535)[0]
        if not d.startswith(OOB + b"statusResponse"):
            continue   # a late fragment of the rcon reply
        kv = d.decode("latin1", "replace").split("\n")[1].split("\\")
        info = dict(zip(kv[1::2], kv[2::2]))
        mapname = info.get("mapname", "?")
        if mapname == m and info.get("g_race_gametype") == "1":
            break
    except (socket.timeout, IndexError):
        pass
    time.sleep(1)
else:
    fail("getstatus never showed %s with the race gametype up (last: mapname=%s)" % (m, mapname))
print(">> getstatus: mapname=%s gametype=%s g_race_gametype=1" % (mapname, info.get("gametype")))
EOF
[ "$(docker inspect -f '{{.State.Running}}' "${NAME}")" = "true" ] || { echo "!! the server died after the map change"; logs | tail -30; exit 1; }
echo ">> PASS: ${MAP} was added at runtime and is running, no restart"
