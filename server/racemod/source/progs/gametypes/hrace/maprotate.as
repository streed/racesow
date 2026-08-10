// Idle map rotation.
//
// The race gametype runs with g_timelimit 0, so match.timeLimitHit() is never
// true and GT_ThinkRules never advances the match past PLAYTIME. That means the
// engine's built-in rotation never gets a trigger and a server left alone sits
// on one map forever; only a player `callvote randmap` rotates it (that vote
// launches POSTMATCH explicitly). This module supplies the missing trigger:
// when the box has been EMPTY for rs_idle_rotate_minutes it switches to a random
// map from the rotation, so an unattended server keeps cycling.
//
// "Empty" means empty of people, not empty of racers — see RACE_AnyHumanPresent.
// Anyone connected holds the map, however idle they are; the only client that
// does not is the TV camera, which is permanently connected by design.
//
// The switch reuses the exact path a randmap vote uses: set randmap_passed and
// launch POSTMATCH; on an empty server Pending_AnyRacing() is false, so the
// state walks straight to WAITEXIT where GT_MatchStateFinished runs the chosen
// `map`.
//
// Where the map comes from: rs_idle_pool, a space-separated copy of the
// mappool.txt rotation that entrypoint.sh sets alongside g_maplist. We read that
// private cvar rather than g_maplist itself because putting an AngelScript Cvar
// handle on the engine-owned g_maplist re-registers it with an empty default and
// wipes the value (nothing re-sets it, unlike `mapname`), which would break the
// engine's own rotation and the vote pool. A private cvar is safe, same pattern
// as rs_api_*. Fail-open: an unset pool (old env.cfg) falls back to any installed
// map so the box still rotates; 0 minutes disables the feature entirely.

// Minutes with an empty server before it rotates; 0 disables. CVAR_ARCHIVE so it
// can be tuned or muted per box without a rebuild (the .as recompiles at server
// boot, not at Docker build time).
Cvar rs_idle_rotate_minutes( "rs_idle_rotate_minutes", "10", CVAR_ARCHIVE );

// The rotation list (space-separated map names), set by entrypoint.sh as a copy
// of g_maplist. Read through a GLOBAL handle like every other module's cvars.
Cvar rsIdlePool( "rs_idle_pool", "", 0 );

// levelTime (ms) when the server was first seen empty this map; 0 = not tracking
// (a real player is present, or we haven't observed an empty frame yet). Resets
// to 0 on every map change with the rest of the script globals.
uint raceIdleSince = 0;

// Is anybody actually here? Deliberately NOT RACE_RealPlayerCount(): that counts
// TEAM_PLAYERS only, so a player who is standing around, sitting in the menu, or
// spectating reads as an empty server — and the engine moves an inactive player
// to spectators by itself (g_inactivity_maxtime), so the very players this would
// interrupt are exactly the ones it could not see. Being idle is not the same as
// being gone: only a box with nobody on it rotates.
//
// Never counted:
//   - fake clients (the WR ghost and the mesh mirror bots), which are props, and
//     would otherwise hold a map forever on any peered server;
//   - the TV camera (rs_tv_name), which is infrastructure and is connected 24/7
//     — counting it would disable idle rotation outright on the streamed boxes.
//     A box where the camera connects under a name rs_tv_name does not match
//     therefore stops rotating; that cvar is the one thing to check if it does.
bool RACE_AnyHumanPresent()
{
    for ( int i = 0; i < maxClients; i++ )
    {
        Client@ client = G_GetClient( i );
        if ( @client == null || client.state() < CS_SPAWNED )
            continue; // empty slot, or still connecting/downloading
        if ( RACE_MirrorIsFakeClient( client ) )
            continue;
        if ( RACE_IsTvClient( client ) )
            continue;
        return true;
    }
    return false;
}

// Pick a map to rotate to: a random rs_idle_pool entry that is neither the
// current map nor moderator-blocked. Falls back to any installed map (the
// proven-safe randmap enumeration) when the pool cvar is unset, so the box still
// rotates. Returns "" only when truly nothing is available.
String RACE_PickIdleMap()
{
    Cvar mapnameCvar( "mapname", "", 0 );
    String current = mapnameCvar.string.removeColorTokens().tolower();

    String list = rsIdlePool.string;
    String[] pool;
    for ( int i = 0; ; i++ )
    {
        String m = list.getToken( i );
        if ( m.length() == 0 )
            break;
        String clean = m.removeColorTokens().tolower();
        if ( clean == current )
            continue;
        if ( RACE_IsMapBlocked( clean ) )
            continue;
        pool.insertLast( m );
    }

    if ( pool.length() > 0 )
        return pool[randrange( pool.length() )];

    // Pool cvar unset (old env.cfg) or every entry filtered out: fall back to any
    // installed, non-current, non-blocked map so an empty box still rotates.
    String pattern = "";
    String cur2 = mapnameCvar.string;
    String[] installed = GetMapsByFilter( pattern, cur2 );
    if ( installed.length() == 0 )
        return "";
    return installed[randrange( installed.length() )];
}

// Called every frame from GT_ThinkRules. Tracks how long the server has been
// empty and rotates once the idle threshold is crossed.
void RACE_IdleRotateThink()
{
    int minutes = rs_idle_rotate_minutes.integer;
    if ( minutes <= 0 )
        return; // feature disabled

    // Only rotate from live play, never during the scoreboard window or the
    // pending change we just launched (launchState below moves the state out of
    // PLAYTIME, which also stops this from re-firing before the map swaps).
    if ( match.getState() != MATCH_STATE_PLAYTIME )
        return;

    if ( RACE_AnyHumanPresent() )
    {
        // Someone is here — racing or not. Reset the clock so it only ever counts
        // a CONTINUOUS empty stretch (a player who joins and leaves restarts the
        // countdown), and so an idle player who is still on the box can never
        // have the map changed out from under them.
        raceIdleSince = 0;
        return;
    }

    // First empty frame: start the clock. levelTime can be 0 on the very first
    // frame, so use 1 as the "started" sentinel (0 means "not tracking").
    if ( raceIdleSince == 0 )
    {
        raceIdleSince = ( levelTime == 0 ) ? 1 : levelTime;
        return;
    }

    uint threshold = uint( minutes ) * 60 * 1000;
    if ( levelTime - raceIdleSince < threshold )
        return;

    String nextMap = RACE_PickIdleMap();
    if ( nextMap.length() == 0 )
    {
        // Nothing to rotate to. Re-arm so we retry after another interval.
        raceIdleSince = ( levelTime == 0 ) ? 1 : levelTime;
        return;
    }

    randmap_passed = nextMap;                 // reuse the proven randmap change path
    G_Print( "Idle map rotation: nobody on the server for " + minutes + " min, switching to " + nextMap + "\n" );
    match.launchState( MATCH_STATE_POSTMATCH );
}
