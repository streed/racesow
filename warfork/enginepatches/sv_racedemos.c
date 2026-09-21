/*
Copyright (C) 1997-2001 Id Software, Inc.

This program is free software; you can redistribute it and/or
modify it under the terms of the GNU General Public License
as published by the Free Software Foundation; either version 2
of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program; if not, write to the Free Software
Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA  02111-1307, USA.

*/

/*
* The per-client RACE demo subsystem, vendored from the Warsow racemod_2.1
* engine fork (see warfork/enginepatches/UPSTREAM) so the Warfork servers
* record per-player runs like the Warsow ones do.
*
* Warfork's own sv_demos.c only knows SERVER demos: one recording of the whole
* server, written to demos/server. This file adds the second kind - one demo
* per client, written to demos/server/<map>/ and started/stopped by the
* gametype through Client::demoStart / demoStop / demoCancel, which is how a
* player's personal-best run becomes a download on the website.
*
* It is a straight lift: every function body below is racemod_2.1's unchanged,
* only relocated out of that fork's sv_demos.c into its own translation unit
* (the shared server-demo code never references any of it, so the split is
* clean). Keeping it separate means Warfork's sv_demos.c stays stock and this
* file can be re-synced against upstream racemod in one piece.
*
* The one deliberate deviation: SV_CleanDemoName, SV_UintToTimeString and
* SV_TimeStringToUint are `static` here. racemod leaves them external, but
* nothing outside its sv_demos.c ever calls them, and giving this file three
* unprototyped global symbols would be an avoidable collision with whatever
* upstream Warfork adds next.
*
* The call sites that drive it - the per-frame snap write, the reliable-command
* mirroring, the alloc/free of svs.race_demos and the racerecord* console
* commands - are wired in by patch-racedemo-subsystem.py.
*/

#include "server.h"

#define SV_DEMO_DIR va( "demos/server%s%s", sv_demodir->string[0] ? "/" : "", sv_demodir->string[0] ? sv_demodir->string : "" )

// Defined below, but SV_RaceDemo_WriteSnap drops a finished recording through
// it first. racemod_2.1 carries this prototype in server.h; keeping it here
// instead avoids putting a `static` declaration in a shared header.
static void SV_RaceDemo_Stop( int client_id, bool cancel, bool silent, char *playername, unsigned int time );

/*
* SV_FindPlayer
* Helper for the functions below. It finds the client_t for the given name or id
*/
static client_t *SV_FindPlayer( char *s )
{
	client_t *cl;
	client_t *player;
	int i;
	int idnum = 0;

	if( !s )
		return NULL;

	// numeric values are just slot numbers
	if( s[0] >= '0' && s[0] <= '9' )
	{
		idnum = atoi( s );
		if( idnum < 0 || idnum >= sv_maxclients->integer )
		{
			Com_Printf( "Bad client slot: %i\n", idnum );
			return NULL;
		}

		player = &svs.clients[idnum];
		goto found_player;
	}

	// check for a name match
	for( i = 0, cl = svs.clients; i < sv_maxclients->integer; i++, cl++ )
	{
		if( !cl->state )
			continue;
		if( !Q_stricmp( cl->name, s ) )
		{
			player = cl;
			goto found_player;
		}
	}

	Com_Printf( "Userid %s is not on the server\n", s );
	return NULL;

found_player:
	if( !player->state || !player->edict )
	{
		Com_Printf( "Client %s is not active\n", s );
		return NULL;
	}

	return player;
}

