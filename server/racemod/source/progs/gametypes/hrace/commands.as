bool Cmd_GametypeMenu( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    client.execGameCommand( "meop racemod_main" );
    return true;
}

bool Cmd_Gametype( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    String response = "";
    Cvar fs_game( "fs_game", "", 0 );
    String manifest = gametype.manifest;

    response += "\n";
    response += "Gametype " + gametype.name + " : " + gametype.title + "\n";
    response += "----------------\n";
    response += "Version: " + gametype.version + "\n";
    response += "Author: " + gametype.author + "\n";
    response += "Mod: " + fs_game.string + ( !manifest.empty() ? " (manifest: " + manifest + ")" : "" ) + "\n";
    response += "----------------\n";

    G_PrintMsg( client.getEnt(), response );
    return true;
}

bool Cmd_CvarInfo( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    GENERIC_CheatVarResponse( client, cmdString, argsString, argc );
    return true;
}

String randmap;
String randmap_passed = "";
uint randmap_time = 0;
uint randmap_matches;
const uint RANDMAP_DELAY_MIN = 80;
const uint RANDMAP_DELAY_MAX = 1100;

bool Cmd_CallvoteValidate( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    String votename = argsString.getToken( 0 );

    if ( votename == "randmap" )
    {
        if ( levelTime - randmap_time > RANDMAP_DELAY_MAX )
        {
            Cvar mapname( "mapname", "", 0 );
            String current = mapname.string;
            String pattern = argsString.getToken( 1 );

            String[] maps = GetMapsByPattern( pattern, current );

            if ( maps.length() == 0 )
            {
                client.printMessage( "No matching maps\n" );
                return false;
            }

            randmap_matches = maps.length();
            randmap = maps[randrange(randmap_matches)];
        }

        if ( levelTime - randmap_time < RANDMAP_DELAY_MIN )
        {
            G_PrintMsg( null, S_COLOR_YELLOW + "Chosen map: " + S_COLOR_WHITE + randmap + S_COLOR_YELLOW + " (out of " + S_COLOR_WHITE + randmap_matches + S_COLOR_YELLOW + " matches)\n" );
            return true;
        }

        randmap_time = levelTime;
    }
    else
    {
        client.printMessage( "Unknown callvote " + votename + "\n" );
        return false;
    }

    return true;
}

bool Cmd_CallvotePassed( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    String votename = argsString.getToken( 0 );

    if ( votename == "randmap" )
    {
        randmap_passed = randmap;
        match.launchState( MATCH_STATE_POSTMATCH );
    }

    return true;
}

const int MAX_FLOOD_MESSAGES = 32;

bool Cmd_PrivateMessage( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( client.muted > 0 )
    {
        G_PrintMsg( client.getEnt(), "You are muted.\n" );
        return false;
    }

    Player@ player = RACE_GetPlayer( client );
    if ( player.messageLock > realTime )
    {
        G_PrintMsg( client.getEnt(), "You can't talk for " + ( ( player.messageLock - realTime ) / 1000 ) + " more seconds.\n" );
        return false;
    }

    String pattern = argsString.getToken( 0 );
    Player@[] matches = RACE_MatchPlayers( pattern );
    if ( matches.length() == 0 )
    {
        G_PrintMsg( client.getEnt(), "No players matched.\n" );
        return false;
    }
    else if ( matches.length() > 1 )
    {
        G_PrintMsg( client.getEnt(), "Multiple players matched.\n" );
        return false;
    }

    String message = "";
    String token;
    int i = 1;
    do
    {
        token = argsString.getToken( i );
        if ( i++ > 1 )
            message += " ";
        message += token;
    }
    while ( token != "" );

    if ( i == 2 )
    {
        G_PrintMsg( client.getEnt(), "Empty message.\n" );
        return false;
    }

    Cvar maxMessages( "g_floodprotection_messages", "", 0 );
    Cvar maxMessageTime( "g_floodprotection_seconds", "", 0 );
    uint ref = player.messageTimes[MAX_FLOOD_MESSAGES - maxMessages.integer];
    if ( ref > 0 && ref + uint( maxMessageTime.integer * 1000 ) > realTime )
    {
        Cvar lockTime( "g_floodprotection_delay", "", 0 );
        player.messageLock = realTime + lockTime.integer * 1000;
        G_PrintMsg( client.getEnt(), "Flood protection: You can't talk for " + lockTime.integer + " seconds.\n" );
        return false;
    }

    G_PrintMsg( matches[0].client.getEnt(), client.name + S_COLOR_MAGENTA + " >>> " + S_COLOR_WHITE + message + "\n" );
    if ( matches[0].firstMessage )
    {
        G_PrintMsg( matches[0].client.getEnt(), "Use /m with part of the player name to reply.\n" );
        matches[0].firstMessage = false;
    }
    G_PrintMsg( client.getEnt(), matches[0].client.name + S_COLOR_MAGENTA + " <<< " + S_COLOR_WHITE + message + "\n" );

    for ( i = 0; i < MAX_FLOOD_MESSAGES - 1; i++ )
        player.messageTimes[i] = player.messageTimes[i + 1];
    player.messageTimes[MAX_FLOOD_MESSAGES - 1] = realTime;

    return true;
}

