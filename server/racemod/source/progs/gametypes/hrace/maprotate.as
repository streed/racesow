// Idle map rotation.
//
// The race gametype runs with g_timelimit 0, so match.timeLimitHit() is never
// true and GT_ThinkRules never advances the match past PLAYTIME. That means the
// engine's built-in rotation never gets a trigger and a server left alone sits
// on one map forever; only a player `callvote randmap` rotates it (that vote
// launches POSTMATCH explicitly). This module supplies the missing trigger:
// when the box has had zero REAL players for rs_idle_rotate_minutes it switches
// to a random map from the rotation, so an empty server keeps cycling.
//
// The switch reuses the exact path a randmap vote uses: set randmap_passed and
// launch POSTMATCH; on an empty server Pending_AnyRacing() is false, so the
// state walks straight to WAITEXIT where GT_MatchStateFinished runs the chosen
// `map`. (Empty is measured by RACE_RealPlayerCount, which excludes the WR ghost
// and mesh bots — they are fake clients on TEAM_PLAYERS.)
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

    if ( RACE_RealPlayerCount() > 0 )
    {
        // Someone is here: reset the clock so it only ever counts a CONTINUOUS
        // empty stretch (a player who joins and leaves restarts the countdown).
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
    G_Print( "Idle map rotation: empty for " + minutes + " min, switching to " + nextMap + "\n" );
    match.launchState( MATCH_STATE_POSTMATCH );
}
