#!/usr/bin/env python3
"""Bind Client::demoStart / demoStop / demoCancel for the Warfork game module.

These three AngelScript methods are how the gametype drives the per-client race
demo subsystem (sv_racedemos.c + patch-racedemo-subsystem.py): hrace.as opens a
recording at spawn, and player.as either keeps it on a personal best or throws
it away. Warfork's g_ascript.cpp has no such binding, which is why
warfork/scriptpatches/patch-scripts-as2024.py had to stub every call site out.

Each native is a thin shim onto the console command the engine registers,
exactly as racemod_2.1 does it - the natives do not touch the demo files
themselves. Bots are skipped here rather than in the engine so the WR ghost
racer and the mesh mirror bots never open a recording.

Run from the warfork-qfusion source/ directory. Exits non-zero (failing the
image build) if any anchor is not found exactly once.
"""
import sys

PATH = "game/g_ascript.cpp"
MARK = "racesow-docker: race demo natives"

with open(PATH, encoding="utf-8", errors="surrogateescape") as f:
    src = f.read()

if MARK in src:
    sys.exit("FATAL: racedemo-natives patch already applied to " + PATH)


def sub(src, old, new, what):
    n = src.count(old)
    if n != 1:
        sys.exit("FATAL: %s anchor found %d time(s), expected 1 in %s"
                 % (what, n, PATH))
    return src.replace(old, new)


NATIVES = """// %s
// Thin shims onto the engine's racerecord* commands (server/sv_racedemos.c).
// `1` is the silent flag - a player should not see console spam for a demo the
// gametype opened on their behalf.

static void objectGameClient_DemoStart( asstring_t *name, gclient_t *self )
{
	int playerNum;

	if( !name || !name->buffer )
		return;

	playerNum = objectGameClient_PlayerNum( self );
	if( playerNum < 0 || playerNum >= gs.maxclients )
		return;

	if( objectGameClient_isBot( self ) )
		return;

	trap_Cmd_ExecuteText( EXEC_APPEND, va( "racerecord %%i \\"%%s\\" 1\\n", playerNum, name->buffer ) );
}

static void objectGameClient_DemoStop( asstring_t *name, unsigned int time, gclient_t *self )
{
	int playerNum;

	if( !name || !name->buffer )
		return;

	playerNum = objectGameClient_PlayerNum( self );
	if( playerNum < 0 || playerNum >= gs.maxclients )
		return;

	if( objectGameClient_isBot( self ) )
		return;

	trap_Cmd_ExecuteText( EXEC_APPEND, va( "racerecordstop %%i 1 \\"%%s\\" %%i\\n", playerNum, name->buffer, time ) );
}

static void objectGameClient_DemoCancel( gclient_t *self )
{
	int playerNum;

	playerNum = objectGameClient_PlayerNum( self );
	if( playerNum < 0 || playerNum >= gs.maxclients )
		return;

	if( objectGameClient_isBot( self ) )
		return;

	trap_Cmd_ExecuteText( EXEC_APPEND, va( "racerecordcancel %%i 1\\n", playerNum ) );
}

static const asFuncdef_t gameclient_Funcdefs[] =
""" % MARK

src = sub(src, "static const asFuncdef_t gameclient_Funcdefs[] =\n", NATIVES,
          "gameclient_Funcdefs table")

DECLS = (
    "\t{ ASLIB_FUNCTION_DECL(void, setQuickMenuItems, ( const String &in )), asFUNCTION(objectGameClient_SetQuickMenuItems), asCALL_CDECL_OBJLAST },\n"
    "\t// " + MARK + "\n"
    "\t{ ASLIB_FUNCTION_DECL(void, demoStart, ( const String &in )), asFUNCTION(objectGameClient_DemoStart), asCALL_CDECL_OBJLAST },\n"
    "\t{ ASLIB_FUNCTION_DECL(void, demoStop, ( const String &in, uint time )), asFUNCTION(objectGameClient_DemoStop), asCALL_CDECL_OBJLAST },\n"
    "\t{ ASLIB_FUNCTION_DECL(void, demoCancel, ()), asFUNCTION(objectGameClient_DemoCancel), asCALL_CDECL_OBJLAST },\n"
)

src = sub(src,
          "\t{ ASLIB_FUNCTION_DECL(void, setQuickMenuItems, ( const String &in )), asFUNCTION(objectGameClient_SetQuickMenuItems), asCALL_CDECL_OBJLAST },\n",
          DECLS, "setQuickMenuItems method decl")

with open(PATH, "w", encoding="utf-8", errors="surrogateescape") as f:
    f.write(src)

print("patched: objectGameClient_Demo{Start,Stop,Cancel}")
print("patched: Client::demoStart/demoStop/demoCancel method decls")
print("racedemo-natives patch applied")
