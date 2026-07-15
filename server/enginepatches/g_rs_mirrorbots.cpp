/*
 * racesow-docker: "mirror bots" — real fake-client slots that represent
 * remote (mesh-mirrored) players.
 *
 * The display-only ghost entities (hrace/mirror.as) render a remote player but
 * cannot appear on the scoreboard or be spectated, because Warsow ties the
 * scoreboard name to CS_PLAYERINFOS+playerNum and the chasecam to a client
 * entnum. To make a mirrored player a first-class, spectatable, scoreboard-
 * visible participant we give it a real client slot via trap_FakeClientConnect
 * (the same mechanism bots use), then drive its position / view angles /
 * velocity from the mirror stream every frame while keeping pmove frozen so the
 * engine never moves it on its own.
 *
 * Unlike g_rs_mirror.cpp (a standalone module with no engine headers), this
 * file is part of the game module proper: it includes g_local.h and calls
 * engine traps directly. It is compiled into the game .so by the CMake *.cpp
 * glob and exposed to the hrace gametype via patch-mirror-natives.py.
 */
#include "g_local.h"

#include <cstdio>

// Bounds the slot-tracking array at compile time (engine client numbering never
// exceeds this; runtime work is additionally guarded by gs.maxclients).
#define RS_MAX_BOT_SLOTS 256

// Which client slots are mirror bots (so the gametype can special-case them
// and we only ever drop/free our own slots).
static bool rs_mirrorBotSlot[RS_MAX_BOT_SLOTS];

static void rsSetColor( char *userinfo, size_t size, int r, int g, int b )
{
	char buf[32];
	Q_snprintfz( buf, sizeof( buf ), "%i %i %i", r & 255, g & 255, b & 255 );
	Info_SetValueForKey( userinfo, "color", buf );
}

/*
 * RS_MirrorBotAdd — connect a fake client for a remote player.
 * name is shown on the scoreboard / over nothing (client limitation) and in
 * chase; (r,g,b) is the random Warsow player colour. Returns the playerNum
 * (0..maxclients-1) or -1 on failure.
 */
int RS_MirrorBotAdd( const char *name, const char *clan, int r, int g, int b )
{
	char userinfo[MAX_INFO_STRING];
	memset( userinfo, 0, sizeof( userinfo ) );
	Info_SetValueForKey( userinfo, "name", ( name && name[0] ) ? name : "ghost" );
	Info_SetValueForKey( userinfo, "model", "bigvic" );
	Info_SetValueForKey( userinfo, "skin", "default" );
	Info_SetValueForKey( userinfo, "hand", "2" );
	// clan = the origin server tag, shown in the scoreboard's Clan column
	// (G_SetClan reads userinfo "clan"). Tags are already space-free.
	if( clan && clan[0] )
		Info_SetValueForKey( userinfo, "clan", clan );
	rsSetColor( userinfo, sizeof( userinfo ), r, g, b );

	static char fakeSocketType[] = "loopback";
	static char fakeIP[] = "127.0.0.1";
	int entNum = trap_FakeClientConnect( userinfo, fakeSocketType, fakeIP );
	if( entNum < 1 ) // 0 = worldspawn, -1 = error
		return -1;

	edict_t *ent = &game.edicts[entNum];
	int playerNum = entNum - 1;
	rs_mirrorBotSlot[playerNum] = true;

	if( ent->r.client )
	{
		// Join the players team so it shows on the scoreboard and the chasecam
		// includes it, then freeze it — we drive its transform every frame.
		G_Teams_SetTeam( ent, TEAM_PLAYERS );
		ent->r.client->ps.pmove.pm_type = PM_FREEZE;
	}
	ent->movetype = MOVETYPE_NONE;
	ent->r.svflags &= ~SVF_NOCLIENT;
	fprintf( stderr, "rs_mirror: bot slot %d connected as '%s'\n", playerNum, name ? name : "" );
	return playerNum;
}

/*
 * RS_MirrorBotUpdate — force the bot's transform from the mirror stream. Called
 * each mirror tick. viewangles carry the remote player's look direction (pitch
 * + yaw), so a spectator chasing this slot "in eyes" sees their POV.
 */
void RS_MirrorBotUpdate( int playerNum, float ox, float oy, float oz,
	float pitch, float yaw, float roll, float vx, float vy, float vz, int flags )
{
	if( playerNum < 0 || playerNum >= gs.maxclients || playerNum >= RS_MAX_BOT_SLOTS || !rs_mirrorBotSlot[playerNum] )
		return;
	edict_t *ent = &game.edicts[playerNum + 1];
	if( !ent->r.inuse || !ent->r.client )
		return;

	vec3_t origin = { ox, oy, oz };
	vec3_t angles = { pitch, yaw, roll };
	vec3_t velocity = { vx, vy, vz };

	VectorCopy( origin, ent->s.origin );
	VectorCopy( origin, ent->olds.origin );
	VectorCopy( origin, ent->r.client->ps.pmove.origin );
	VectorCopy( velocity, ent->velocity );
	VectorCopy( velocity, ent->r.client->ps.pmove.velocity );
	VectorCopy( angles, ent->s.angles );
	VectorCopy( angles, ent->r.client->ps.viewangles );
	// keep the engine from ever moving it, and mark it a translucent race ghost
	ent->r.client->ps.pmove.pm_type = PM_FREEZE;
	ent->movetype = MOVETYPE_NONE;
	ent->s.effects |= EF_RACEGHOST;
	ent->s.type = ET_PLAYER;
	(void)flags;
	GClip_LinkEntity( ent );
}

// RS_MirrorBotRemove — drop the fake client and free its slot.
void RS_MirrorBotRemove( int playerNum )
{
	if( playerNum < 0 || playerNum >= gs.maxclients || playerNum >= RS_MAX_BOT_SLOTS || !rs_mirrorBotSlot[playerNum] )
		return;
	edict_t *ent = &game.edicts[playerNum + 1];
	rs_mirrorBotSlot[playerNum] = false;
	if( ent->r.inuse )
		trap_DropClient( ent, DROP_TYPE_GENERAL, NULL );
}

// RS_MirrorBotIs — is this client slot one of our mirror bots?
bool RS_MirrorBotIs( int playerNum )
{
	return playerNum >= 0 && playerNum < gs.maxclients && rs_mirrorBotSlot[playerNum];
}