/*
* SV_CleanDemoName
* 
* Remove junk chars from a string
*/
static char *SV_CleanDemoName( const char *in )
{
	static char cleanString[MAX_STRING_CHARS];
	char *out = cleanString, *end = cleanString + sizeof( cleanString ) - 1;

	if( in )
	{
		while( *in && (out < end) )
		{
			if( *in < 0x1F || *in == 0x7F )
			{
				// skip it
				in++;
			}
			else if ( *in == '"' || *in == '*' || *in == '/' || *in == ':' || *in == '?' ||
				*in == '\\' || *in == '/' || *in == '.' || *in == '|' || *in == ' ' )
			{
				*out = '_';
				in++;
				out++;
			}
			else if( *in == '<' )
			{
				*out = '(';
				in++;
				out++;
			}
			else if( *in == '>' )
			{
				*out = ')';
				in++;
				out++;
			}
			else
			{
				// keep it
				*out = *in;
				in++;
				out++;
			}
		}
	}

	*out = '\0';
	return cleanString;
}

static char *SV_UintToTimeString( unsigned int millis )
{
	char *time = Mem_ZoneMalloc( sizeof( char ) * 64 );
	unsigned int min, sec;

	min = millis / ( 60 * 1000 );
	millis -= min * ( 60 * 1000 );
	sec = millis / 1000;
	millis -= sec * 1000;
	// we want MM-SS-mmm
	Q_snprintfz( time, sizeof( char ) * 64, "%02d-%02d-%03d", min, sec, millis );
	return time;
}

static unsigned int SV_TimeStringToUint( char *time_str )
{
	unsigned int time = 0;
	char *chr;
	int time_part_end;
	int time_parts = 0;
	int multiplier = 1;
	size_t time_part_size;
	char *time_part;

	time_part_end = strlen( time_str );
	for( chr = time_str + strlen( time_str ) - 1; chr + 1 != time_str; chr-- )
	{
		if( !isdigit( *chr ) )
		{
			time_part_size = time_part_end - ( strlen( time_str ) - strlen( chr ) );
			time_part_end -= time_part_size;
			time_part = Mem_TempMalloc( time_part_size );
			Q_strncatz( time_part, chr + 1, time_part_size );
			time += atoi( time_part ) * multiplier;
			time_parts++;
			switch( time_parts )
			{
				case 1:
					multiplier *= 1000;
					break;
				case 2:
				case 3:
					multiplier *= 60;
					break;
				case 4:
					multiplier *= 24;
					break;
				case 5:
					multiplier *= 365;
					break;
			}
			Mem_TempFree( time_part );
		}
	}

	return time;
}

/*
* SV_RaceDemo_WriteMessage
* 
* Writes given message to the race demofile
*/
static void SV_RaceDemo_WriteMessage( int client_id, msg_t *msg )
{
	assert( svs.race_demos[client_id].file );
	if( !svs.race_demos[client_id].file )
		return;

	SNAP_RecordDemoMessage( svs.race_demos[client_id].file, msg, 0 );
}

/*
* SV_RaceDemo_WriteStartMessages
*/
static void SV_RaceDemo_WriteStartMessages( int client_id )
{
	unsigned int backup_svflags[MAX_EDICTS];
	edict_t *ent;
	int j;

	// clear demo meta data, we'll write some keys later
	svs.race_demos[client_id].meta_data_realsize = SNAP_ClearDemoMeta( svs.race_demos[client_id].meta_data, sizeof( svs.race_demos[client_id].meta_data ) );

	// start filter
	for( j = 0; j < MAX_EDICTS; j++ )
	{
		ent = EDICT_NUM(j);
		if( ent )
		{
			backup_svflags[j] = ent->r.svflags;

			if( j > 0 && j < sv_maxclients->integer && j != client_id + 1 )
			{
				ent->r.svflags |= SVF_NOCLIENT;
			}
			if( ent->r.owner && ent->r.owner != svs.clients[client_id].edict )
			{
				ent->r.svflags |= SVF_NOCLIENT;
			}
			if( ent->s.ownerNum > 0 && ent->s.ownerNum != client_id + 1 )
			{
				ent->r.svflags |= SVF_NOCLIENT;
			}
		}
	}

	SNAP_BeginDemoRecording( svs.race_demos[client_id].file, svs.spawncount, svc.snapFrameTime, sv.mapname, SV_BITFLAGS_RELIABLE, 
		svs.purelist, sv.configstrings[0], sv.baselines );

	// reset filter
	for( j = 0; j < MAX_EDICTS; j++ )
	{
		ent = EDICT_NUM(j);
		if( ent )
		{
			ent->r.svflags = backup_svflags[j];
		}
	}
}

