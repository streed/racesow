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

This script USED to also stub out `client.demoStart/demoStop/demoCancel`, which
Warfork's Client type did not have. It does now: the race-demo subsystem is
vendored into the engine as server/sv_racedemos.c and the three natives are
bound by warfork/enginepatches/patch-racedemo-natives.py, so the calls compile
and record for real. Nothing to neutralize any more.

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

    n_len = 0
    for path in as_files:
        with open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
            src = f.read()
        src, c1 = length_re.subn(".length()", src)
        n_len += c1
        if c1:
            with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
                f.write(src)

    print("patch-scripts-as2024.py: .length->.length() x%d" % n_len)
    # Guard: we expected to find both (a no-op run means the copy was wrong or the
    # scripts changed shape -- fail so the build doesn't silently ship unpatched).
    if n_len == 0:
        sys.exit("FATAL: no `.length` sites transformed -- wrong dir or scripts drifted?")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: patch-scripts-as2024.py <progs-dir>")
    main(sys.argv[1])
