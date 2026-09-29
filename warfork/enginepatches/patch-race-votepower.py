#!/usr/bin/env python3
"""
Warfork port: weighted callvotes (GT_VotePower) and the failed-vote punish
time, from DenMSC/racemod_2.1 ("Callvote update + vote punish time").

hrace.as defines

    float GT_VotePower( Client@ client, String& votename, bool voted, bool yes )

which weights each voter: the TV director counts 0, and a player who has
FINISHED the map and votes no counts double (so people who haven't finished yet
can't vote a map away from those who are racing it). Warsow's game module calls
it for every counted voter; stock Warfork never looks the function up, so on
Warfork every vote counted 1 and that rule silently did nothing.

This adds, as racemod does:
  * g_gametypes.h / g_as_gametypes.cpp: votePowerFunc, looked up at gametype
    init, and GT_asCallVotePower() (returns 1.0 when the script has none, so a
    gametype without it behaves exactly as before). On a script Prepare error we
    return 1.0 rather than racemod's `false` (0.0), so a broken hook can't zero
    out every vote.
  * g_callvotes.cpp: voters / yeses / noes are summed with that power (floats),
    the pass threshold is no longer truncated to an int, and the progress line
    reports percentages. If a vote fails because it could no longer pass and
    its caller voted yes, the caller can't call another vote for
    g_vote_punishtime seconds (default 60).

Warfork already skips fake clients and TV clients before counting, so those
never reach GT_VotePower. Warfork's G_CallVotes_Reset( true ) stamps the
caller's callvote_when itself; the punish time is applied after it, as racemod
does after its reset.

Run from source/ (cwd = warfork-qfusion/source). Fails loudly if any anchor is
not found exactly once.
"""
import sys

EDITS = []


def edit(path, what, old, new):
	EDITS.append((path, what, old, new))


edit("game/g_gametypes.h", "votePowerFunc slot",
	"\tvoid *shutdownFunc;\n",
	"\tvoid *shutdownFunc;\n"
	"\tvoid *votePowerFunc; // racesow\n")

edit("game/g_as_gametypes.cpp", "votePowerFunc reset",
	"\tlevel.gametype.shutdownFunc = NULL;\n"
	"}\n",
	"\tlevel.gametype.shutdownFunc = NULL;\n"
	"\tlevel.gametype.votePowerFunc = NULL; // racesow\n"
	"}\n")

edit("game/g_as_gametypes.cpp", "GT_asCallVotePower",
	"static bool G_asInitializeGametypeScript( asIScriptModule *asModule )\n",
	"// racesow\n"
	"//\"float GT_VotePower( Client @client, String &votename, bool voted, bool yes )\"\n"
	"float GT_asCallVotePower( gclient_t *client, const char *votename, bool voted, bool yes )\n"
	"{\n"
	"\tint error;\n"
	"\tasIScriptContext *ctx;\n"
	"\tasstring_t *s1;\n"
	"\n"
	"\tif( !level.gametype.votePowerFunc )\n"
	"\t\treturn 1.0; // should have a hardcoded backup\n"
	"\n"
	"\tctx = angelExport->asAcquireContext( GAME_AS_ENGINE() );\n"
	"\n"
	"\terror = ctx->Prepare( static_cast<asIScriptFunction *>(level.gametype.votePowerFunc) );\n"
	"\tif( error < 0 )\n"
	"\t\treturn 1.0;\n"
	"\n"
	"\t// Now we need to pass the parameters to the script function.\n"
	"\ts1 = angelExport->asStringFactoryBuffer( votename, strlen( votename ) );\n"
	"\n"
	"\tctx->SetArgObject( 0, client );\n"
	"\tctx->SetArgObject( 1, s1 );\n"
	"\tctx->SetArgByte( 2, voted );\n"
	"\tctx->SetArgByte( 3, yes );\n"
	"\n"
	"\terror = ctx->Execute();\n"
	"\tif( G_ExecutionErrorReport( error ) )\n"
	"\t\tGT_asShutdownScript();\n"
	"\n"
	"\tangelExport->asStringRelease( s1 );\n"
	"\n"
	"\t// Retrieve the return from the context\n"
	"\treturn ctx->GetReturnFloat();\n"
	"}\n"
	"// !racesow\n"
	"\n"
	"static bool G_asInitializeGametypeScript( asIScriptModule *asModule )\n")

