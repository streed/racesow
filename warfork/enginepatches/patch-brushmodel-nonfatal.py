#!/usr/bin/env python3
"""
Warfork port: a brush entity with no "model" key must not kill the server.

THE BUG THIS FIXES. Upstream warfork-qfusion treats a NULL model name in
GClip_SetBrushModel as fatal:

    if( !name )
        G_Error( "GClip_SetBrushModel: NULL model in '%s'", ... );

G_Error -> trap_Error -> PF_error -> Com_Error( ERR_DROP ), which calls
SV_ShutdownGame BEFORE it unwinds: the game module is dlclosed, every client
dropped, and the UDP socket CLOSED. The process survives the longjmp but
SV_Frame then early-returns past its only NET_Sleep, so it spins one core
answering nothing while Docker still reports the container Up. That is the
production wedge: EU Warfork 2026-08-06, again 2026-08-08 (38h), US Warfork
2026-08-09 (12h). At BOOT the same error is worse still -- the longjmp lands on
Qcommon_Init's setjmp, whose handler is Sys_Error -> _exit(1).

The trigger is a fixed property of the map file, so it is deterministic, not a
race: dvr_el, mntslick07 and aryshok_mew each contain at least one
trigger_multiple with no "model" key in lump 0 (verified), and all three are
installed in the shared pool right now. g_spawn.cpp makes "model" an ordinary
F_LSTRING field, so an absent key leaves ent->model NULL, and "trigger_multiple"
is matched from the STATIC spawn table before the AngelScript hook is consulted
-- no mod code can intercept it.

Warsow does not die on these maps because DenMSC/racemod_2.1 already patched
this exact call site. This brings Warfork to parity.

WHY NOT COPY WARSOW VERBATIM. Warsow's version ends with G_FreeEdict( ent ),
and that is unsafe here: every caller keeps writing to the entity after
GClip_SetBrushModel returns. SP_trigger_multiple (g_trigger.cpp:128) calls this
at :130 and then sets ent->touch = Touch_Multi (:148), ent->r.solid (:154/:159)
and finally GClip_LinkEntity( ent ) (:163) -- so freeing the edict here hands a
recycled slot a live touch function pointer and re-links it. InitTrigger
(g_trigger.cpp:49-55) has the same shape. So we do NOT free.

WHAT WE DO INSTEAD. Fall through to exactly the behaviour the function already
has for an EMPTY model name one branch below -- `ent->s.modelindex = 0; return;`
-- plus a G_Printf so the broken map is diagnosable in the console (and so the
crash guard's console tap and /flag still surface it). That path is already
reachable in stock code, so its downstream behaviour is whatever upstream
already tolerates: the entity keeps a zero-size volume, the caller's later
writes land on a valid edict, and the level finishes loading with one dead
trigger instead of a dead server.

This makes a broken map load SILENTLY, so it is meant to ship alongside the
crash guard and the map-load reporting that still raise the flag -- otherwise
the map quietly stays broken forever.

Run from source/ (cwd = warfork-qfusion/source). Fails loudly if the anchor is
not found exactly once.
"""
import sys

CLIP = "game/g_clip.cpp"

OLD = (
	"\tif( !name )\n"
	"\t\tG_Error( \"GClip_SetBrushModel: NULL model in '%s'\", \n"
	"\t\tent->classname ? ent->classname : \"no classname\" );\n"
)

NEW = (
	"\tif( !name )\n"
	"\t{\n"
	"\t\t// racesow: a brush entity with no \"model\" key used to be fatal here\n"
	"\t\t// (G_Error -> Com_Error(ERR_DROP) -> SV_ShutdownGame), which wedged the\n"
	"\t\t// server on dvr_el / mntslick07 / aryshok_mew. Disable just this entity\n"
	"\t\t// and let the level finish loading. Deliberately NOT G_FreeEdict: every\n"
	"\t\t// caller keeps writing to ent after we return (SP_trigger_multiple sets\n"
	"\t\t// ->touch, ->r.solid and then GClip_LinkEntity), so freeing the slot here\n"
	"\t\t// would resurrect it with a live touch pointer.\n"
	"\t\tG_Printf( \"GClip_SetBrushModel: NULL model in '%s' -- entity disabled, \"\n"
	"\t\t\t\"this map is broken\\n\",\n"
	"\t\t\tent->classname ? ent->classname : \"no classname\" );\n"
	"\t\tent->s.modelindex = 0;\n"
	"\t\treturn;\n"
	"\t}\n"
)


def main():
	with open(CLIP, "r", encoding="utf-8", errors="surrogateescape") as f:
		src = f.read()
	n = src.count(OLD)
	if n != 1:
		sys.exit("FATAL: GClip_SetBrushModel anchor found %d times (expected 1) in %s" % (n, CLIP))
	with open(CLIP, "w", encoding="utf-8", errors="surrogateescape") as f:
		f.write(src.replace(OLD, NEW))
	print("patched %s: NULL brush model is no longer fatal" % CLIP)


if __name__ == "__main__":
	main()
