#!/bin/sh
# Build the mesh module (g_rs_mirror.cpp) under AddressSanitizer +
# UndefinedBehaviorSanitizer and blast the REAL receive/parse path with
# malformed, boundary, and structured-but-hostile UDP datagrams. A memory
# error (OOB read/write, overflow) or UB aborts the target with a nonzero
# exit; a clean exit means the parser survived the corpus.
#
#   sh e2e/mirror_fuzz_run.sh [iterations] [seconds]
#
# The target runs in no-secret (source-IP allowlist) mode with 127.0.0.1 as its
# only peer, so every datagram the fuzzer sends from 127.0.0.1 passes auth and
# reaches the full header + body parser. The final line reports coverage:
# rowTouches>0 proves the state-body parser ran on accepted input, events>0 the
# event-body parser — not just the reject paths.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
MODULE="${HERE}/../server/enginepatches/g_rs_mirror.cpp"
ITERS="${1:-300000}"
SECS="${2:-16}"
PORT="${MIRROR_FUZZ_PORT:-46010}"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT INT TERM

echo ">> building fuzz target (ASan + UBSan)"
g++ -std=c++11 -fsanitize=address,undefined -fno-sanitize-recover=all -O1 -g -pthread \
    -o "${TMP}/target" "${HERE}/mirror_fuzz_target.cpp" "${MODULE}"

echo ">> fuzzing 127.0.0.1:${PORT} — ${ITERS} datagrams, ${SECS}s"
ASAN_OPTIONS=abort_on_error=1:halt_on_error=1 \
UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 \
    "${TMP}/target" "${PORT}" "${SECS}" > "${TMP}/target.log" 2>&1 &
TPID=$!

sleep 1
python3 "${HERE}/mirror_fuzz.py" "${PORT}" "${ITERS}" > "${TMP}/send.log" 2>&1 || true

if wait "${TPID}"; then
    grep -E 'clean exit|dropped [0-9]+ ' "${TMP}/target.log" | tail -2
    echo "OK: mesh parser survived $(grep -o 'sent [0-9]*' "${TMP}/send.log") datagrams under ASan+UBSan"
else
    echo "FAIL: sanitizer aborted — see below" >&2
    tail -40 "${TMP}/target.log" >&2
    exit 1
fi
