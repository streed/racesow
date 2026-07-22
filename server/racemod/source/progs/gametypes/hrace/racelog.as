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

// Reverse mode (see /reverse in commands.as): a run raced backwards through the
// course is a wholly separate record set. It is never distinguished by a flag —
// instead every map-scoped identity (the API report, the topscores file, the
// live top board, demos and ghosts) uses this suffixed name, so the stats site
// auto-creates a distinct "<map>-reversed" level with its own leaderboard. The
// suffix is deliberately regex-safe (no spaces) so it passes the game-facing
// read endpoints and the RS_ApiFetchTop native's map-name filter unchanged.
const String REVERSE_SUFFIX = "-reversed";

// The effective map name for a run: "<map>-reversed" for a reversed run, else
// the plain lowercased BSP name. Used everywhere a per-run map identity is
// derived (reporting, attempts, topscores, demos, ghosts).
String RACE_EffectiveMapName( bool reversed )
{
    Cvar mapNameVar( "mapname", "", 0 );
    String mapName = mapNameVar.string.tolower();
    return reversed ? mapName + REVERSE_SUFFIX : mapName;
}

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

// --- Movement / behaviour metrics ---------------------------------------
// Per-client tallies of movement events (wall jumps, dashes) and reset
// behaviour (prejump-rejected starts, /kill & /racerestart) accumulated the
// same way as attempts: incremented as the events happen, then flushed to the
// API riding on the player's next finish report (RACE_LogFinish) or a
// finish-less attempt flush (RACE_FlushAttempts). Like attempts, they only
// track genuine races — practice/free-roam movement is not counted. The stats
// site sums them per player into lifetime "player metrics".
uint[] pendingWallJumps( maxClients );
uint[] pendingDashes( maxClients );
uint[] pendingPrejumpFails( maxClients );
uint[] pendingRestarts( maxClients );

void RACE_AttemptStarted( Player @player )
{
    pendingAttempts[ player.client.playerNum ]++;
}

void RACE_WallJump( Player @player )
{
    pendingWallJumps[ player.client.playerNum ]++;
}

void RACE_Dash( Player @player )
{
    pendingDashes[ player.client.playerNum ]++;
}

void RACE_PrejumpFailed( Player @player )
{
    pendingPrejumpFails[ player.client.playerNum ]++;
}

void RACE_Restarted( Client @client )
{
    if ( @client == null )
        return;
    pendingRestarts[ client.playerNum ]++;
}

// Zero every pending movement metric for one client (used when its owner has
// vanished and there is nothing to attribute the counts to).
void RACE_ClearMetrics( int playerNum )
{
    pendingWallJumps[ playerNum ] = 0;
    pendingDashes[ playerNum ] = 0;
    pendingPrejumpFails[ playerNum ] = 0;
    pendingRestarts[ playerNum ] = 0;
}

// Flush one client's unreported starts without a finish report.
void RACE_FlushAttempts( Client @client )
{
    if ( @client == null )
        return;
    int pn = client.playerNum;
    uint n = pendingAttempts[ pn ];
    uint wj = pendingWallJumps[ pn ];
    uint da = pendingDashes[ pn ];
    uint pj = pendingPrejumpFails[ pn ];
    uint rs = pendingRestarts[ pn ];
    // Nothing to flush unless at least one counter is non-zero. Movement metrics
    // ride the same flush as attempts, but a lone /kill (no counted start) can
    // leave restarts pending with zero attempts — so gate on all of them.
    if ( n == 0 && wj == 0 && da == 0 && pj == 0 && rs == 0 )
        return;
    pendingAttempts[ pn ] = 0;
    RACE_ClearMetrics( pn );

    if ( rsApiUrl.string.length() == 0 )
        return;
    // Attribute the flush to the map variant the player is currently racing, so
    // reverse attempts land on the "<map>-reversed" level. (A run is wholly
    // reversed-or-not, so the current flag is the right bucket for its starts.)
    Player@ player = RACE_GetPlayer( client );
    String mapName = RACE_EffectiveMapName( player !is null && player.reversed );
    RS_ApiReportAttempts( rsApiUrl.string, rsApiToken.string, rsApiVersion.string,
            mapName, client.name, client.getMMLogin(), int( n ),
            int( wj ), int( da ), int( pj ), int( rs ) );
}

// Map is ending: flush everyone still holding uncounted starts (the script
// globals reset on map change, so anything unflushed here would be lost).
void RACE_FlushAllAttempts()
{
    for ( int i = 0; i < maxClients; i++ )
    {
        if ( pendingAttempts[ i ] == 0 && pendingWallJumps[ i ] == 0
                && pendingDashes[ i ] == 0 && pendingPrejumpFails[ i ] == 0
                && pendingRestarts[ i ] == 0 )
            continue;
        Client@ client = G_GetClient( i );
        if ( @client == null || client.state() < CS_SPAWNED )
        {
            pendingAttempts[ i ] = 0; // owner already gone; nothing to attribute
            RACE_ClearMetrics( i );
            continue;
        }
        RACE_FlushAttempts( client );
    }
}

void RACE_LogFinish( Player @player )
{
    if ( !player.current_recordTime.isFinished() )
        return;

    String mapName = RACE_EffectiveMapName( player.reversed );

    // Checkpoints are always emitted in physical (spatial id) order — the same
    // order the local topscores board and the apitop reload use. Keeping ONE
    // order across all three (local board, API report, API-fetched board) is
    // what makes the in-game per-checkpoint comparisons align regardless of the
    // board's source. For a reversed run this means the times run high id ->
    // low id descending (the finish is crossed first); the finish-time ranking
    // and the separate "<map>-reversed" leaderboard are unaffected. (A prettier
    // ascending per-segment split view for reversed maps on the website would be
    // a web-side follow-up.)
    String cps = "";
    for ( uint i = 0; i < numCheckpoints; i++ )
    {
        if ( i > 0 )
            cps += ",";
        cps += int( player.current_recordTime.checkpoints[ i ].time );
    }

    // Starts since this player's last flush ride along with the finish (the
    // one that produced this finish is included in the count). Movement metrics
    // accumulated since the last flush ride along the same way.
    int pn = player.client.playerNum;
    uint attempts = pendingAttempts[ pn ];
    uint wallJumps = pendingWallJumps[ pn ];
    uint dashes = pendingDashes[ pn ];
    uint prejumpFails = pendingPrejumpFails[ pn ];
    uint restarts = pendingRestarts[ pn ];
    pendingAttempts[ pn ] = 0;
    RACE_ClearMetrics( pn );

    if ( rsApiUrl.string.length() > 0 )
    {
        RS_ApiReportRace( rsApiUrl.string, rsApiToken.string, rsApiVersion.string,
                mapName,
                player.current_recordTime.ident.playerName,
                player.current_recordTime.ident.login,
                int( player.current_recordTime.getFinishTime() ),
                int( attempts ),
                cps,
                int( wallJumps ), int( dashes ),
                int( prejumpFails ), int( restarts ) );
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