/*
* SV_RaceDemo_WriteSnap
*/
void SV_RaceDemo_WriteSnap( void )
{
	int i, j;
	msg_t msg;
	uint8_t msg_buffer[MAX_MSGLEN];
	unsigned int backup_svflags[MAX_EDICTS];
	edict_t *ent;

	for( i = 0; i < sv_maxclients->integer; i++ )
	{
		if( !svs.race_demos[i].file )
			continue;
	
		if( svs.clients[i].state < CS_SPAWNED || !svs.clients[i].edict )
		{
			SV_RaceDemo_Stop( i, true, false, "", 0 );
			continue;
		}

		MSG_Init( &msg, msg_buffer, sizeof( msg_buffer ) );

		// start filter
		for( j = 0; j < MAX_EDICTS; j++ )
		{
			ent = EDICT_NUM(j);
			if( ent )
			{
				backup_svflags[j] = ent->r.svflags;

				if( j > 0 && j < sv_maxclients->integer && j != i + 1 )
				{
					ent->r.svflags |= SVF_NOCLIENT;
				}
				if( ent->r.owner && ent->r.owner != svs.clients[i].edict )
				{
					ent->r.svflags |= SVF_NOCLIENT;
				}
				if( ent->s.ownerNum > 0 && ent->s.ownerNum != i + 1 )
				{
					ent->r.svflags |= SVF_NOCLIENT;
				}
			}
		}

		SV_BuildClientFrameSnap( &svs.race_demos[i].client );

		SV_WriteFrameSnapToClient( &svs.race_demos[i].client, &msg );

		SV_AddReliableCommandsToMessage( &svs.race_demos[i].client, &msg );

		SV_RaceDemo_WriteMessage( i, &msg );
		
		// reset filter
		for( j = 0; j < MAX_EDICTS; j++ )
		{
			ent = EDICT_NUM(j);
			if( ent )
			{
				ent->r.svflags = backup_svflags[j];
			}
		}

		svs.race_demos[i].duration = svs.gametime - svs.race_demos[i].basetime;
		svs.race_demos[i].client.lastframe = sv.framenum; // FIXME: is this needed?
	}
}

/*
* SV_RaceDemo_InitClient
*/
static void SV_RaceDemo_InitClient( int client_id )
{
	memset( &svs.race_demos[client_id].client, 0, sizeof( svs.race_demos[client_id].client ) );

	svs.race_demos[client_id].client.mv = false;
	svs.race_demos[client_id].client.reliable = true;

	svs.race_demos[client_id].client.reliableAcknowledge = 0;
	svs.race_demos[client_id].client.reliableSequence = 0;
	svs.race_demos[client_id].client.reliableSent = 0;
	memset( svs.race_demos[client_id].client.reliableCommands, 0, sizeof( svs.race_demos[client_id].client.reliableCommands ) );

	svs.race_demos[client_id].client.lastframe = sv.framenum - 1;
	svs.race_demos[client_id].client.nodelta = false;

	svs.race_demos[client_id].client.edict = EDICT_NUM( client_id + 1 );
}

