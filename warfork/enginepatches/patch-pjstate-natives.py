#!/usr/bin/env python3
"""
Warfork port: wire the racesow base projectile / prejump-state natives into the
stock warfork-qfusion game module.

Vanilla Warfork's game module has NONE of the racesow natives our hrace gametype
calls; it ships only a global `G_RemoveAllProjectiles()`. This patch adds the
three our scripts require, sourced from Gelmo/warfork-racemod (see UPSTREAM):

  RS_QueryPjState(int)->bool   RS_ResetPjState(int)->bool   (gs_racesow.c)
  G_RemoveProjectiles(Entity@) -> RS_removeProjectiles(owner) (g_racesow.cpp,
                                  owner-filtered, unlike stock RemoveAllProjectiles)

The two impl translation units (g_racesow.{cpp,h}, gs_racesow.{c,h}) are COPY'd
into source/game and source/gameshared by the Dockerfile (the CMake globs
game/*.cpp + gameshared/*.c, so they compile automatically). This script only
wires the includes + the AngelScript bindings.

CRUCIAL ORDERING: this runs BEFORE patch-api-natives.py / patch-mirror-natives.py,
because those anchor on the `{ "bool RS_ResetPjState( int playerNum )", ... }`
asGlobFuncs entry this patch creates (byte-identical to the DenMSC/Warsow anchor,
so our existing patches apply unchanged).

The gs_pmove.c RS_Increment{Jumps,Dashes,WallJumps} hooks that actually FEED
RS_QueryPjState live in patch-pjcount-hooks.py — run it after this script (it
needs the gs_public.h include added below). They were deferred at port time,
which left the prejump rule unenforced on Warfork until 2026-07-30.

DEFERRED (not needed to compile the gametype, so not done here):
  - wiring g_racesow.cpp's rs_* weapon-def cvars into weapon firing (physics parity).

Run from source/ (cwd = warfork-qfusion/source). Fails loudly if any anchor is
not found exactly once.
"""
import sys

def patch(path, old, new, what):
    with open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
        src = f.read()
    n = src.count(old)
    if n != 1:
        sys.exit("FATAL: %s anchor found %d times (expected 1) in %s" % (what, n, path))
    with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
        f.write(src.replace(old, new))

# --- 1. make the prejump-state natives visible module-wide (as Gelmo does) ----
GS_PUBLIC_ANCHOR = '#include "gs_ref.h"\n'
patch("gameshared/gs_public.h",
      GS_PUBLIC_ANCHOR,
      GS_PUBLIC_ANCHOR + '#include "gs_racesow.h" // racesow\n',
      "gs_public.h gs_racesow include")

# --- 2. make RS_removeProjectiles + weapon-def externs visible to the game -----
GLOCAL_ANCHOR = '#include "../matchmaker/mm_rating.h"\n'
patch("game/g_local.h",
      GLOCAL_ANCHOR,
      GLOCAL_ANCHOR + '// racesow\n#include "g_racesow.h"\n// !racesow\n',
      "g_local.h g_racesow include")

# --- 3. AngelScript wrappers (inserted just before the global function table) --
TABLE_ANCHOR = "static const asglobfuncs_t asGlobFuncs[] =\n"
WRAPPERS = (
    "// racesow: base projectile / prejump-state natives (see warfork/enginepatches)\n"
    "static void asFunc_RS_removeProjectiles( edict_t *owner )\n"
    "{\n"
    "\tRS_removeProjectiles( owner );\n"
    "}\n"
    "\n"
    "static bool asFunc_RS_QueryPjState( int playerNum )\n"
    "{\n"
    "\tif( RS_QueryPjState( playerNum ) )\n"
    "\t\treturn true;\n"
    "\treturn false;\n"
    "}\n"
    "\n"
    "static bool asFunc_RS_ResetPjState( int playerNum )\n"
    "{\n"
    "\tRS_ResetPjState( playerNum );\n"
    "\treturn true;\n"
    "}\n"
    "\n"
)
patch("game/g_ascript.cpp", TABLE_ANCHOR, WRAPPERS + TABLE_ANCHOR, "asFunc pjstate wrappers")

# --- 4. asGlobFuncs table entries ---------------------------------------------
# The two pj entries go at the top of the table (this creates the RS_ResetPjState
# entry line our api/mirror patches anchor on). Re-emit the following stock entry
# so the anchor stays unique.
ENTRY_ANCHOR = '\t{ "Entity @G_SpawnEntity( const String &in )", asFUNCTION(asFunc_G_Spawn), NULL },\n'
PJ_ENTRIES = (
    "\t// racesow\n"
    '\t{ "bool RS_QueryPjState( int playerNum )", asFUNCTION(asFunc_RS_QueryPjState), NULL },\n'
    '\t{ "bool RS_ResetPjState( int playerNum )", asFUNCTION(asFunc_RS_ResetPjState), NULL },\n'
    "\t// !racesow\n"
)
patch("game/g_ascript.cpp", ENTRY_ANCHOR, PJ_ENTRIES + ENTRY_ANCHOR, "asGlobFuncs pjstate entries")

# Owner-filtered G_RemoveProjectiles(Entity@) alongside the stock RemoveAllProjectiles.
REMOVE_ANCHOR = '\t{ "void G_RemoveAllProjectiles()", asFUNCTION(asFunc_G_Match_RemoveAllProjectiles), NULL },\n'
patch("game/g_ascript.cpp",
      REMOVE_ANCHOR,
      REMOVE_ANCHOR + '\t{ "void G_RemoveProjectiles( Entity @ )", asFUNCTION(asFunc_RS_removeProjectiles), NULL }, // racesow\n',
      "G_RemoveProjectiles entry")

print("patch-pjstate-natives.py: OK (gs_public.h, g_local.h, g_ascript.cpp x3)")
