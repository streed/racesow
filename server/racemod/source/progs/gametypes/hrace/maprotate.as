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
// Where the map comes from: every installed map, minus the moderator blocklist
// and the machine quarantine, minus the map we are already on — the exact same
// enumeration `callvote randmap *` offers (GetMapsByFilter). The cycle and the
// vote therefore see one identical pool, so a map that can be voted for can also
// come up on its own, and a map a moderator blocks disappears from both within
// one blocklist refresh. 0 minutes disables the feature entirely.
//
// It used to be confined to rs_idle_pool, a copy of the curated mappool.txt
// rotation, which the engine's 1024-char command buffer caps at ~90 names — so
// an unattended box cycled a sliver of the ~4,600 installed maps and every other
// map was reachable only by a human voting for it. That cvar survives as an
// operator override (see below) but nothing sets it any more.

// Minutes with an empty server before it rotates; 0 disables. CVAR_ARCHIVE so it
// can be tuned or muted per box without a rebuild (the .as recompiles at server
// boot, not at Docker build time).
Cvar rs_idle_rotate_minutes( "rs_idle_rotate_minutes", "10", CVAR_ARCHIVE );

// Optional operator override: a space-separated list of map names to confine
// rotation to. Deliberately UNSET by default (no entrypoint writes it) — empty
// means "every installed map", which is the point of this module. It exists as
// a rescue lever: Warfork still runs upstream's fatal GClip_SetBrushModel, so a
// map with a NULL brush model there is Com_Error(ERR_DROP) -> SV_ShutdownGame ->
// a spinning process with a closed socket. That is now caught (gamehealth.sh
// bounces the wedge, crashguard reports the map and the API quarantines it into
// the blocklist), but if a bad batch of maps ever lands faster than the
// quarantine retires them, setting this on the box confines rotation without a
// rebuild. Read through a GLOBAL handle like every other module's cvars.
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
        if ( RACE_IsPuppet( client ) )
            continue;
        if ( RACE_IsTvClient( client ) )
            continue;
        return true;
    }
    return false;
}

// Pick a map to rotate to: a random installed map that is neither the current
// one nor blocked. GetMapsByFilter does the whole job — it walks the engine's
// map list, drops the <ignore> map and drops anything on the live blocklist
// (moderator blocks UNION machine quarantine, refreshed ~30s by blockedmaps.as),
// which is the same filtering every vote path gets. An empty pattern matches
// every name; it is not a weapon filter (RACE_ClassifyFilter needs at least one
// token), so this takes the plain name-pattern branch.
//
// When rs_idle_pool is set the candidates come from that list instead, still
// minus the current map and still minus the blocklist.
//
// Returns "" only when nothing at all is available — a box with one installed
// map, or an override pool whose every entry is blocked.
String RACE_PickIdleMap()
{
    Cvar mapnameCvar( "mapname", "", 0 );
    String current = mapnameCvar.string;

    String list = rsIdlePool.string;
    if ( list.length() > 0 )
    {
        String currentClean = current.removeColorTokens().tolower();
        String[] pool;
        for ( int i = 0; ; i++ )
        {
            String m = list.getToken( i );
            if ( m.length() == 0 )
                break;
            String clean = m.removeColorTokens().tolower();
            if ( clean == currentClean )
                continue;
            if ( RACE_IsMapBlocked( clean ) )
                continue;
            pool.insertLast( m );
        }
        if ( pool.length() > 0 )
            return pool[randrange( pool.length() )];
        // Every entry blocked or filtered out: fall through to the full list
        // rather than stopping the cycle dead.
    }

    String pattern = "";
    String[] installed = GetMapsByFilter( pattern, current );
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