/*
* SV_RaceDemo_Start
* 
* Begins race demo recording.
*/
static void SV_RaceDemo_Start( char *clientname, char *playername, bool silent )
{
	int demofilename_size, client_id;
	client_t *client;
	size_t filename_size;
	char *filename;

	client = SV_FindPlayer( clientname );

	if( !client )
	{
		return;
	}

	client_id = client->edict->r.client->ps.playerNum;
	
	if( svs.clients[client_id].state < CS_SPAWNED || !svs.clients[client_id].edict ||
		( svs.clients[client_id].edict->r.svflags & SVF_NOCLIENT ) )
	{
		Com_Printf( "Player not in game, can't record a demo\n" );
		return;
	}

	if( svs.race_demos[client_id].file )
	{
		Com_Printf( "Already recording\n" );
		return;
	}

	if( sv.state != ss_game )
	{
		Com_Printf( "Must be in a level to record\n" );
		return;
	}

	//
	// open the demo file
	//

	playername = SV_CleanDemoName( playername );

	filename_size = sizeof( char ) * ( strlen( playername ) + 5 + 1 );
	filename = Mem_ZoneMalloc( filename_size );
	Q_snprintfz( filename, filename_size, "%s_%04i", playername, (int)brandom( 1, 9999 ) );

	// real name
	demofilename_size = sizeof( char ) *
		( strlen( SV_DEMO_DIR ) + 1 + 2 * ( strlen( sv.configstrings[CS_MAPNAME] ) + 1 ) + strlen( filename ) + strlen( APP_DEMO_EXTENSION_STR ) + 1 );
	svs.race_demos[client_id].filename = Mem_ZoneMalloc( demofilename_size );

	Q_snprintfz( svs.race_demos[client_id].filename, demofilename_size, "%s/%s/%s_%s", SV_DEMO_DIR, sv.configstrings[CS_MAPNAME], sv.configstrings[CS_MAPNAME], filename );
	
	Mem_ZoneFree( filename );

	COM_SanitizeFilePath( svs.race_demos[client_id].filename );

	if( !COM_ValidateRelativeFilename( svs.race_demos[client_id].filename ) )
	{
		Mem_ZoneFree( svs.race_demos[client_id].filename );
		svs.race_demos[client_id].filename = NULL;
		Com_Printf( "Invalid filename.\n" );
		return;
	}

	COM_DefaultExtension( svs.race_demos[client_id].filename, APP_DEMO_EXTENSION_STR, demofilename_size );

	// temp name
	demofilename_size = sizeof( char ) * ( strlen( svs.race_demos[client_id].filename ) + strlen( ".rec" ) + 1 );
	svs.race_demos[client_id].tempname = Mem_ZoneMalloc( demofilename_size );
	Q_snprintfz( svs.race_demos[client_id].tempname, demofilename_size, "%s.rec", svs.race_demos[client_id].filename );

	// open it
	// racemod opens this FS_WRITE|SNAP_DEMO_GZ, but Warfork has neither that
	// macro nor the FS_GZ it aliases - its own SV_Demo_Start_f writes a plain
	// FS_WRITE demo. Match that, so a race demo is byte-compatible with the
	// server demos this engine already produces.
	if( FS_FOpenFile( svs.race_demos[client_id].tempname, &svs.race_demos[client_id].file, FS_WRITE ) == -1 )
	{
		Com_Printf( "Error: Couldn't open file: %s\n", svs.race_demos[client_id].tempname );
		Mem_ZoneFree( svs.race_demos[client_id].filename );
		svs.race_demos[client_id].filename = NULL;
		Mem_ZoneFree( svs.race_demos[client_id].tempname );
		svs.race_demos[client_id].tempname = NULL;
		return;
	}

	if( !silent )
	{
		Com_Printf( "Recording client demo: %s\n", svs.race_demos[client_id].filename );
	}

	SV_RaceDemo_InitClient( client_id );

	// write serverdata, configstrings and baselines
	svs.race_demos[client_id].duration = 0;
	svs.race_demos[client_id].basetime = svs.gametime;
	svs.race_demos[client_id].localtime = time( NULL );
	SV_RaceDemo_WriteStartMessages( client_id );

	// write one nodelta frame
	svs.race_demos[client_id].client.nodelta = true;
	SV_RaceDemo_WriteSnap();
	svs.race_demos[client_id].client.nodelta = false;
}