edit("game/g_as_gametypes.cpp", "look up GT_VotePower",
	"\tfdeclstr = \"void GT_Shutdown()\";\n"
	"\tlevel.gametype.shutdownFunc = asModule->GetFunctionByDecl( fdeclstr );\n"
	"\tif( !level.gametype.shutdownFunc )\n"
	"\t{\n"
	"\t\tif( developer->integer || sv_cheats->integer )\n"
	"\t\t\tG_Printf( \"* The function '%s' was not present in the script.\\n\", fdeclstr );\n"
	"\t}\n"
	"\telse\n"
	"\t\tfuncCount++;\n",
	"\tfdeclstr = \"void GT_Shutdown()\";\n"
	"\tlevel.gametype.shutdownFunc = asModule->GetFunctionByDecl( fdeclstr );\n"
	"\tif( !level.gametype.shutdownFunc )\n"
	"\t{\n"
	"\t\tif( developer->integer || sv_cheats->integer )\n"
	"\t\t\tG_Printf( \"* The function '%s' was not present in the script.\\n\", fdeclstr );\n"
	"\t}\n"
	"\telse\n"
	"\t\tfuncCount++;\n"
	"\n"
	"\t// racesow\n"
	"\tfdeclstr = \"float GT_VotePower( Client @client, String &votename, bool voted, bool yes )\";\n"
	"\tlevel.gametype.votePowerFunc = asModule->GetFunctionByDecl( fdeclstr );\n"
	"\tif( !level.gametype.votePowerFunc )\n"
	"\t{\n"
	"\t\tif( developer->integer || sv_cheats->integer )\n"
	"\t\t\tG_Printf( \"* The function '%s' was not present in the script.\\n\", fdeclstr );\n"
	"\t}\n"
	"\telse\n"
	"\t\tfuncCount++;\n"
	"\t// !racesow\n")

edit("game/g_local.h", "GT_asCallVotePower declaration",
	"void GT_asCallShutdown( void );\n",
	"void GT_asCallShutdown( void );\n"
	"float GT_asCallVotePower( gclient_t *client, const char *votename, bool voted, bool yes ); // racesow\n")

edit("game/g_callvotes.cpp", "g_vote_punishtime cvar",
	"cvar_t *g_callvote_electtime;          // in seconds\n",
	"cvar_t *g_callvote_electtime;          // in seconds\n"
	"cvar_t *g_callvote_punishtime;          // in seconds - racesow\n")

edit("game/g_callvotes.cpp", "g_vote_punishtime registration",
	"\tg_callvote_electtime =\t\ttrap_Cvar_Get( \"g_vote_electtime\", \"20\", CVAR_ARCHIVE );\n",
	"\tg_callvote_electtime =\t\ttrap_Cvar_Get( \"g_vote_electtime\", \"20\", CVAR_ARCHIVE );\n"
	"\tg_callvote_punishtime =\t\ttrap_Cvar_Get( \"g_vote_punishtime\", \"60\", CVAR_ARCHIVE ); // racesow\n")

edit("game/g_callvotes.cpp", "float vote tallies",
	"\tint needvotes, yeses = 0, voters = 0, noes = 0;\n"
	"\tstatic unsigned int warntimer;\n",
	"\tfloat needvotes, power = 1, yeses = 0, voters = 0, noes = 0; // racesow\n"
	"\tstatic unsigned int warntimer;\n")

