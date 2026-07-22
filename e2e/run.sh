#!/bin/sh
# ---------------------------------------------------------------------------
# Full end-to-end test of the race reporting pipeline, minus only the game
# engine itself:
#
#   RS_ApiReportRace (the REAL g_rs_api.cpp, compiled here)
#     -> HTTP POST /api/ingest (the real web/server.js on a fresh SQLite DB)
#       -> attempts (run_tally), PRs (race), checkpoints
#         -> the API the site renders: leaderboard for all players, WR splits,
#            perfect run (best possible split time), player PRs.
#
# Phase A: a player sets a PR over three attempts; a second player joins.
# Phase B: a finish is reported WHILE THE SERVER IS DOWN; the native's retry
#          queue must deliver it once the server is back.
#
# Requirements: g++, libcurl headers, node >= 18 (web/node_modules installed).
#   sh e2e/run.sh
# ---------------------------------------------------------------------------
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"

TMP="$(mktemp -d)"
SERVER_PID=""

# A throwaway PostgreSQL database for this run (the web app is pg-backed now).
# It persists across the phase-B kill/restart so the retry-queue delivery is
# still exercised, and is dropped on exit. Point E2E_PG_URL at any owner
# connection; defaults to the dev/CI test instance on :5433.
ADMIN_PG_URL="${E2E_PG_URL:-${TEST_PG_URL:-postgres://racesow:racesow@127.0.0.1:5433/racesow}}"
E2E_DB="e2e_$$_$(date +%s 2>/dev/null || echo 0)"
psql_admin() { psql "${ADMIN_PG_URL}" -v ON_ERROR_STOP=1 -qtA "$@"; }

cleanup() {
    [ -n "${SERVER_PID}" ] && kill "${SERVER_PID}" 2>/dev/null || true
    psql_admin -c "DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)" >/dev/null 2>&1 || true
    rm -rf "${TMP}"
}
trap cleanup EXIT INT TERM

command -v psql >/dev/null 2>&1 || { echo "psql not found (install postgresql-client)" >&2; exit 1; }
psql_admin -c "SELECT 1" >/dev/null 2>&1 \
    || { echo "cannot reach PostgreSQL at ${ADMIN_PG_URL}" >&2; exit 1; }
psql_admin -c "CREATE DATABASE ${E2E_DB}" >/dev/null
DATABASE_URL="$(printf '%s' "${ADMIN_PG_URL}" | sed "s#/[^/]*\$#/${E2E_DB}#")"

PORT="$(( 20000 + $$ % 10000 ))"
BASE="http://127.0.0.1:${PORT}"
TOKEN="e2e-ingest-token"
VERSION="wsw 2.1"

step() { echo ""; echo "== $*"; }

# --- Build the harness around the real native --------------------------------
step "compiling report harness (real g_rs_api.cpp + libcurl)"
g++ -std=c++11 -Wall -Wextra -o "${TMP}/harness" \
    "${HERE}/report_harness.cpp" \
    "${ROOT}/server/enginepatches/g_rs_api.cpp" \
    -lcurl -lpthread

start_server() {
    DATABASE_URL="${DATABASE_URL}" PORT="${PORT}" INGEST_TOKEN="${TOKEN}" \
        node "${ROOT}/web/server.js" > "${TMP}/server.log" 2>&1 &
    SERVER_PID=$!
    i=0
    while ! curl -fsS "${BASE}/api/health" > /dev/null 2>&1; do
        i=$((i + 1))
        [ "${i}" -gt 100 ] && { cat "${TMP}/server.log" >&2; echo "server did not start" >&2; exit 1; }
        sleep 0.1
    done
}

# --- Phase A: normal play ----------------------------------------------------
# Nova: three attempts, PR on the second. Wave: one finish. Colour-coded names
# exercise the full name pipeline. Fields: map, name, login, timeMs, cps-csv.
step "phase A: server up, 4 finishes reported through the native"
start_server

# 6th column: race starts since the player's last flush (Nova restarted a few
# times before finishing; totals asserted in assert.mjs).
"${TMP}/harness" "${BASE}/api/ingest" "${TOKEN}" "${VERSION}" <<'EOF'
testrace	^1No^7va		52000	11000,30000	2	5	3	1	0
testrace	^1No^7va		48000	10000,28000	1	4	2	0	1
testrace	^1No^7va		50000	10500,29000	3	6	4	0	2
testrace	^4Wa^5ve		49000	9800,27500	2	7	1	2	0
EOF

step "phase A: standalone attempt flush (starts with no finish, e.g. disconnect)"
curl -fsS -X POST "${BASE}/api/ingest" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    -d '{"version":"wsw 2.1","map":"testrace","source":"racelog","attempts":[{"name":"^4Wa^5ve","login":"","count":4,"wall_jumps":1,"dashes":0,"prejump_failures":0,"restarts":3}]}' \
    > /dev/null

step "phase A: asserting attempts, PRs, leaderboard, WR splits, perfect run"
node "${HERE}/assert.mjs" "${BASE}" phaseA