/*
* SV_RaceDemo_Start_f
* 
* Begins race demo recording.
*/
void SV_RaceDemo_Start_f( void )
{
	if( Cmd_Argc() < 3 )
	{
		Com_Printf( "Usage: racerecord <id or name> <demoname> <silent>\n" );
		return;
	}
	SV_RaceDemo_Start( Cmd_Argv( 1 ), Cmd_Argv( 2 ), atoi( Cmd_Argv( 3 ) ) != 0 );
}

/*
* SV_RaceDemo_Stop
*/
static void SV_RaceDemo_Stop( int client_id, bool cancel, bool silent, char *playername, unsigned int time )
{
	if( !svs.race_demos[client_id].file )
	{
		if( !silent ) {
			Com_Printf( "No race demo recording in progress\n" );
		}
		return;
	}

	// new name
	char *new_filename;
	char *time_str;
	time_str = SV_UintToTimeString( time );
	playername = SV_CleanDemoName( playername );
	unsigned int demofilename_size =
		sizeof( char ) * ( strlen( SV_DEMO_DIR ) + 1 + 2 * ( strlen( sv.configstrings[CS_MAPNAME] ) + 1 ) + strlen( playername ) + 1 + strlen( time_str ) + strlen( APP_DEMO_EXTENSION_STR ) + 1 );
	new_filename = Mem_ZoneMalloc( demofilename_size );

	Q_snprintfz( new_filename, demofilename_size, "%s/%s/%s_%s_%s", SV_DEMO_DIR, sv.configstrings[CS_MAPNAME], sv.configstrings[CS_MAPNAME], playername, time_str );

	COM_SanitizeFilePath( new_filename );

	if( !COM_ValidateRelativeFilename( new_filename ) )
	{
		Mem_ZoneFree( time_str );
		Mem_ZoneFree( new_filename );
		new_filename = NULL;
		Com_Printf( "Invalid filename.\n" );
		return;
	}

	COM_DefaultExtension( new_filename, APP_DEMO_EXTENSION_STR, demofilename_size );
	
	Mem_ZoneFree( svs.race_demos[client_id].filename );
	svs.race_demos[client_id].filename = new_filename;

	if( cancel )
	{
		if( !silent )
			Com_Printf( "Canceled race demo recording: %s\n", svs.race_demos[client_id].filename );
	}
	else
	{
		SNAP_StopDemoRecording( svs.race_demos[client_id].file );

		if( !silent )
			Com_Printf( "Stopped race demo recording: %s\n", svs.race_demos[client_id].filename );
	}

	FS_FCloseFile( svs.race_demos[client_id].file );
	svs.race_demos[client_id].file = 0;

	if( cancel )
	{
		if( !FS_RemoveFile( svs.race_demos[client_id].tempname ) )
			Com_Printf( "Error: Failed to delete the temporary race demo file\n" );
	}
	else
	{
		// write some meta information about the match/demo
		SV_SetRaceDemoMetaKeyValue( client_id, "hostname", sv.configstrings[CS_HOSTNAME] );
		SV_SetRaceDemoMetaKeyValue( client_id, "localtime", va( "%u", svs.demo.localtime ) );
		SV_SetRaceDemoMetaKeyValue( client_id, "multipov", "0" );
		SV_SetRaceDemoMetaKeyValue( client_id, "duration", va( "%u", (int)ceil( svs.demo.duration/1000.0f ) ) );
		SV_SetRaceDemoMetaKeyValue( client_id, "mapname", sv.configstrings[CS_MAPNAME] );
		SV_SetRaceDemoMetaKeyValue( client_id, "gametype", sv.configstrings[CS_GAMETYPENAME] );
		SV_SetRaceDemoMetaKeyValue( client_id, "levelname", sv.configstrings[CS_MESSAGE] );
		SV_SetRaceDemoMetaKeyValue( client_id, "matchname", svs.clients[client_id].name );
		SV_SetRaceDemoMetaKeyValue( client_id, "matchscore", time_str );
		SV_SetRaceDemoMetaKeyValue( client_id, "matchuuid", sv.configstrings[CS_MATCHUUID] );

		SNAP_WriteDemoMetaData( svs.race_demos[client_id].tempname, svs.race_demos[client_id].meta_data, svs.race_demos[client_id].meta_data_realsize );


		if( !FS_MoveFile( svs.race_demos[client_id].tempname, svs.race_demos[client_id].filename ) )
			Com_Printf( "Error: Failed to rename the race demo file\n" );

		Cmd_ExecuteString( va( "racerecordpurge %s %i %i %i", sv.configstrings[CS_MAPNAME], 1, 1, 10 ) );
	}

	svs.race_demos[client_id].localtime = 0;
	svs.race_demos[client_id].basetime = svs.demo.duration = 0;

	SNAP_FreeClientFrames( &svs.race_demos[client_id].client );

	Mem_ZoneFree( time_str );

	Mem_ZoneFree( svs.race_demos[client_id].filename );
	svs.race_demos[client_id].filename = NULL;
	Mem_ZoneFree( svs.race_demos[client_id].tempname );
	svs.race_demos[client_id].tempname = NULL;
}

