#!/usr/bin/env python3
"""Make the engine's MOTD track sv_MOTDString live, per client request.

Stock Warsow snapshots sv_MOTDString/sv_MOTDFile into svs.motd only at server
init and map spawn (SV_MOTD_Update in sv_main.c / sv_init.c). Our gametype
sets sv_MOTDString at runtime from the central /api/game/motd (hrace/motd.as
via the RS_ApiFetchMotd native), so without this an MOTD edited in the web
admin would not show to connecting players until the next map change. Re-run
SV_MOTD_Update at the top of SV_MOTD_Get_f - the handler for the "svmotd"
command every connecting client sends - so each request reads the current
cvar. The update is a couple of string ops (no file I/O unless sv_MOTDFile is
set), so per-connect cost is nil.

Run from the qfusion source/ directory. Exits non-zero (failing the image
build) if the anchor is not found exactly once.
"""
import sys

PATH = "server/sv_motd.c"

# Fail fast if already applied (re-emitting the anchor would double-patch).
if "racesow-docker: live MOTD" in open(PATH, encoding="utf-8").read():
    sys.exit("FATAL: motd-live patch already applied to " + PATH)

src = open(PATH, encoding="utf-8").read()

# Insert after the local declaration (the tree builds as C89-friendly C; a
# statement before `int flag` would be a declaration-after-statement hazard
# in reverse - keep declarations first).
OLD = (
    "\tint flag = ( Cmd_Argc() > 1 ? 1 : 0 );\n"
    "\n"
    "\tif( sv_MOTD->integer && svs.motd && svs.motd[0] )\n"
)
NEW = (
    "\tint flag = ( Cmd_Argc() > 1 ? 1 : 0 );\n"
    "\n"
    "\t// racesow-docker: live MOTD - the gametype sets sv_MOTDString at\n"
    "\t// runtime from the central /api/game/motd, so refresh svs.motd on\n"
    "\t// every request instead of only at map spawn.\n"
    "\tSV_MOTD_Update();\n"
    "\n"
    "\tif( sv_MOTD->integer && svs.motd && svs.motd[0] )\n"
)

if src.count(OLD) != 1:
    sys.exit("FATAL: SV_MOTD_Get_f anchor not found exactly once in " + PATH)
open(PATH, "w", encoding="utf-8").write(src.replace(OLD, NEW))
print("patched: SV_MOTD_Get_f live cvar re-read")
print("motd-live patch applied")
