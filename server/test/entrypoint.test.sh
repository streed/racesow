#!/bin/sh
# Contract test for entrypoint.sh: environment variables must land in the
# generated env.cfg (rs_api_* included) and the launch arguments must exec
# server.cfg then env.cfg before +map. Runs the real entrypoint against a
# sandbox WARSOW_DIR with a fake wsw_server binary that records its argv.
#
#   sh server/test/entrypoint.test.sh
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ENTRYPOINT="${HERE}/../entrypoint.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT INT TERM

fail() { echo "FAIL: $*" >&2; exit 1; }

sandbox() {
    # Fresh fake Warsow install; returns its path on stdout.
    box="${TMP}/warsow-$1"
    mkdir -p "${box}/racemod/configs/server" "${box}/basewsw"
    cat > "${box}/wsw_server.x86_64" <<EOF
#!/bin/sh
printf '%s\n' "\$@" > "${box}/launch-args.txt"
exit 0
EOF
    chmod +x "${box}/wsw_server.x86_64"
    echo "${box}"
}

run_entrypoint() {
    # First loop iteration launches the fake server, which exits immediately;
    # kill the restart loop during its 5s sleep. timeout's 124 is expected.
    box="$1"; shift
    env -i PATH="${PATH}" HOME="${HOME}" WARSOW_DIR="${box}" "$@" \
        timeout 3 sh "${ENTRYPOINT}" > "${box}/entrypoint.log" 2>&1 || true
    [ -f "${box}/launch-args.txt" ] || {
        cat "${box}/entrypoint.log" >&2
        fail "fake wsw_server was never launched"
    }
}

# --- Case 1: full stats reporting configuration ------------------------------
BOX="$(sandbox full)"
run_entrypoint "${BOX}" \
    SV_HOSTNAME="Test Race Server" \
    INGEST_URL="http://web:8080/api/ingest" \
    INGEST_TOKEN="sekrit-token" \
    VERSION_NAME="wsw 2.1-test" \
    RCON_PASSWORD="rc0n"

CFG="${BOX}/racemod/configs/server/env.cfg"
[ -f "${CFG}" ] || fail "env.cfg was not generated"

grep -qx 'set rs_api_url "http://web:8080/api/ingest"' "${CFG}" || fail "rs_api_url missing from env.cfg"
grep -qx 'set rs_api_token "sekrit-token"'             "${CFG}" || fail "rs_api_token missing from env.cfg"
grep -qx 'set rs_api_version "wsw 2.1-test"'           "${CFG}" || fail "rs_api_version missing from env.cfg"
grep -qx 'set sv_hostname "Test Race Server"'          "${CFG}" || fail "sv_hostname missing from env.cfg"
grep -qx 'set rcon_password "rc0n"'                    "${CFG}" || fail "rcon_password missing from env.cfg"

ARGS="${BOX}/launch-args.txt"
# server.cfg must exec before env.cfg so environment values win overlaps.
srv_line="$(grep -n '^configs/server/server.cfg$' "${ARGS}" | cut -d: -f1)"
env_line="$(grep -n '^configs/server/env.cfg$' "${ARGS}" | cut -d: -f1)"
[ -n "${srv_line}" ] || fail "+exec server.cfg not in launch args"
[ -n "${env_line}" ] || fail "+exec env.cfg not in launch args"
[ "${srv_line}" -lt "${env_line}" ] || fail "env.cfg must exec after server.cfg"
# +map comes last, after both execs.
map_line="$(grep -n '^+map$' "${ARGS}" | cut -d: -f1)"
[ -n "${map_line}" ] && [ "${env_line}" -lt "${map_line}" ] || fail "+map must come after +exec env.cfg"
# Secrets stay out of argv (visible in `ps`): only env.cfg carries them.
grep -q 'sekrit-token' "${ARGS}" && fail "ingest token leaked onto the command line"
grep -q 'rc0n' "${ARGS}" && fail "rcon password leaked onto the command line"

# The racelog/topscores dirs the mod writes to are pre-created.
[ -f "${BOX}/racemod/racelog/events.log" ] || fail "racelog/events.log not pre-created"
[ -d "${BOX}/racemod/topscores/race" ]     || fail "topscores/race not pre-created"

# --- Case 2: no INGEST_URL -> no rs_api_* cvars at all ------------------------
BOX2="$(sandbox plain)"
run_entrypoint "${BOX2}"
CFG2="${BOX2}/racemod/configs/server/env.cfg"
[ -f "${CFG2}" ] || fail "env.cfg was not generated (plain case)"
grep -q 'rs_api' "${CFG2}" && fail "rs_api_* must be absent when INGEST_URL is unset"

echo "OK: entrypoint contract tests passed"