/*
* SV_RaceDemo_Stop_f
* 
* Console command for stopping race demo recording.
*/
void SV_RaceDemo_Stop_f( void )
{
	SV_RaceDemo_Stop( atoi( Cmd_Argv( 1 ) ), false, atoi( Cmd_Argv( 2 ) ) != 0, Cmd_Argv( 3 ), atoi( Cmd_Argv( 4 ) ) );
}

/*
* SV_RaceDemo_Cancel_f
* 
* Cancels the race demo recording (stop, remove file)
*/
void SV_RaceDemo_Cancel_f( void )
{
	SV_RaceDemo_Stop( atoi( Cmd_Argv( 1 ) ), true, atoi( Cmd_Argv( 2 ) ) != 0, "", 0 );
}

typedef struct
{
	char *filename;
	unsigned int sortKey;
	char *remainder;
} racedemo_t;

static int SV_RaceDemo_Purge_Sort( const racedemo_t *file1, const racedemo_t *file2 )
{
	return file1->sortKey - file2->sortKey;
}

static int SV_RaceDemo_Purge_Sort_Remainder( const racedemo_t *file1, const racedemo_t *file2 )
{
	int diff = Q_stricmp( file1->remainder, file2->remainder );
	if( diff == 0 )
	{
		diff = SV_RaceDemo_Purge_Sort( file1, file2 );
	}
	return diff;
}

