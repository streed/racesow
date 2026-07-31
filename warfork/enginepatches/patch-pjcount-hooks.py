#!/usr/bin/env python3
"""
Warfork port: wire the racesow prejump COUNTERS into gs_pmove.c.

patch-pjstate-natives.py binds RS_QueryPjState/RS_ResetPjState so the hrace
gametype compiles, but nothing ever incremented pj_jumps/pj_dashes/pj_walljumps
-- so RS_QueryPjState() always returned false and the prejump rule (max 1 jump,
1 dash, 1 walljump before crossing the start line, see player.as startRace) was
silently unenforced on the Warfork servers. Warsow gets these hooks for free
because its game module is built from DenMSC/racemod_2.1, which already carries
them; vanilla warfork-qfusion does not.

Four insertions, byte-for-byte the ones DenMSC/racemod_2.1 (and Gelmo's Warfork
port of it) make -- so Warfork prejump behaviour matches Warsow exactly:

  PM_Move        - reset all three counters while walking on the ground below
                   DEFAULT_PLAYERSPEED_RACE + 5 (this is what makes the rule
                   "one of each between touching the ground and the start line")
  PM_Jump        - RS_IncrementJumps on the two real-jump branches (NOT on the
                   >100ups EV_DOUBLEJUMP branch -- upstream parity)
  PM_CheckDash   - RS_IncrementDashes once a dash actually fires
  PM_CheckWallJump - RS_IncrementWallJumps on a successful (non-stunned) wj

gs_pmove.c and gs_racesow.c are both globbed into the game module by
source/game/CMakeLists.txt ("../gameshared/*.c"), so the counters pmove writes
and the ones the AngelScript native reads are the same objects. The server
target only globs gameshared/q_*.c, so it neither needs nor gets them.

Ordering: independent of the other patch scripts (nothing else touches
gs_pmove.c), but it requires patch-pjstate-natives.py's gs_public.h include so
the RS_* prototypes are visible. Run it after that one.

Run from source/ (cwd = warfork-qfusion/source). Fails loudly if any anchor is
not found exactly once.
"""
import sys

PMOVE = "gameshared/gs_pmove.c"


def patch(path, old, new, what):
    with open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
        src = f.read()
    n = src.count(old)
    if n != 1:
        sys.exit("FATAL: %s anchor found %d times (expected 1) in %s" % (what, n, path))
    with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
        f.write(src.replace(old, new))


# --- 1. PM_Move: walking on the ground clears the prejump counters ------------
# Without this the counters would only ever reset on a rejected start, and a
# player who jumped once anywhere on the map could never start a run.
WALK_ANCHOR = (
    "\t\telse\n"
    "\t\t\tpml.velocity[2] -= pm->playerState->pmove.gravity * pml.frametime;\n"
    "\n"
    "\t\tif( !pml.velocity[0] && !pml.velocity[1] )\n"
)
WALK_NEW = (
    "\t\telse\n"
    "\t\t\tpml.velocity[2] -= pm->playerState->pmove.gravity * pml.frametime;\n"
    "\n"
    "\t\t// racesow - if player is walking: clear prejump counters\n"
    "\t\tfloat hspeed = VectorLengthFast( tv( pml.velocity[0], pml.velocity[1], 0 ) );\n"
    "\t\tif( hspeed < DEFAULT_PLAYERSPEED_RACE + 5.0f )\n"
    "\t\t\tRS_ResetPjState( pm->playerState->playerNum );\n"
    "\t\t// !racesow\n"
    "\n"
    "\t\tif( !pml.velocity[0] && !pml.velocity[1] )\n"
)
patch(PMOVE, WALK_ANCHOR, WALK_NEW, "PM_Move prejump reset")

# --- 2. PM_Jump: count the two real-jump branches ----------------------------
JUMP_ANCHOR = (
    "\telse if( pml.velocity[2] > 0 )\n"
    "\t{\n"
    "\t\tmodule_PredictedEvent( pm->playerState->POVnum, EV_JUMP, 0 );\n"
    "\t\tpml.velocity[2] += pml.jumpPlayerSpeed;\n"
    "\t}\n"
    "\telse\n"
    "\t{\n"
    "\t\tmodule_PredictedEvent( pm->playerState->POVnum, EV_JUMP, 0 );\n"
    "\t\tpml.velocity[2] = pml.jumpPlayerSpeed;\n"
    "\t}\n"
)
JUMP_NEW = (
    "\telse if( pml.velocity[2] > 0 )\n"
    "\t{\n"
    "\t\tmodule_PredictedEvent( pm->playerState->POVnum, EV_JUMP, 0 );\n"
    "\t\tpml.velocity[2] += pml.jumpPlayerSpeed;\n"
    "\t\tRS_IncrementJumps( pm->playerState->playerNum ); // racesow - pjcount\n"
    "\t}\n"
    "\telse\n"
    "\t{\n"
    "\t\tmodule_PredictedEvent( pm->playerState->POVnum, EV_JUMP, 0 );\n"
    "\t\tpml.velocity[2] = pml.jumpPlayerSpeed;\n"
    "\t\tRS_IncrementJumps( pm->playerState->playerNum ); // racesow - pjcount\n"
    "\t}\n"
)
patch(PMOVE, JUMP_ANCHOR, JUMP_NEW, "PM_Jump pjcount")

# --- 3. PM_CheckDash: count a dash that fired --------------------------------
DASH_ANCHOR = (
    "\t\telse\n"
    "\t\t{\n"
    "\t\t\tmodule_PredictedEvent( pm->playerState->POVnum, EV_DASH, 0 );\n"
    "\t\t}\n"
    "\t}\n"
    "\telse if( pm->groundentity == -1 )\n"
)
DASH_NEW = (
    "\t\telse\n"
    "\t\t{\n"
    "\t\t\tmodule_PredictedEvent( pm->playerState->POVnum, EV_DASH, 0 );\n"
    "\t\t}\n"
    "\n"
    "\t\tRS_IncrementDashes( pm->playerState->playerNum ); // racesow - pjcount\n"
    "\t}\n"
    "\telse if( pm->groundentity == -1 )\n"
)
patch(PMOVE, DASH_ANCHOR, DASH_NEW, "PM_CheckDash pjcount")

# --- 4. PM_CheckWallJump: count a successful walljump ------------------------
# The stunned branch (EV_WALLJUMP_FAILED) deliberately does NOT count.
WJ_ANCHOR = (
    "\t\t\t\t\tmodule_PredictedEvent( pm->playerState->POVnum, EV_WALLJUMP, DirToByte( normal ) );\n"
)
WJ_NEW = (
    WJ_ANCHOR
    + "\t\t\t\t\tRS_IncrementWallJumps( pm->playerState->playerNum ); // racesow - pjcount\n"
)
patch(PMOVE, WJ_ANCHOR, WJ_NEW, "PM_CheckWallJump pjcount")

print("patch-pjcount-hooks.py: OK (gs_pmove.c x4)")