edit("game/g_callvotes.cpp", "weight each voter by GT_VotePower",
	"\t\tvoters++;\n"
	"\t\tif( clientVoted[PLAYERNUM( ent )] == VOTED_YES )\n"
	"\t\t\tyeses++;\n"
	"\t\telse if( clientVoted[PLAYERNUM( ent )] == VOTED_NO )\n"
	"\t\t\tnoes++;\n"
	"\t}\n"
	"\n"
	"\t// passed?\n"
	"\tneedvotes = (int)( ( voters * g_callvote_electpercentage->value ) / 100 );\n",
	"\t\t// racesow: the gametype weighs each vote (GT_VotePower)\n"
	"\t\tpower = GT_asCallVotePower(\n"
	"\t\t\tclient,\n"
	"\t\t\tG_CallVotes_String( &callvoteState.vote ),\n"
	"\t\t\tclientVoted[PLAYERNUM(ent)] != VOTED_NOTHING,\n"
	"\t\t\tclientVoted[PLAYERNUM(ent)] == VOTED_YES\n"
	"\t\t);\n"
	"\n"
	"\t\tvoters += power;\n"
	"\t\tif( clientVoted[PLAYERNUM( ent )] == VOTED_YES )\n"
	"\t\t\tyeses += power;\n"
	"\t\telse if( clientVoted[PLAYERNUM( ent )] == VOTED_NO )\n"
	"\t\t\tnoes += power;\n"
	"\t}\n"
	"\n"
	"\t// passed?\n"
	"\tneedvotes = voters * g_callvote_electpercentage->value / 100; // racesow\n")

edit("game/g_callvotes.cpp", "punish a failed vote's caller",
	"\t\tG_PrintMsg( NULL, \"Vote %s%s%s failed\\n\", S_COLOR_YELLOW,\n"
	"\t\t\tG_CallVotes_String( &callvoteState.vote ), S_COLOR_WHITE );\n"
	"\t\tG_CallVotes_Reset( true );\n"
	"\t\treturn;\n",
	"\t\tG_PrintMsg( NULL, \"Vote %s%s%s failed\\n\", S_COLOR_YELLOW,\n"
	"\t\t\tG_CallVotes_String( &callvoteState.vote ), S_COLOR_WHITE );\n"
	"\n"
	"\t\t// racesow: vote punish time\n"
	"\t\tedict_t *caller = callvoteState.vote.caller;\n"
	"\t\tbool voted_yes = caller && clientVoted[PLAYERNUM( caller )] == VOTED_YES;\n"
	"\n"
	"\t\tG_CallVotes_Reset( true );\n"
	"\n"
	"\t\tif( voted_yes && voters - noes <= needvotes )\n"
	"\t\t{\n"
	"\t\t\tif( !caller->r.inuse || trap_GetClientState( PLAYERNUM( caller ) ) < CS_SPAWNED )\n"
	"\t\t\t\treturn;\n"
	"\n"
	"\t\t\tif( ( caller->r.svflags & SVF_FAKECLIENT ) || caller->r.client->isTV )\n"
	"\t\t\t\treturn;\n"
	"\n"
	"\t\t\tcaller->r.client->level.callvote_when = game.realtime + ( g_callvote_punishtime->value * 1000 );\n"
	"\t\t}\n"
	"\t\t// !racesow\n"
	"\t\treturn;\n")

edit("game/g_callvotes.cpp", "vote progress in percent",
	"\t\tG_PrintMsg( NULL, \"Vote in progress: %s%s%s, %i voted yes, %i voted no. %i required\\n\", S_COLOR_YELLOW,\n"
	"\t\t\tG_CallVotes_String( &callvoteState.vote ), S_COLOR_WHITE, yeses, noes,\n"
	"\t\t\tneedvotes + 1 );\n",
	"\t\tG_PrintMsg( NULL, \"Vote in progress: %s%s%s, yes: %i%%, no: %i%% (%i%% required)\\n\", S_COLOR_YELLOW,\n"
	"\t\t\tG_CallVotes_String( &callvoteState.vote ), S_COLOR_WHITE,\n"
	"\t\t\tvoters > 0 ? int( yeses / voters * 100 ) : 0, voters > 0 ? int( noes / voters * 100 ) : 0,\n"
	"\t\t\tint( g_callvote_electpercentage->value ) ); // racesow\n")


def main():
	files = {}
	for path, what, old, new in EDITS:
		if path not in files:
			with open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
				files[path] = f.read()
		n = files[path].count(old)
		if n != 1:
			sys.exit("FATAL: %s anchor found %d times (expected 1) in %s" % (what, n, path))
		files[path] = files[path].replace(old, new)
		print("patched %s: %s" % (path, what))
	for path, src in files.items():
		with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
			f.write(src)


if __name__ == "__main__":
	main()