/*
* SV_RaceDemo_Purge_f
* 
* Removes the race demo files
*/
void SV_RaceDemo_Purge_f( void )
{
	char *buffer;
	char *folder;
	char *s;
	char *chr, *current, *time;
	char path[256];
	bool uniqueRemainder = false;
	size_t extlen, length, bufSize;
	unsigned int i, numdemos, numautodemos, maxdemos, sortNum, sortCount, keyLength;

	racedemo_t *demolist;

	if( Cmd_Argc() < 4 || Cmd_Argc() > 5 )
	{
		Com_Printf( "Usage: racerecordpurge <folder> <sortNum> <uniqueRemainder> [maxdemos]\n" );
		return;
	}

	folder = va( "%s/%s", SV_DEMO_DIR, Cmd_Argv( 1 ) );
	sortNum = atoi( Cmd_Argv( 2 ) );

	uniqueRemainder = atoi( Cmd_Argv( 3 ) ) != 0;

	maxdemos = 0;
	if( Cmd_Argc() == 5 )
		maxdemos = atoi( Cmd_Argv( 4 ) );

	numdemos = FS_GetFileListExt( folder, APP_DEMO_EXTENSION_STR, NULL, &bufSize, 0, 0 );
	if( !numdemos )
		return;

	extlen = strlen( APP_DEMO_EXTENSION_STR );
	buffer = Mem_TempMalloc( bufSize );
	FS_GetFileList( folder, APP_DEMO_EXTENSION_STR, buffer, bufSize, 0, 0 );

	demolist = Mem_TempMalloc( numdemos * sizeof( racedemo_t ) );

	// format: <mapname>_<playername>_<time>.wdz20
	//         |       unique       | |sort|

	numautodemos = 0;
	s = buffer;
	current = s;
	sortCount = 0;
	for( i = 0; i < numdemos; i++, s += length + 1 )
	{
		length = strlen( s );
		for( chr = s; *chr; chr++ )
		{
			if( *chr == '_' )
			{
				current = chr;

				/*if( sortCount++ == sortNum )
				{
					sortCount = 0;
					keyLength = strlen(current) - strlen(chr) + 1;
					demolist[i].sortKey = Mem_TempMalloc( keyLength );
					Q_strncpyz(demolist[i].sortKey, current, keyLength);

					keyLength = strlen(chr) - 1 - extlen + 1;
					demolist[i].remainder = Mem_TempMalloc( keyLength );
					Q_strncpyz(demolist[i].remainder, chr + 1, keyLength);

					demolist[i].filename = s;
					break;
				}
				else
				{
					current = chr + 1;
				}*/
			}
			/*else if( allInts && sortCount == sortNum )
			{
				if( !isdigit( chr[0] ) )
				{
					allInts = false;
				}
			}*/
		}
		// we reached the end, current points to last '_'

		keyLength = strlen(current) - extlen + 1;
		time = Mem_TempMalloc( keyLength );
		Q_strncpyz(time, current, keyLength);
		demolist[i].sortKey = SV_TimeStringToUint( time );
		Mem_TempFree( time );

		keyLength = length - strlen(current) + 1;
		demolist[i].remainder = Mem_TempMalloc( keyLength );
		Q_strncpyz(demolist[i].remainder, s, keyLength);

		demolist[i].filename = s;
	}

	if( uniqueRemainder )
	{
		// sort by remainder and sortKey
		qsort( demolist, numdemos, sizeof( racedemo_t ), ( int ( * )( const void *, const void * ) )SV_RaceDemo_Purge_Sort_Remainder );
	
		// remove duplicated
		for( i = 1; i < numdemos; )
		{
			if( Q_stricmp( demolist[i-1].remainder, demolist[i].remainder ) )
			{
				i++;
				continue;
			}

			Mem_TempFree( demolist[i].remainder );
		
			Q_snprintfz( path, sizeof( path ), "%s/%s", folder, demolist[i].filename );
			Com_Printf( "Removing old clientrecord demo: %s\n", path );
			if( !FS_RemoveFile( path ) )
			{
				Com_Printf( "Error, couldn't remove file: %s\n", path );
				continue;
			}

			demolist[i].filename = NULL;
			memmove( &demolist[i], &demolist[i+1], (numdemos - i) * sizeof( *demolist ) );
			numdemos--;
		}
	}

	if( maxdemos > 0 )
	{
		// sort by sortKey
		qsort( demolist, numdemos, sizeof( racedemo_t ), ( int ( * )( const void *, const void * ) )SV_RaceDemo_Purge_Sort );

		// remove excess
		for( i = 0; i < numdemos; i++ )
		{
			Mem_TempFree( demolist[i].remainder );

			if( i >= maxdemos )
			{
				Q_snprintfz( path, sizeof( path ), "%s/%s", folder, demolist[i].filename );
				Com_Printf( "Removing old clientrecord demo: %s\n", path );
				if( !FS_RemoveFile( path ) )
				{
					Com_Printf( "Error, couldn't remove file: %s\n", path );
				}
			}
		}
	}

	Mem_TempFree( demolist );

	Mem_TempFree( buffer );
}
