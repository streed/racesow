#!/usr/bin/env python3
"""Hide mirror-bot ghosts from the getstatus / heartbeat player list.

Cross-server mirroring (g_rs_mirror.cpp / g_rs_mirrorbots.cpp) represents a
remote player as a real fake-client slot so it shows on the scoreboard and can
be spectated. But the engine's SV_LongInfoString includes every connected
client in the getstatus reply and the master-server heartbeat, so those ghosts
leak out as if they were real players on THIS server. The web live page then
shows the same player on two servers, and the browser player count is inflated.

This dedicated race server never spawns AI bots, so every SVF_FAKECLIENT slot is
a mirror ghost. Skip them in both the client count and the per-player rows so
getstatus reports only the real humans actually connected here. (TV clients are
handled separately and are unaffected.)

Run from the qfusion source/ directory. Exits non-zero (failing the image
build) if an anchor is not found exactly once.
"""
import sys

PATH = "server/sv_oob.c"

# Fail fast if already applied (re-emitting the anchor would double-patch).
if "racesow-docker: mirror-bot ghosts" in open(PATH, encoding="utf-8").read():
    sys.exit("FATAL: status hide-bots patch already applied to " + PATH)


def patch(src, old, new, what):
    if src.count(old) != 1:
        sys.exit("FATAL: %s anchor not found exactly once in %s" % (what, PATH))
    print("patched:", what)
    return src.replace(old, new)


src = open(PATH, encoding="utf-8").read()

# 1. client count loop: don't count mirror ghosts as bots or clients.
old_count = (
    "\t\t\tif( cl->edict->r.svflags & SVF_FAKECLIENT || cl->tvclient )\n"
    "\t\t\t\tbots++;\n"
    "\t\t\tcount++;\n"
)
new_count = (
    "\t\t\t// racesow-docker: mirror-bot ghosts represent players on OTHER mesh\n"
    "\t\t\t// servers; they are not real players here, so keep them out of the\n"
    "\t\t\t// status/heartbeat counts (this race server has no AI bots).\n"
    "\t\t\tif( cl->edict->r.svflags & SVF_FAKECLIENT )\n"
    "\t\t\t\tcontinue;\n"
    "\t\t\tif( cl->tvclient )\n"
    "\t\t\t\tbots++;\n"
    "\t\t\tcount++;\n"
)
src = patch(src, old_count, new_count, "count loop")

# 2. per-player row loop: don't emit a row for a mirror ghost.
old_row = (
    "\t\t\t\tQ_snprintfz( tempstr, sizeof( tempstr ), \"%i %i \\\"%s\\\" %i\\n\",\n"
)
new_row = (
    "\t\t\t\tif( cl->edict->r.svflags & SVF_FAKECLIENT )\n"
    "\t\t\t\t\tcontinue; // racesow-docker: hide mirror-bot ghosts (see count loop)\n"
    "\t\t\t\tQ_snprintfz( tempstr, sizeof( tempstr ), \"%i %i \\\"%s\\\" %i\\n\",\n"
)
src = patch(src, old_row, new_row, "player row loop")

open(PATH, "w", encoding="utf-8").write(src)
print("status hide-bots patch applied to", PATH)
