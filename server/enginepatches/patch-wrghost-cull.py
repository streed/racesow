#!/usr/bin/env python3
"""Per-client visibility for the in-game world-record ghost racer.

The WR ghost (hrace/ghostbot.as, driven through the mirror-bot natives in
g_rs_mirrorbots.cpp) is a force-visible fake-client entity carrying
EF_RACEGHOST. The stock Warsow 2.1.2 client renders it as a translucent shell
whose only client-side control is cg_raceGhostsAlpha (setting it to 0 hides ALL
race ghosts, mesh ones included); cg_raceGhosts only affects projectiles, so it
cannot hide the player-model ghost. To let a player hide JUST the WR ghost for
themselves — the "wrghost off" command — we cull it per client, server-side.

qfusion's snapshot builder already supports per-client entity filtering via
svflags (SVF_ONLYTEAM / SVF_ONLYOWNER, read in SNAP_SnapCullEntity), but none of
the existing flags express "hide this one entity from this one client". So we
add two server-only booleans to entity_shared_t:

  * rs_isWrGhost   - set on the WR ghost's edict each frame (g_rs_mirrorbots.cpp)
  * rs_hideWrGhost - set on a viewing client's edict by RS_SetHideWrGhost

and one check in SNAP_SnapCullEntity: cull the WR ghost from a client that opted
out. entity_shared_t is the server<->game shared block (NOT networked — only
entity_state_t is), so this is invisible to stock clients and changes no wire
format; the game module and the dedicated server are both rebuilt from this same
patched tree, so they agree on the struct layout.

Run from the qfusion source/ directory, BEFORE the game-module build (so
g_public.h is patched for game/*.cpp) and before the dedicated-server build (so
qcommon/snap_write.c is patched). Exits non-zero (failing the image build) if
any anchor is not found exactly once — including a re-run, since each insertion
re-emits its anchor.
"""
import sys

# Fail fast if already applied: a naive re-run would duplicate the struct fields
# (a redefinition -> compile error) and the cull block.
for _p, _marker in [("game/g_public.h", "rs_isWrGhost"),
                    ("qcommon/snap_write.c", "rs_hideWrGhost")]:
    if _marker in open(_p, encoding="utf-8").read():
        sys.exit("FATAL: wrghost-cull patch already applied (%s in %s)" % (_marker, _p))


def patch(path, old, new, what):
    src = open(path, encoding="utf-8").read()
    if src.count(old) != 1:
        sys.exit("FATAL: %s anchor not found exactly once in %s" % (what, path))
    open(path, "w", encoding="utf-8").write(src.replace(old, new))
    print("patched:", what)


# --- 1. two server-only booleans at the end of entity_shared_t ---------------
# entity_shared_t is defined once; its closing line is a unique, stable anchor.
STRUCT_CLOSE = "} entity_shared_t;"
STRUCT_FIELDS = (
    "\t// racesow-docker: per-client world-record ghost visibility (see\n"
    "\t// g_rs_mirrorbots.cpp + SNAP_SnapCullEntity in qcommon/snap_write.c).\n"
    "\t// rs_isWrGhost marks the WR ghost racer's fake-client edict; a viewing\n"
    "\t// client whose rs_hideWrGhost is set does not receive that entity in its\n"
    "\t// snapshot (\"wrghost off\"). Server-only fields - entity_shared_t is never\n"
    "\t// networked - so stock 2.1.2 clients and the wire format are unaffected.\n"
    "\tbool rs_isWrGhost;\n"
    "\tbool rs_hideWrGhost;\n"
) + STRUCT_CLOSE
patch("game/g_public.h", STRUCT_CLOSE, STRUCT_FIELDS, "entity_shared_t WR-ghost fields")

# --- 2. cull the WR ghost from an opted-out client's snapshot -----------------
# Insert right after the existing SVF_NOCLIENT filter at the top of
# SNAP_SnapCullEntity, so the opt-out wins even for allentities frames (e.g. the
# player's own demo). The anchor is that filter, verbatim (typo included).
CULL_ANCHOR = (
    "\t// filters: this entity has been disabled for comunication\n"
    "\tif( ent->r.svflags & SVF_NOCLIENT )\n"
    "\t\treturn true;\n"
)
CULL_BLOCK = CULL_ANCHOR + (
    "\n"
    "\t// racesow-docker: per-client WR ghost opt-out. The in-game WR ghost racer\n"
    "\t// (hrace/ghostbot.as) is force-transmitted to everyone, but a player who\n"
    "\t// ran \"wrghost off\" sets rs_hideWrGhost on their client edict to race\n"
    "\t// without it. Cull the WR ghost entity from just that client's snapshot;\n"
    "\t// the scoreboard entry (a configstring) is unaffected and every other\n"
    "\t// viewer still sees it. See RS_SetHideWrGhost in g_rs_mirrorbots.cpp.\n"
    "\tif( ent->r.rs_isWrGhost && clent && clent->r.rs_hideWrGhost )\n"
    "\t\treturn true;\n"
)
patch("qcommon/snap_write.c", CULL_ANCHOR, CULL_BLOCK, "SNAP_SnapCullEntity WR-ghost cull")

print("wrghost-cull patch applied")