bool Cmd_RaceRestart( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    Player@ player = RACE_GetPlayer( client );

    // for accuracy, reset scores.
    target_score_init( client );

    if ( pending_endmatch || match.getState() >= MATCH_STATE_POSTMATCH )
    {
        if ( !( player.inRace || player.postRace ) )
            return true;
    }

    player.cancelRace();

    // Player metric: a deliberate run reset. Only the explicit restart commands
    // by a racer count — a spectator's /join (which also routes here) is a team
    // change, not a restart.
    if ( ( cmdString == "kill" || cmdString == "racerestart" )
            && client.team != TEAM_SPECTATOR )
        RACE_Restarted( client );

    if ( player.practicing && client.team != TEAM_SPECTATOR )
    {
        Entity@ ent = client.getEnt();
        // Un-freeze a recall-held (MOVETYPE_NONE) player inline; routing through
        // toggleNoclip() here would spuriously print "Noclip mode disabled."
        if ( ent.moveType == MOVETYPE_NONE )
        {
            ent.moveType = MOVETYPE_PLAYER;
            player.release = 0;
            player.client.selectWeapon( player.noclipWeapon );
            player.noclipBackup.saved = false;
        }

        if ( ent.health >= 0 && player.loadPosition( "", Verbosity_Silent ) )
        {
            player.noclipWeapon = player.savedPosition().weapon;
            // A position saved at a standstill (0 speed) would strand the player;
            // respawn instead so the run can actually start.
            if ( player.getSpeed() == 0 )
                client.respawn( false );
        }
        else
            client.respawn( false );

        if ( ent.moveType == MOVETYPE_NOCLIP )
            ent.velocity = Vec3();

        // Recall delay: freeze a recalled restart (unless a respawn above already
        // froze it via GT_PlayerRespawn) so walljump/dash starts stay consistent.
        if ( player.recalled && ent.moveType != MOVETYPE_NONE )
        {
            ent.moveType = MOVETYPE_NONE;
            player.noclipWeapon = ent.client.pendingWeapon; // for manual-unfreeze restore
            player.release = player.recallHold;
        }
    }
    else
    {
        if ( client.team == TEAM_SPECTATOR )
        {
            client.team = TEAM_PLAYERS;
            G_PrintMsg( null, client.name + S_COLOR_WHITE + " joined the " + G_GetTeam( client.team ).name + S_COLOR_WHITE + " team.\n" );
        }
        client.respawn( false );
    }

    return true;
}

bool Cmd_Practicemode( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    RACE_GetPlayer( client ).togglePracticeMode();
    return true;
}

bool Cmd_Noclip( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    Player@ player = RACE_GetPlayer( client );
    return player.toggleNoclip();
}

// /reverse — race the map backwards. Enabling it teleports you to just outside
// the map's FINISH line (your reverse start) and drops you into a fine-tune
// noclip; leaving the noclip (/noclip, or /reverse again) locks that spot in as
// your spawn. Crossing the finish line then starts the timed run and crossing
// the START line finishes it, recorded to the "<map>-reversed" level entirely
// separate from normal times. "/reverse off" (or /reverse while armed) forces
// it off.
bool Cmd_Reverse( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    Player@ player = RACE_GetPlayer( client );
    String action = argsString.getToken( 0 ).tolower();

    if ( player.inRace )
    {
        client.printMessage( S_COLOR_RED + "Finish or /racerestart before toggling reverse mode.\n" );
        return false;
    }

    if ( action == "off" )
    {
        if ( player.reversed )
            return player.disableReverse();
        client.printMessage( "Reverse mode is already off.\n" );
        return false;
    }

    if ( !player.reversed )
        return player.enableReverse();   // OFF -> SETUP (teleport + fine-tune noclip)
    else if ( player.reverseSetup )
        return player.finalizeReverse(); // SETUP -> ARMED (leave noclip, save spawn)
    else
        return player.disableReverse();  // ARMED -> OFF
}

