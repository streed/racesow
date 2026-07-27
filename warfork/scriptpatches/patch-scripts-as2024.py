#!/usr/bin/env python3
"""
Warfork build-time adaptation of the SHARED racemod gametype scripts.

Our gametype (server/racemod/source/progs) is the SINGLE source of truth for
BOTH the Warsow and Warfork race servers (one codebase -> one unified
leaderboard; see docs/warfork-port-design.md). Warsow runs AngelScript 2.29.2;
Warfork runs a 2024-era AngelScript with a few incompatible API changes. Rather
than fork the scripts, the Warfork image COPIES them and runs this transform so
`server/racemod/source` stays byte-for-byte Warsow-compatible.

Transforms (each idempotent; run over a COPY of progs/, never the repo source):

 1. `.length` property -> `.length()` method.
    AS2.29 exposed array/string `length` as a property; AS2024 makes it a method,
    so `arr.length` raises "Invalid operation on method". 16 sites across
    accuracy.as / player.as / entityfinder.as. Safe: the racemod defines no
    custom `length`/`size` fields (verified), and `.length()` calls are skipped.

 2. Stub the per-client demo-capture calls.
    `client.demoStart/demoStop/demoCancel` are DenMSC-SDK Client methods Warsow
    inherits from its game module; Warfork's Client type has none ("No matching
    symbol 'demoStart'"). These drive the .wd WR-replay capture only — the ghost
    trajectory replay (RS_Ghost* natives) is independent and unaffected, and the
    RS_ApiReportWrDemo native already skips an empty/missing demo path. So we
    neutralize the 6 call statements to unblock compile; real per-client demo
    recording on Warfork is a follow-up (register the 3 Client natives).

Usage:  patch-scripts-as2024.py <progs-dir>
"""
import os
import re
import sys

def main(progs):
    as_files = []
    for root, _dirs, files in os.walk(progs):
        for fn in files:
            if fn.endswith(".as"):
                as_files.append(os.path.join(root, fn))
    if not as_files:
        sys.exit("FATAL: no .as files under %s" % progs)

    # 1. `.length` (not already a call) -> `.length()`
    length_re = re.compile(r"\.length\b(?!\s*\()")
    # 2. `<expr>.demo{Start,Stop,Cancel}( ... );`  (single-statement, no ';' in args)
    demo_re = re.compile(r"[A-Za-z_][\w.]*\.demo(?:Start|Stop|Cancel)\s*\([^;]*\)\s*;")

    n_len = n_demo = 0
    for path in as_files:
        with open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
            src = f.read()
        src, c1 = length_re.subn(".length()", src)
        # Replace with an empty BLOCK, not a bare `;`: several calls are the sole
        # unbraced body of an if/else, where `;` raises "If/Else with empty statement".
        src, c2 = demo_re.subn("{ /* warfork: demo capture stubbed (Client demo methods absent) */ }", src)
        n_len += c1
        n_demo += c2
        if c1 or c2:
            with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
                f.write(src)

    print("patch-scripts-as2024.py: .length->.length() x%d, demo stubs x%d" % (n_len, n_demo))
    # Guard: we expected to find both (a no-op run means the copy was wrong or the
    # scripts changed shape -- fail so the build doesn't silently ship unpatched).
    if n_len == 0:
        sys.exit("FATAL: no `.length` sites transformed -- wrong dir or scripts drifted?")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: patch-scripts-as2024.py <progs-dir>")
    main(sys.argv[1])
