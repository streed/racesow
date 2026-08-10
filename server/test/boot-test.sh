#!/usr/bin/env bash
# boot-test.sh — prove a game image's gametype actually COMPILES and initialises.
#
# WHY THIS EXISTS. The racemod is AngelScript, and AngelScript compiles at
# SERVER BOOT, not at docker build. `docker build` succeeding proves only that
# the .as files got zipped into a pk3 — a syntax error, a call to a function
# that no listed section defines, or a native the engine never registered all
# sail through the build and then fail at map load. On a production node that is
# a server that starts, prints an ERROR, and never runs a gametype:
#
#   ERROR:
#   hrace.as 666:5: No matching signatures to 'RACE_ApiMotdThink()'
#
# That is exactly the failure the base/site split will produce over and over
# while the hook layer is being wired up, which is why this harness comes first:
# without it, "it built" is mistaken for "it works" and the mistake is only
# found in production.
#
# Warsow's AngelScript (2.29) is STRICTER than Warfork's (AS2024) — a bad
# ternary or an implicit conversion can pass Warfork and fail Warsow. So when
# testing both, ALWAYS boot Warsow first; a green Warfork run means little.
#
# Usage:
#   server/test/boot-test.sh <image> [--map <map>] [--name <container>]
#                            [--timeout <sec>] [--expect-fail] [--keep]
#
#   --expect-fail  invert the verdict: the run PASSES only if the gametype
#                  fails to initialise. Used to prove a negative — e.g. that
#                  gating a section out really does break its callers, so that
#                  a later "it boots" is meaningful rather than vacuous.
#
# Exit: 0 = gametype initialised with no script diagnostics, 1 = otherwise.
set -uo pipefail

IMAGE="" MAP="wbomb1" NAME="" TIMEOUT=240 EXPECT_FAIL=0 KEEP=0
while [ $# -gt 0 ]; do
    case "$1" in
        --map)     MAP="$2"; shift 2 ;;
        --name)    NAME="$2"; shift 2 ;;
        --timeout) TIMEOUT="$2"; shift 2 ;;
        --expect-fail) EXPECT_FAIL=1; shift ;;
        --keep)    KEEP=1; shift ;;
        -*)        echo "unknown flag: $1" >&2; exit 2 ;;
        *)         IMAGE="$1"; shift ;;
    esac
done
[ -n "${IMAGE}" ] || { echo "usage: $0 <image> [--map m] [--expect-fail]" >&2; exit 2; }
[ -n "${NAME}" ]  || NAME="boottest-$$"

cleanup() { [ "${KEEP}" = "1" ] || docker rm -f "${NAME}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo ">> booting ${IMAGE} on ${MAP} (container ${NAME}, timeout ${TIMEOUT}s)"
# --tty so the engine line-buffers stdout (same reason docker-compose.yml sets
# it); without it the logs arrive in blocks and the poll below reads nothing.
# SV_PUBLIC=0 keeps a test container off the master server list.
docker run -d --name "${NAME}" --tty -e SV_PUBLIC=0 \
    --ulimit nofile=16384:16384 "${IMAGE}" +map "${MAP}" >/dev/null || {
    echo "!! docker run failed"; exit 1; }

# Benign noise that must never count as a failure. Two classes: things the
# engine always says in a container (no Steam, no navmesh, no outbound UDP), and
# — the subtle one — pk3 FILENAMES that happen to contain "terror", which a
# naive grep for "error" reports as a compile error on every single boot.
BENIGN='AI FAILED to load navigation|AI Navigation Initialized|NET_SendPacket|sendto|heartbeat|steamshim|Steam initialization|Loading Steam module|Autoupdate is not available|terror|Error: no error'

# An AngelScript diagnostic. The compiler prints "<file>.as <line>:<col>: <msg>";
# the surrounding "ERROR:" line carries no detail, so match the shapes too.
ASERR='No matching signatures|Compilation failed|Expected .*expression|is not a data type|Illegal|Invalid (operation|type)|Cannot|Ambiguous|already declared|not declared|\.as [0-9]+:[0-9]+:|Script .*failed|GT_.*not found'

deadline=$(( $(date +%s) + TIMEOUT ))
result="timeout"
while [ "$(date +%s)" -lt "${deadline}" ]; do
    logs="$(docker logs "${NAME}" 2>&1)"
    if printf '%s' "${logs}" | grep -qE "${ASERR}" ; then result="scripterror"; break; fi
    if printf '%s' "${logs}" | grep -q "Gametype 'Race' initialized" ; then result="ok"; break; fi
    # The container dying is terminal — keep waiting and we would just burn the
    # whole timeout on a corpse.
    if [ "$(docker inspect -f '{{.State.Running}}' "${NAME}" 2>/dev/null)" != "true" ]; then
        result="exited"; break
    fi
    sleep 3
done

logs="$(docker logs "${NAME}" 2>&1)"
diags="$(printf '%s' "${logs}" | grep -E "${ASERR}" | grep -vE "${BENIGN}" | head -20)"
other="$(printf '%s' "${logs}" | grep -iE '^.*(ERROR|FATAL)' | grep -vE "${BENIGN}" | head -10)"

echo ">> result: ${result}"
[ -n "${diags}" ] && { echo ">> script diagnostics:"; printf '%s\n' "${diags}" | sed 's/^/     /'; }
[ -z "${diags}" ] && [ -n "${other}" ] && { echo ">> other error lines:"; printf '%s\n' "${other}" | sed 's/^/     /'; }

# A boot counts as good only if the gametype initialised AND nothing printed a
# script diagnostic. Both conditions matter: the engine happily carries on after
# some script errors, so "initialized" alone is not sufficient evidence.
good=0
[ "${result}" = "ok" ] && [ -z "${diags}" ] && good=1

if [ "${EXPECT_FAIL}" = "1" ]; then
    if [ "${good}" = "1" ]; then
        echo "!! FAIL: expected the gametype NOT to initialise, but it did cleanly"
        exit 1
    fi
    echo ">> PASS (expected failure): ${result}"
    exit 0
fi

if [ "${good}" = "1" ]; then
    echo ">> PASS: gametype initialised, no script diagnostics"
    exit 0
fi
echo "!! FAIL: gametype did not initialise cleanly (${result})"
[ "${result}" = "timeout" ] && printf '%s\n' "${logs}" | tail -25 | sed 's/^/     /'
exit 1
