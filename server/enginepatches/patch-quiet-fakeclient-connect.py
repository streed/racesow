#!/usr/bin/env python3
"""Silence connect/disconnect console spam for fake-client infra bots.

This dedicated race server never spawns AI bots, so every SVF_FAKECLIENT slot is
one of OUR infra bots: the in-game WR ghost racer (hrace/ghostbot.as) and the
cross-server mesh mirror bots (g_rs_mirrorbots.cpp). Both are (re)created
constantly -- the WR ghost respawns whenever a map's record changes, and a
mirror bot connects/leaves as remote players come and go -- so the engine's
"<name> entered the game" (ClientBegin) and "<name> disconnected"
(ClientDisconnect) broadcasts flood every player's console with churn for
players who are not really here. Remote players are already announced ONCE, with
a [TAG] prefix, by the mesh relay (g_rs_mirror.cpp / hrace/mirror.as).

The engine already suppresses the "<name> connected" line for fake clients
(ClientConnect wraps it in `if( !fakeClient )`). It does NOT suppress the two
above unless the gametype sets level.gametype.disableObituaries, which this
race gametype leaves off. Tighten both guards to drop fake clients
unconditionally; real players' announces are unaffected (for a real client the
original `!disableObituaries || !fakeClient` is always true, and so is the new
`!fakeClient`).

Edits game/p_client.cpp. Run from the qfusion source/ directory. Exits non-zero
(failing the image build) if an anchor is not found exactly once. The anchors
are byte-identical in Warsow 2.1.2 (DenMSC/racemod_2.1) and Warfork 2.15.1
(TeamForbiddenLLC/warfork-qfusion), so this one script serves both engine builds.
"""
import sys

PATH = "game/p_client.cpp"

# Fail fast if already applied (re-emitting an anchor would double-patch).
if "racesow-docker: fake clients" in open(PATH, encoding="utf-8").read():
    sys.exit("FATAL: quiet-fakeclient-connect patch already applied to " + PATH)


def patch(src, old, new, what):
    if src.count(old) != 1:
        sys.exit("FATAL: %s anchor not found exactly once in %s" % (what, PATH))
    print("patched:", what)
    return src.replace(old, new)


src = open(PATH, encoding="utf-8").read()

# 1. ClientBegin: the non-mm_login "<name> entered the game" broadcast.
old_enter = (
    "\t\tif( !level.gametype.disableObituaries || !(ent->r.svflags & SVF_FAKECLIENT ) )\n"
    "\t\t\tG_PrintMsg( NULL, \"%s\" S_COLOR_WHITE \" entered the game\\n\", client->netname );\n"
)
new_enter = (
    "\t\t// racesow-docker: fake clients here are always infra (the WR ghost racer\n"
    "\t\t// and mesh mirror bots -- this race server runs no AI bots), re-created\n"
    "\t\t// every map/record; remote players are already announced once via the\n"
    "\t\t// tagged mesh relay, so never announce a fake client entering.\n"
    "\t\tif( !(ent->r.svflags & SVF_FAKECLIENT ) )\n"
    "\t\t\tG_PrintMsg( NULL, \"%s\" S_COLOR_WHITE \" entered the game\\n\", client->netname );\n"
)
src = patch(src, old_enter, new_enter, "ClientBegin entered-the-game guard")

# 2. ClientDisconnect: the "<name> disconnected" broadcast (both reason forms).
old_leave = (
    "\tif( !level.gametype.disableObituaries || !(ent->r.svflags & SVF_FAKECLIENT ) )\n"
    "\t{\n"
    "\t\tif( !reason )\n"
)
new_leave = (
    "\t// racesow-docker: never announce a fake client (infra: WR ghost + mesh\n"
    "\t// mirror bots) disconnecting -- see the ClientBegin note above.\n"
    "\tif( !(ent->r.svflags & SVF_FAKECLIENT ) )\n"
    "\t{\n"
    "\t\tif( !reason )\n"
)
src = patch(src, old_leave, new_leave, "ClientDisconnect disconnected guard")

open(PATH, "w", encoding="utf-8").write(src)
print("OK:", PATH)