// /showtriggers — toggle per-player beacons marking the start and finish trigger
// planes, so it's obvious where to cross (especially the finish, which is the
// reverse start). Visible only to the player who ran the command.
bool Cmd_ShowTriggers( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    return RACE_GetPlayer( client ).toggleTriggerMarkers();
}

bool Cmd_Position( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    String action = argsString.getToken( 0 );
    Player@ player = RACE_GetPlayer ( client );
    if ( action == "save" )
        return player.savePosition( argsString.getToken( 1 ) );
    else if ( action == "load" )
        return player.loadPosition( argsString.getToken( 1 ), Verbosity_Verbose );
    else if ( action == "list" )
    {
        player.listPositions();
        return true;
    }
    else if ( action == "find" )
        return player.findPosition( argsString.getToken( 1 ).tolower(), argsString.getToken( 2 ).tolower() );
    else if ( action == "join" )
        return player.joinPosition( argsString.getToken( 1 ) );
    else if ( action == "recall" )
    {
        String option = argsString.getToken( 1 ).tolower();
        if ( option == "exit" )
            return player.recallExit();
        else if ( option == "steal" )
            return player.recallSteal();
        else if ( option == "best" )
        {
            String pattern = argsString.getToken( 2 );
            return player.recallBest( pattern );
        }
        else if ( option == "current" )
            return player.recallCurrent( argsString.getToken( 2 ) );
        else if ( option == "fake" )
            return player.recallFake( uint( argsString.getToken( 2 ).toInt() ) );
        else if ( option == "interval" )
            return player.recallInterval( argsString.getToken( 2 ) );
        else if ( option == "delay" )
            return player.recallDelay( argsString.getToken( 2 ) );
        else if ( option == "extend" )
            return player.recallExtend( argsString.getToken( 2 ).tolower() );
        else if ( option == "start" )
            return player.recallStart();
        else if ( option == "end" )
            return player.recallEnd();
        else if ( option.substr( 0, 2 ) == "cp" )
        {
            int cp = option.substr( 2 ).toInt();
            return player.recallCheckpoint( cp );
        }
        else if ( option == "rl" || option == "pg" || option == "gl" )
        {
            uint weapon = 0;
            if ( option == "rl" )
                weapon = WEAP_ROCKETLAUNCHER;
            if ( option == "pg" )
                weapon = WEAP_PLASMAGUN;
            if ( option == "gl" )
                weapon = WEAP_GRENADELAUNCHER;
            return player.recallWeapon( weapon );
        }
        else
            return player.recallPosition( option.toInt() );
    }
    else if ( action == "speed" && argsString.getToken( 1 ) != "" )
    {
        String speedStr = argsString.getToken( 1 );
        return player.positionSpeed( speedStr, argsString.getToken( 2 ) );
    }
    else if ( action == "clear" )
        return player.clearPosition( argsString.getToken( 1 ) );
    else
    {
        G_PrintMsg( client.getEnt(), "position <save [name] | load [name] | list | find <type> [info] | join <player> | speed <value> [name] | recall <offset> | clear [name]>\n" );
        return false;
    }
}

bool Cmd_Mark( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    return RACE_GetPlayer( client ).setMarker( argsString.getToken( 0 ) );
}

bool Cmd_PreRandmap( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    Player@ player = RACE_GetPlayer( client );
    String pattern = argsString.getToken( 0 );
    if ( pattern == "" )
    {
        client.printMessage( "Usage: /prerandmap <* | pattern>\n" );
        return false;
    }

    String result = player.randomMap( pattern, true );
    if ( result == "" )
        return false;

    client.printMessage( S_COLOR_YELLOW + "Showing top for " + S_COLOR_WHITE + result + "\n" );
    RACE_ShowMapTop( client, result.tolower() );

    client.printMessage( S_COLOR_YELLOW + "Chosen map: " + S_COLOR_WHITE + result + S_COLOR_YELLOW + " (out of " + S_COLOR_WHITE + player.randmapMatches + S_COLOR_YELLOW + " matches)\n" );
    return true;
}

