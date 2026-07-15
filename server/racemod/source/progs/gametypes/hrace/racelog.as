// Race event log for external stats collection.
//
// Appends one machine-readable line per finished (non-practice) race to
// racelog/events.log inside the mod's write directory. A sidecar service
// (see collector/ in the deployment repo) tails this file and ships the
// results to the central stats database.
//
// Line format (tab-separated; the player name goes last because it is the
// only field that may contain arbitrary characters):
//
//   R1 <map> <finishTimeMs> <login> <cp1,cp2,...,cpN> <playerName>
//
// Checkpoint times are absolute milliseconds in spatial order, one entry per
// map checkpoint (the finish time is not repeated in the list); 0 means the
// checkpoint was not passed. <login> is the matchmaker login and is usually
// empty now that the auth servers are gone.

const String RACELOG_FILE = "racelog/events.log";

// Direct-to-API reporting (RS_ApiReportRace native, see the deployment repo's
// server/enginepatches/g_rs_api.cpp). When rs_api_url is set, every finish is
// POSTed straight to the central /api/ingest with the rs_api_token bearer
// token — no log-scraping sidecar needed. The events.log append below is kept
// as a local audit trail / fallback either way.
Cvar rsApiUrl( "rs_api_url", "", 0 );
Cvar rsApiToken( "rs_api_token", "", 0 );
Cvar rsApiVersion( "rs_api_version", "wsw 2.1", 0 );

// --- Attempt tracking ---------------------------------------------------
// Every race START (startRace() in player.as) counts as an attempt, whether
// or not it reaches the finish. Starts are tallied locally per client and
// flushed to the API: attached to the player's next finish report (the
// cheap, common path — the count rides in the same POST), or standalone via
// RS_ApiReportAttempts when there is no finish to ride on (the player
// disconnects, or the map ends mid-run). Practice-mode runs never call
// startRace(), so they are never counted.
uint[] pendingAttempts( maxClients );

void RACE_AttemptStarted( Player @player )
{
    pendingAttempts[ player.client.playerNum ]++;
}

// Flush one client's unreported starts without a finish report.
void RACE_FlushAttempts( Client @client )
{
    if ( @client == null )
        return;
    uint n = pendingAttempts[ client.playerNum ];
    if ( n == 0 )
        return;
    pendingAttempts[ client.playerNum ] = 0;

    if ( rsApiUrl.string.length() == 0 )
        return;
    Cvar mapNameVar( "mapname", "", 0 );
    RS_ApiReportAttempts( rsApiUrl.string, rsApiToken.string, rsApiVersion.string,
            mapNameVar.string.tolower(), client.name, client.getMMLogin(), int( n ) );
}

// Map is ending: flush everyone still holding uncounted starts (the script
// globals reset on map change, so anything unflushed here would be lost).
void RACE_FlushAllAttempts()
{
    for ( int i = 0; i < maxClients; i++ )
    {
        if ( pendingAttempts[ i ] == 0 )
            continue;
        Client@ client = G_GetClient( i );
        if ( @client == null || client.state() < CS_SPAWNED )
        {
            pendingAttempts[ i ] = 0; // owner already gone; nothing to attribute
            continue;
        }
        RACE_FlushAttempts( client );
    }
}

void RACE_LogFinish( Player @player )
{
    if ( !player.current_recordTime.isFinished() )
        return;

    Cvar mapNameVar( "mapname", "", 0 );
    String mapName = mapNameVar.string.tolower();

    String cps = "";
    for ( uint i = 0; i < numCheckpoints; i++ )
    {
        if ( i > 0 )
            cps += ",";
        cps += int( player.current_recordTime.checkpoints[ i ].time );
    }

    // Starts since this player's last flush ride along with the finish (the
    // one that produced this finish is included in the count).
    uint attempts = pendingAttempts[ player.client.playerNum ];
    pendingAttempts[ player.client.playerNum ] = 0;

    if ( rsApiUrl.string.length() > 0 )
    {
        RS_ApiReportRace( rsApiUrl.string, rsApiToken.string, rsApiVersion.string,
                mapName,
                player.current_recordTime.ident.playerName,
                player.current_recordTime.ident.login,
                int( player.current_recordTime.getFinishTime() ),
                int( attempts ),
                cps );
    }

    bool ok = G_AppendToFile( RACELOG_FILE, "R1\t" + mapName
            + "\t" + int( player.current_recordTime.getFinishTime() )
            + "\t" + player.current_recordTime.ident.login
            + "\t" + cps
            + "\t" + player.current_recordTime.ident.playerName
            + "\n" );

    // Surface the failure loudly instead of silently dropping the finish — the
    // usual cause is the racelog dir/file not being writable by the server
    // user (see server/entrypoint.sh, which pre-creates it).
    if ( !ok )
        G_Print( "^1racelog: FAILED to append to " + RACELOG_FILE
                + " — race finish not recorded (check racelog dir permissions)\n" );
}