# --- Phase B: report while the server is down (retry path) -------------------
step "phase B: server DOWN, Wave sets a 47.0 PR; native must retry"
kill "${SERVER_PID}"
wait "${SERVER_PID}" 2>/dev/null || true
SERVER_PID=""

# Queue the report against the dead server in the background; g_rs_api retries
# (up to 3 attempts, 2s apart) while we bring the server back up. The linger
# keeps the harness alive through the retry window, as a real game server
# would be — shutdown drains the queue with the pacing disabled.
"${TMP}/harness" "${BASE}/api/ingest" "${TOKEN}" "${VERSION}" 8 <<'EOF' &
testrace	^4Wa^5ve		47000	9500,27000
EOF
HARNESS_PID=$!

sleep 0.5
start_server
wait "${HARNESS_PID}"

step "phase B: asserting the retried finish landed (new WR, updated perfect run)"
node "${HERE}/assert.mjs" "${BASE}" phaseB

# --- Phase C: live top scores back into the game -----------------------------
# The reverse direction: RS_ApiFetchTop pulls /api/game/topscores and swaps it
# into the map's topscores file, byte-format identical to what the gametype's
# RACE_LoadTopScores parses — records reported by ANY server come back to ALL.
step "phase C: compiling top-fetch harness (real g_rs_api.cpp)"
g++ -std=c++11 -Wall -Wextra -o "${TMP}/topfetch" \
    "${HERE}/topfetch_harness.cpp" \
    "${ROOT}/server/enginepatches/g_rs_api.cpp" \
    -lcurl -lpthread

step "phase C: fetching live top scores for 'testrace' through the native"
mkdir -p "${TMP}/wsw/racemod/topscores/race"
WARSOW_DIR="${TMP}/wsw" FS_GAME="racemod" \
    "${TMP}/topfetch" "${BASE}/api/game/topscores" "" testrace 10

TOPFILE="${TMP}/wsw/racemod/topscores/race/testrace.txt"
[ -s "${TOPFILE}" ] || { echo "FAIL: ${TOPFILE} not written" >&2; exit 1; }
head -1 "${TOPFILE}" | grep -qx "//testrace top scores" \
    || { echo "FAIL: bad header" >&2; cat "${TOPFILE}"; exit 1; }
# Exact loader format ("time" "name" "numSectors" "cp..." with absolute sector
# times): Wave's phase-B 47.0 WR first, then Nova's 48.0 PR.
grep -qF '"47000" "^4Wa^5ve" "2" "9500" "27000" ' "${TOPFILE}" \
    || { echo "FAIL: WR line missing or misformatted" >&2; cat "${TOPFILE}"; exit 1; }
grep -qF '"48000" "^1No^7va" "2" "10000" "28000" ' "${TOPFILE}" \
    || { echo "FAIL: PR line missing or misformatted" >&2; cat "${TOPFILE}"; exit 1; }
# best-per-player only: Nova's slower 52.0 / 50.0 attempts must not appear
[ "$(grep -cF '"^1No^7va"' "${TOPFILE}")" = "1" ] \
    || { echo "FAIL: duplicate rows for one player" >&2; cat "${TOPFILE}"; exit 1; }
sed 's/^/   /' "${TOPFILE}"

step "phase C: unknown map must fail the poll and write nothing"
if WARSOW_DIR="${TMP}/wsw" FS_GAME="racemod" \
    "${TMP}/topfetch" "${BASE}/api/game/topscores" "" nosuchmap 10; then
    echo "FAIL: fetch for an unknown map reported success" >&2; exit 1
fi
[ ! -e "${TMP}/wsw/racemod/topscores/race/nosuchmap.txt" ] \
    || { echo "FAIL: file written for an unknown map" >&2; exit 1; }

step "phase C: GET retry — fetch starts against a DOWN server, must recover"
kill "${SERVER_PID}"
wait "${SERVER_PID}" 2>/dev/null || true
SERVER_PID=""
rm -f "${TOPFILE}"
WARSOW_DIR="${TMP}/wsw" FS_GAME="racemod" \
    "${TMP}/topfetch" "${BASE}/api/game/topscores" "" testrace 15 &
TOPFETCH_PID=$!
sleep 0.5
start_server
wait "${TOPFETCH_PID}" \
    || { echo "FAIL: fetch did not recover once the server came back" >&2; exit 1; }
grep -qF '"47000" "^4Wa^5ve" "2" "9500" "27000" ' "${TOPFILE}" \
    || { echo "FAIL: recovered fetch wrote wrong content" >&2; cat "${TOPFILE}"; exit 1; }

step "phase C: retry exhaustion — unreachable API must signal -1, write nothing"
rc=0
WARSOW_DIR="${TMP}/wsw" FS_GAME="racemod" \
    "${TMP}/topfetch" "http://127.0.0.1:1/api/game/topscores" "" ghostmap 20 || rc=$?
[ "${rc}" = "2" ] \
    || { echo "FAIL: expected exhaustion (exit 2), got rc=${rc}" >&2; exit 1; }
[ ! -e "${TMP}/wsw/racemod/topscores/race/ghostmap.txt" ] \
    || { echo "FAIL: file written despite unreachable API" >&2; exit 1; }

echo ""
echo "OK: end-to-end pipeline test passed"