bool Cmd_LastRecs( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    return lastRecords.show( client.getEnt() );
}

// On-demand per-checkpoint splits for your current/last run (vs personal best
// and the server record). Reuses RecordTime.report(), the same proven display
// shown automatically on finish/kill.
bool Cmd_CPs( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    Player@ player = RACE_GetPlayer( client );
    // Re-derive checkpoint order from times (robust to a recall/load having
    // mutated currentCheckpoint) before checking/printing.
    player.current_recordTime.deduceCheckpointOrder();
    if ( player.current_recordTime.checkpoint_order[ 0 ] == UINT_MAX )
    {
        client.printMessage( S_COLOR_RED + "No checkpoint splits recorded for your current run.\n" );
        return true;
    }
    player.current_recordTime.report( player );
    return true;
}

// Where "/top" points players to see the full leaderboards. Admin-overridable
// (e.g. a self-hosted stats site); defaults to the historical livesow address.
Cvar race_toplists( "race_toplists", "http://livesow.net/race", CVAR_ARCHIVE );

// Print another map's stored top board (read from its topscores file) without
// loading it. Shared by "/top <map>" and "/prerandmap".
void RACE_ShowMapTop( Client@ client, const String &in mapName )
{
    RecordTime[] records = RACE_ReadTopScoresFile( mapName );
    if ( records.length() == 0 || !records[ 0 ].isFinished() )
    {
        client.printMessage( S_COLOR_RED + "No records found for map \"" + mapName + "\".\n" );
        return;
    }

    RecordTime@ mapTop = records[ 0 ];
    client.printMessage( S_COLOR_WHITE + "Top records for " + S_COLOR_YELLOW + mapName.tolower() + S_COLOR_WHITE + ":\n" );

    Table maptable( "r r r l l" );
    int shown = ( int( records.length() ) < DISPLAY_RECORDS ) ? int( records.length() ) : DISPLAY_RECORDS;
    for ( int i = 0; i < shown; i++ )
    {
        RecordTime@ record = records[ i ];
        if ( record.isFinished() )
        {
            maptable.addCell( ( i + 1 ) + "." );
            maptable.addCell( S_COLOR_GREEN + RACE_TimeToString( record.getFinishTime() ) );
            maptable.addCell( S_COLOR_YELLOW + "[+" + RACE_TimeToString( record.getFinishTime() - mapTop.getFinishTime() ) + "]" );
            maptable.addCell( S_COLOR_WHITE + record.ident.playerName );
            if ( record.ident.login != "" )
                maptable.addCell( "(" + S_COLOR_YELLOW + record.ident.login + S_COLOR_WHITE + ")" );
            else
                maptable.addCell( "" );
        }
    }
    uint maprows = maptable.numRows();
    for ( uint i = 0; i < maprows; i++ )
        client.printMessage( maptable.getRow( i ) + "\n" );
}

bool Cmd_Top( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    // "/top <map>": inspect another map's stored board without loading it. The
    // records are read straight from that map's topscores file into a scratch
    // array, so the live level board and HUD are untouched.
    String mapName = argsString.getToken( 0 );
    if ( mapName != "" )
    {
        RACE_ShowMapTop( client, mapName );
        return true;
    }

    // Show the board matching the player's current mode: a reversed racer's
    // "/top" reflects the "<map>-reversed" leaderboard.
    RecordTime[]@ levelRecords = RACE_Records( RACE_GetPlayer( client ).reversed );
    RecordTime@ top = levelRecords[ 0 ];
    if ( !top.isFinished() )
    {
        client.printMessage( S_COLOR_RED + "No records yet.\n" );
    }
    else
    {
        Table table( "r r r l l" );
        for ( int i = 0; i < DISPLAY_RECORDS; i++ )
        {
            RecordTime@ record = levelRecords[i];
            if ( record.isFinished() )
            {
                table.addCell( ( i + 1 ) + "." );
                table.addCell( S_COLOR_GREEN + RACE_TimeToString( record.getFinishTime() ) );
                table.addCell( S_COLOR_YELLOW + "[+" + RACE_TimeToString( record.getFinishTime() - top.getFinishTime() ) + "]" );
                table.addCell( S_COLOR_WHITE + record.ident.playerName );
                if ( record.ident.login != "" )
                    table.addCell( "(" + S_COLOR_YELLOW + record.ident.login + S_COLOR_WHITE + ")" );
                else
                    table.addCell( "" );
            }
        }
        uint rows = table.numRows();
        for ( uint i = 0; i < rows; i++ )
            client.printMessage( table.getRow( i ) + "\n" );
    }

    return true;
}

const uint MAPS_PER_PAGE = 30;
uint[] maplist_page( maxClients );

bool Cmd_Maplist( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    String arg1 = argsString.getToken( 0 ).tolower();
    String arg2 = argsString.getToken( 1 ).tolower();
    uint old_page = maplist_page[client.playerNum];
    int page;
    int last_page;

    if ( arg1 == "" )
    {
        client.printMessage( "maplist <* | pattern> [<page# | prev | next>]\n" );
        return false;
    }

    String pattern = arg1;

    if ( arg2 == "next" )
        page = old_page + 1;
    else if ( arg2 == "prev" )
        page = old_page - 1;
    else if ( arg2.isNumeric() )
        page = arg2.toInt() - 1;
    else if ( arg2 == "" )
        page = 0;
    else
    {
        client.printMessage( "Page must be a number, \"prev\" or \"next\".\n" );
        return false;
    }

    String[] maps = GetMapsByPattern( pattern );

    if ( maps.length() == 0 )
    {
        client.printMessage( "No matching maps\n" );
        return false;
    }

    Table maplist("l l l");

    last_page = maps.length() / MAPS_PER_PAGE;

    if ( page < 0 || page > last_page )
    {
        client.printMessage( "Page doesn't exist.\n" );
        return false;
    }
    maplist_page[client.playerNum] = page;

    uint start = MAPS_PER_PAGE * page;
    uint end = MAPS_PER_PAGE * ( page + 1 );
    if ( end > maps.length() )
    end = maps.length();

    for ( uint i = start; i < end; i++ )
    {
        if ( i >= maps.length() )
            break;
        maplist.addCell( S_COLOR_WHITE + maps[i] );
    }

    client.printMessage( S_COLOR_YELLOW + "Found " + S_COLOR_WHITE + maps.length() + S_COLOR_YELLOW + " maps" +
    S_COLOR_WHITE + " (" + (start+1) + "-" + end + "), " + S_COLOR_YELLOW + "page " + S_COLOR_WHITE + (page+1) + "/" + (last_page+1) + "\n" );

    for ( uint i = 0; i < maplist.numRows(); i++ )
        client.printMessage( maplist.getRow(i) + "\n" );

    return true;
}

bool Cmd_Help( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    String command = argsString.getToken( 0 ).tolower();
    String subcommand = argsString.getToken( 1 ).tolower();

    if ( command == "" )
    {
        Table cmdlist( S_COLOR_YELLOW + "l " + S_COLOR_WHITE + "l" );
        cmdlist.addCell( "/kill /racerestart" );
        cmdlist.addCell( "Respawns you." );

        cmdlist.addCell( "/practicemode" );
        cmdlist.addCell( "Toggles between race and practicemode." );

        cmdlist.addCell( "/noclip" );
        cmdlist.addCell( "Lets you move freely through the world whilst in practicemode." );

        cmdlist.addCell( "/reverse" );
        cmdlist.addCell( "Race the map in reverse (finish->start); teleports you to the start, recorded separately." );

        cmdlist.addCell( "/showtriggers" );
        cmdlist.addCell( "Toggle markers showing the start and finish trigger planes (only you see them)." );

        cmdlist.addCell( "/position save" );
        cmdlist.addCell( "Saves your position including your weapons as the new spawn position." );

        cmdlist.addCell( "/position load" );
        cmdlist.addCell( "Teleports you to your saved position." );

        cmdlist.addCell( "/position speed" );
        cmdlist.addCell( "Sets the speed at which you spawn in practicemode." );

        cmdlist.addCell( "/position clear" );
        cmdlist.addCell( "Resets your weapons and spawn position to their defaults." );

        cmdlist.addCell( "/top <map>" );
        cmdlist.addCell( "Shows the top record times for the current map, or the given map." );

        cmdlist.addCell( "/mark <player>" );
        cmdlist.addCell( "Places a marker at your position (or copies another player's marker)." );

        cmdlist.addCell( "/m" );
        cmdlist.addCell( "Lets you send a private message." );

        cmdlist.addCell( "/prerandmap <*|pattern>" );
        cmdlist.addCell( "Previews a random map (and its top scores) matching a pattern." );

        cmdlist.addCell( "/lastrecs" );
        cmdlist.addCell( "Shows the most recent records set on this server across maps." );

        cmdlist.addCell( "/cps" );
        cmdlist.addCell( "Shows your per-checkpoint splits vs your PB and the server record." );

        cmdlist.addCell( "/maplist" );
        cmdlist.addCell( "Lets you search available maps." );

        cmdlist.addCell( "/callvote map" );
        cmdlist.addCell( "Calls a vote for the specified map." );

        cmdlist.addCell( "/callvote randmap" );
        cmdlist.addCell( "Calls a vote for a random map in the current mappool." );

        cmdlist.addCell( "/flag <reason>" );
        cmdlist.addCell( "Flags the current map for moderator review (broken, offensive, etc.)." );

        for ( uint i = 0; i < cmdlist.numRows(); i++ )
            client.printMessage( cmdlist.getRow(i) + "\n" );

        client.printMessage( S_COLOR_WHITE + "use " + S_COLOR_YELLOW + "/help <cmd> " + S_COLOR_WHITE + "for additional information." + "\n");
    }
    else if ( command == "m" )
    {
        client.printMessage( S_COLOR_YELLOW + "/m name message" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Sends a private message to the player whose name matches." + "\n" );
    }
    else if ( command == "kill" || command == "racerestart" )
    {
        client.printMessage( S_COLOR_YELLOW + "/kill /racerestart" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Respawns you. I mean srsly.. that's it." + "\n" );
    }
    else if ( command == "practicemode" )
    {
        client.printMessage( S_COLOR_YELLOW + "/practicemode" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Toggles between race and practicemode. Race mode is the only mode in which your time will" + "\n" );
        client.printMessage( S_COLOR_WHITE + "  be recorded. Practicemode is used to practice specific parts of the map. Some commands are" + "\n" );
        client.printMessage( S_COLOR_WHITE + "  restricted to practicemode." + "\n" );
    }
    else if ( command == "noclip" )
    {
        client.printMessage( S_COLOR_YELLOW + "/noclip" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Lets you move freely through the world whilst in practicemode. Use this command to get more" + "\n" );
        client.printMessage( S_COLOR_WHITE + "  control over your position when using /position save. Only works in practicemode." + "\n" );
    }
    else if ( command == "reverse" )
    {
        client.printMessage( S_COLOR_YELLOW + "/reverse" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Race the course backwards. Running /reverse teleports you to just outside the map's FINISH" + "\n" );
        client.printMessage( S_COLOR_WHITE + "  line (your reverse start) and drops you into noclip to fine-tune the spot. Leave noclip" + "\n" );
        client.printMessage( S_COLOR_WHITE + "  (/noclip, or /reverse again) to lock it in as your spawn, then cross the finish to start the" + "\n" );
        client.printMessage( S_COLOR_WHITE + "  timer, run the checkpoints in reverse, and cross the START line to finish. Prejump rules" + "\n" );
        client.printMessage( S_COLOR_WHITE + "  still apply. Reverse times are recorded separately as '<map>-reversed'. /reverse off cancels." + "\n" );
    }
    else if ( command == "showtriggers" )
    {
        client.printMessage( S_COLOR_YELLOW + "/showtriggers" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Toggles translucent markers at the centre of the start and finish trigger planes, so you can" + "\n" );
        client.printMessage( S_COLOR_WHITE + "  see where to cross (handy for reverse mode, where the finish is your start). Only you see them." + "\n" );
    }
    else if ( command == "position" && subcommand == "save" )
    {
        client.printMessage( S_COLOR_YELLOW + "/position save" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Saves your position including your weapons as the new spawn position. You can save a separate" + "\n" );
        client.printMessage( S_COLOR_WHITE + "  position for prerace and practicemode, depending on which mode you are in when using the command." + "\n" );
        client.printMessage( S_COLOR_WHITE + "  Note: Using this command during race will save your position for practicemode." + "\n" );
    }
    else if ( command == "position" && subcommand == "load" )
    {
        client.printMessage( S_COLOR_YELLOW + "/position load" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Teleports you to your saved position depending on which mode you are in." + "\n" );
        client.printMessage( S_COLOR_WHITE + "  Note: This command does not work during race." + "\n" );
    }
    else if ( command == "position" && subcommand == "find" )
    {
        client.printMessage( S_COLOR_YELLOW + "/position find <start|finish|rl|gl|pg|push|door|button|cp|tele|slick> [info]" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Teleports you to a notable map entity; repeat to cycle through matches. With no type," + "\n" );
        client.printMessage( S_COLOR_WHITE + "  prints map stats. Add 'info' to print entity details instead of teleporting." + "\n" );
    }
    else if ( command == "position" && subcommand == "join" )
    {
        client.printMessage( S_COLOR_YELLOW + "/position join <player>" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Teleports you to a live player's current position (practicemode/spectator only)." + "\n" );
    }
    else if ( command == "mark" )
    {
        client.printMessage( S_COLOR_YELLOW + "/mark <player>" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Drops a marker dummy at your position as a visual reference. With a player name," + "\n" );
        client.printMessage( S_COLOR_WHITE + "  copies that player's marker instead. Use /mark with no marker set to clear it." + "\n" );
    }
    else if ( command == "prerandmap" )
    {
        client.printMessage( S_COLOR_YELLOW + "/prerandmap <*|pattern>" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Previews a random map matching the pattern (use * for any) and shows its top scores." + "\n" );
    }
    else if ( command == "lastrecs" )
    {
        client.printMessage( S_COLOR_YELLOW + "/lastrecs" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Shows the most recent records set on this server (across maps), with who beat whom." + "\n" );
    }
    else if ( command == "cps" )
    {
        client.printMessage( S_COLOR_YELLOW + "/cps" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Shows your per-checkpoint split times for the current run, compared to your" + "\n" );
        client.printMessage( S_COLOR_WHITE + "  personal best and the server record." + "\n" );
    }
    else if ( command == "position" && subcommand == "speed" )
    {
        client.printMessage( S_COLOR_YELLOW + "/position speed <value>" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Example: /position speed 1000 - Sets your spawn speed to 1000." + "\n" );
        client.printMessage( S_COLOR_WHITE + "  Sets the speed at which you spawn in practicemode. This does not affect prerace speed." + "\n" );
        client.printMessage( S_COLOR_WHITE + "  Use /position speed 0 to reset. Note: You don't get spawn speed while in noclip mode." + "\n" );
    }
    else if ( command == "position" && subcommand == "clear" )
    {
        client.printMessage( S_COLOR_YELLOW + "/position clear" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Resets your weapons and spawn position to their defaults." + "\n" );
    }
    else if ( command == "position" && subcommand == "recall" )
    {
        client.printMessage( S_COLOR_YELLOW + "/position recall exit" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Leave recall mode." + "\n" );
        client.printMessage( S_COLOR_YELLOW + "/position recall best [player]" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Loads positions from your best run, or a matching player." + "\n" );
        client.printMessage( S_COLOR_YELLOW + "/position recall current <player>" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Loads the in-progress run from a matching player." + "\n" );
        client.printMessage( S_COLOR_YELLOW + "/position recall steal" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Loads current positions from the player you are spectating." + "\n" );
        client.printMessage( S_COLOR_YELLOW + "/position recall fake [time]" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Marks your saved position as a recalled-run start at the given time." + "\n" );
        client.printMessage( S_COLOR_YELLOW + "/position recall extend [on|off]" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Toggles auto-recall: extend a recalled run by moving forward." + "\n" );
        client.printMessage( S_COLOR_YELLOW + "/position recall interval [n|auto]" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Sets ms between recall samples ('auto' fits a full best run)." + "\n" );
        client.printMessage( S_COLOR_YELLOW + "/position recall delay [n]" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Sets frames frozen after respawning into a recalled position." + "\n" );
        client.printMessage( S_COLOR_YELLOW + "/position recall start" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Moves to the first recalled position." + "\n" );
        client.printMessage( S_COLOR_YELLOW + "/position recall end" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Moves to the last recalled position." + "\n" );
        client.printMessage( S_COLOR_YELLOW + "/position recall cpX" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Moves to the first position past checkpoint X." + "\n" );
        client.printMessage( S_COLOR_YELLOW + "/position recall rl" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Moves to the first position with a rocket launcher." + "\n" );
        client.printMessage( S_COLOR_YELLOW + "/position recall pg" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Moves to the first position with a plasma gun." + "\n" );
        client.printMessage( S_COLOR_YELLOW + "/position recall gl" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Moves to the first position with a grenade launcher." + "\n" );
        client.printMessage( S_COLOR_YELLOW + "/position recall <offset>" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Cycles through automatically saved positions from your previous run." + "\n" );
    }
    else if ( command == "top" )
    {
        client.printMessage( S_COLOR_YELLOW + "/top <map>" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Shows a list of the top record times for the current map (or the given map) along with the names and time" + "\n" );
        client.printMessage( S_COLOR_WHITE + "  difference compared to the number 1 time. To see all lists visit: " + race_toplists.string + "." + "\n" );
    }
    else if ( command == "maplist" )
    {
        client.printMessage( S_COLOR_YELLOW + "/maplist <* | pattern> [<page# | prev | next>]" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Shows a list of available maps. Use wildcard '*' to list all maps. Alternatively, specify a" + "\n" );
        client.printMessage( S_COLOR_WHITE + "  pattern keyword for a list of maps containing the pattern as a partial match. The second" + "\n" );
        client.printMessage( S_COLOR_WHITE + "  argument is optional and is used to browse multiple pages of results." + "\n" );
    }
    else if ( command == "callvote" && subcommand == "map" )
    {
        client.printMessage( S_COLOR_YELLOW + "/callvote map <mapname>" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Calls a vote for the specified map. You can use /maplist to search for a map." + "\n" );
    }
    else if ( command == "callvote" && subcommand == "randmap" )
    {
        client.printMessage( S_COLOR_YELLOW + "/callvote randmap <* | pattern>" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Calls a vote for a random map in the current mappool. Use wildcard '*' to match any map." + "\n" );
        client.printMessage( S_COLOR_WHITE + "  Alternatively, specify a pattern keyword for a map containing the pattern as a partial match." + "\n" );
    }
    else if ( command == "flag" )
    {
        client.printMessage( S_COLOR_YELLOW + "/flag <reason>" + "\n" );
        client.printMessage( S_COLOR_WHITE + "- Flags the map you're on for review by the moderators. Use it for a map that's broken," + "\n" );
        client.printMessage( S_COLOR_WHITE + "  unfinishable, offensive, or a duplicate. Reason is optional (e.g. broken, offensive," + "\n" );
        client.printMessage( S_COLOR_WHITE + "  wrong_name, duplicate). Your name is attached automatically. Moderators can pull a" + "\n" );
        client.printMessage( S_COLOR_WHITE + "  bad map from the vote pool and cycle." + "\n" );
    }
    else
    {
        client.printMessage( S_COLOR_WHITE + "Command not found.\n");
    }

    return true;
}

bool Cmd_Rules( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    RACE_ShowRules(client, 0);
    return true;
}

// --- /flag: report the current map for review --------------------------------
// Players type "/flag <reason>" (reason optional: broken/offensive/wrong_name/
// duplicate). The player's name and MM login are pulled from their client (not
// typed) and attached, so moderators can see who reported it. Delivered to the
// central API by the RS_ApiFlag native (server/enginepatches/g_rs_api.cpp).
Cvar rsApiFlagUrl( "rs_api_flag_url", "", 0 );
uint[] lastFlagTime( maxClients );
const uint FLAG_COOLDOWN_MS = 30000;

bool Cmd_Flag( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( rsApiFlagUrl.string.length() == 0 )
    {
        client.printMessage( S_COLOR_RED + "Flagging is not available on this server.\n" );
        return false;
    }

    int pn = client.playerNum;
    if ( lastFlagTime[pn] != 0 && levelTime - lastFlagTime[pn] < FLAG_COOLDOWN_MS )
    {
        client.printMessage( S_COLOR_RED + "You just flagged a map - please wait a moment before flagging again.\n" );
        return false;
    }
    lastFlagTime[pn] = levelTime;

    String reason = argsString.getToken( 0 ).tolower();

    Cvar mapNameVar( "mapname", "", 0 );
    String mapName = mapNameVar.string.tolower();

    // Name + login come from the player's client, not from the command args.
    RS_ApiFlag( rsApiFlagUrl.string, rsApiToken.string, mapName, reason, client.name, client.getMMLogin() );

    client.printMessage( S_COLOR_GREEN + "Thanks - you flagged " + S_COLOR_WHITE + mapName
        + ( reason != "" ? S_COLOR_GREEN + " (" + S_COLOR_WHITE + reason + S_COLOR_GREEN + ")" : "" )
        + S_COLOR_GREEN + " for moderator review.\n" );
    return true;
}
