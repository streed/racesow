// What an unattended server does with its map.
//
// Two jobs, in priority order. If anybody is playing on another server in the
// mesh, an empty box joins THEIR map (see "Following the busy server" below) so
// the network converges on one map instead of four. If the mesh is quiet, the
// box cycles through the rotation on its own rather than sitting on one map
// forever — which is the original job of this module, described next.
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

///*****************************************************************
/// Following the busy server
///*****************************************************************
//
// Four servers, and most of the time only one of them has anybody on it. Left
// alone the other three each wander through their own random rotation, so a
// player who joins an empty box lands on a map nobody else is playing — and the
// mesh, which otherwise works hard to present itself as one big server (shared
// chat, mirrored ghosts, /who, /hop), feels like four unrelated ones. So an
// EMPTY server follows the busy one: whoever has people on it decides the map,
// the idle boxes mirror it, and the network sits on one map ready for whoever
// shows up next.
//
// The rules, in order:
//   - a server with anybody on it NEVER follows. Its own players own its map and
//     change it the normal way (callvote / randmap / meshvote sync); a box with
//     people on it is never dragged around by a busier one. Two occupied servers
//     therefore just keep their own maps, each voting for itself.
//   - an empty server follows the peer with the most people on it, whichever
//     game that peer runs, ties broken by tag. That is a pure function of mesh
//     state, so every idle box in the mesh picks the same target without
//     negotiating anything — which is what makes all four converge on one map
//     rather than one pair per game.
//   - only once that target has held steady for rs_idle_follow_seconds, so a
//     player passing through — or a peer that is itself mid-rotation — doesn't
//     cost us a map load. Script globals reset on map load, which makes the same
//     debounce a rate limit: at most one follow-switch per delay plus load.
//   - while ANYONE is on the mesh the random idle rotation is suppressed, even
//     when we can't follow (already on their map, not installed here, blocked).
//     Otherwise we would rotate off the shared map and then follow right back.
//
// Cross-game follow is ON. It used to be excluded: Warsow and Warfork share one
// mesh but not one engine, and a map the other engine loads happily can take
// this one down — Warfork's fatal GClip_SetBrushModel wedged three servers that
// way (see the rs_idle_pool notes above). But that gate was doing no work. The
// random idle rotation below already draws from EVERY installed map with no
// evidence about any of them, so refusing to follow a map that a sibling server
// has LOADED and that people are actually racing on was never buying safety —
// it is strictly better evidence than the rotation's own coin flip. What it cost
// was the whole point of the mesh: with a player on a Warsow box, the two
// Warfork boxes ignored them and wandered off through their own rotations, so
// "four servers acting like one" only ever held within a game.
//
// The gate that does the real work is unchanged and applies to every peer: the
// map must be INSTALLED here and not blocked. Both boxes mount the same map
// mirror, so in practice that only ever excludes the base game's own maps, whose
// names differ per engine (wrace1 vs wfrace1) — and those aside, a map that does
// kill a server now costs one bounce on an empty box before crashguard reports
// it and the API quarantines it out of this same blocklist network-wide.
//
// rs_idle_follow_crossgame 0 restores the same-game-only behaviour on a box
// without a rebuild, if a Warfork-fatal map ever proves that wrong.

// Follow the busy server at all; 0 leaves only the random idle rotation.
// CVAR_ARCHIVE so a box can opt out without a rebuild.
Cvar rs_idle_follow( "rs_idle_follow", "1", CVAR_ARCHIVE );

// How long (seconds) the busiest peer must sit on one map before an empty
// server spends a map load to join it.
Cvar rs_idle_follow_seconds( "rs_idle_follow_seconds", "45", CVAR_ARCHIVE );

// Follow peers running the OTHER game too (Warsow <-> Warfork). 1 = the whole
// mesh converges on whoever has players; 0 = the old same-game-only rule. The
// installed-here and not-blocked gates apply either way. CVAR_ARCHIVE so it is
// a per-box lever rather than a rebuild.
Cvar rs_idle_follow_crossgame( "rs_idle_follow_crossgame", "1", CVAR_ARCHIVE );

// How long a peer counts as occupied after we last saw a player on it. This has
// to comfortably outlast a peer's own map change: while a peer loads it stops
// publishing entirely and the C side drops its roster rows, so without the
// memory an idle box would read the mesh as empty for a minute and wander off
// on a random rotation at the exact moment the players are about to reappear.
const uint IDLE_FOLLOW_GRACE = 120000;

// How often the whole follow decision is made. Its inputs move at the mesh
// publish rate and every switch it can make is behind a multi-second debounce,
// so once a second is plenty — and it keeps the roster fold, the peer-registry
// walk and the string work off the frame path, which matters because
// GT_ThinkRules calls in here ~60 times a second.
const uint IDLE_FOLLOW_TICK = 1000;

// Per-peer occupancy memory: parallel arrays, at most one entry per peer.
String[] followPeerTag;
uint[] followPeerSeen;  // realTime we last saw a human on that peer
int[] followPeerCount;  // humans in that sighting
uint followNextTick = 0;

// Last tick's answer to "is anyone playing anywhere on the mesh?", so the
// between-tick frames can hold the random rotation back without redoing the
// work. At most one second stale, against a rotation measured in minutes.
bool followMeshBusy = false;

// The target currently serving out its debounce.
String followTargetTag = "";
String followTargetMap = "";
uint followTargetSince = 0;
bool followTargetHere = false; // is followTargetMap installed on this box?
bool followWarnedGame = false; // "can't tell which game this box is" said once

// Fold the mirrored roster into "how many people are on each peer" and remember
// it. Every row in mirrorPlayers is a real human on another server: the mesh
// publishes neither fake clients (WR ghost, mirror bots) nor the TV camera, so
// this is the same population RACE_AnyHumanPresent counts locally. Spectators
// count — somebody sitting in spectate on a map is still somebody to join.
void RACE_FollowObserve()
{
    // This tick's headcount per peer tag.
    String[] tags;
    int[] counts;
    for ( uint i = 0; i < mirrorPlayers.length(); i++ )
    {
        String tag = mirrorPlayers[i].server;
        if ( tag.length() == 0 )
            continue;
        bool found = false;
        for ( uint j = 0; j < tags.length(); j++ )
        {
            if ( tags[j] != tag )
                continue;
            counts[j] = counts[j] + 1;
            found = true;
            break;
        }
        if ( !found )
        {
            tags.insertLast( tag );
            counts.insertLast( 1 );
        }
    }

    for ( uint i = 0; i < tags.length(); i++ )
    {
        int at = -1;
        for ( uint j = 0; j < followPeerTag.length(); j++ )
        {
            if ( followPeerTag[j] == tags[i] )
            {
                at = int( j );
                break;
            }
        }
        if ( at < 0 )
        {
            followPeerTag.insertLast( tags[i] );
            followPeerSeen.insertLast( realTime );
            followPeerCount.insertLast( counts[i] );
        }
        else
        {
            followPeerSeen[at] = realTime;
            followPeerCount[at] = counts[i];
        }
    }

    // Forget peers nobody has been seen on for a while. This is what eventually
    // releases an idle box back to its random rotation once the mesh empties.
    for ( uint i = 0; i < followPeerTag.length(); )
    {
        if ( realTime - followPeerSeen[i] > IDLE_FOLLOW_GRACE )
        {
            followPeerTag.removeAt( i );
            followPeerSeen.removeAt( i );
            followPeerCount.removeAt( i );
        }
        else
        {
            i++;
        }
    }
}

// Remembered headcount for a peer, for the follow log line. This is the last
// sighting, not a live count: a peer that empties keeps its old number until the
// grace drops it, which at worst points idle boxes at a just-vacated map for a
// couple of minutes before they re-target. 0 once forgotten.
int followPeerCountOf( const String &in tag )
{
    for ( uint i = 0; i < followPeerTag.length(); i++ )
    {
        if ( followPeerTag[i] == tag )
            return followPeerCount[i];
    }
    return 0;
}

// "warsow" / "warfork" for a mesh tag: from the rs_hop_servers table serverhop.as
// already parses (tag;name;game;addr), else from the -ws / -wf suffix the tags
// themselves carry. "" when neither says.
String RACE_FollowGameOf( const String &in tag )
{
    String want = tag.removeColorTokens().tolower();
    if ( want.length() == 0 )
        return "";

    RACE_HopParse();
    for ( uint i = 0; i < hopTag.length(); i++ )
    {
        if ( hopTag[i].removeColorTokens().tolower() == want )
            return hopGame[i].removeColorTokens().tolower();
    }

    if ( want.length() > 3 )
    {
        String suffix = want.substr( want.length() - 3, 3 );
        if ( suffix == "-ws" )
            return "warsow";
        if ( suffix == "-wf" )
            return "warfork";
    }
    return "";
}

// This box's own game, from rs_hop_game (set by both entrypoints) or its tag.
String RACE_FollowOurGame()
{
    String mine = rsHopGame.string.removeColorTokens().tolower();
    if ( mine.length() == 0 )
        mine = RACE_FollowGameOf( rsMirrorTag.string );
    return mine;
}

// May this box follow that peer at all? Yes for every peer by default — see the
// cross-game note at the top. Only when rs_idle_follow_crossgame is 0 does this
// narrow to peers running the same game, and then an unknown game on either side
// is a NO: under that setting following is only worth it when we can show the
// peer proved the map on THIS engine. A box that cannot answer for itself says
// so once per map load and then follows nobody, rather than quietly widening the
// rule the operator just turned off.
bool RACE_FollowEligible( const String &in tag )
{
    if ( rs_idle_follow_crossgame.integer > 0 )
        return true;

    String mine = RACE_FollowOurGame();
    if ( mine.length() == 0 )
    {
        if ( !followWarnedGame )
        {
            followWarnedGame = true;
            G_Print( "Idle follow: rs_idle_follow_crossgame is 0 and neither rs_hop_game nor the rs_mirror_tag suffix says which game this box runs; not following any peer.\n" );
        }
        return false;
    }
    return mine == RACE_FollowGameOf( tag );
}

// The peer we should be mirroring: the one with the most people on it, ties
// broken by tag so that every idle server in the mesh lands on the same answer
// without exchanging a single packet about it. "" when the mesh is quiet.
String RACE_FollowBestPeer()
{
    String best = "";
    int bestCount = 0;
    for ( uint i = 0; i < followPeerTag.length(); i++ )
    {
        int count = followPeerCount[i];
        if ( count <= 0 )
            continue;
        if ( !RACE_FollowEligible( followPeerTag[i] ) )
            continue;
        // RACE_MeshVoteIdLess: String has no opCmp, and the tie-break has to be
        // deterministic across boxes or two idle servers pick different targets.
        if ( best.length() == 0 || count > bestCount
                || ( count == bestCount && RACE_MeshVoteIdLess( followPeerTag[i], best ) ) )
        {
            best = followPeerTag[i];
            bestCount = count;
        }
    }
    return best;
}

// The map a peer is on right now, from the live peer registry (which carries
// keepalive state, so it is current even for a peer whose players we are only
// remembering). "" when that peer isn't being heard at all — which is exactly
// what a peer mid-map-load looks like.
String RACE_FollowPeerMap( const String &in tag )
{
    String want = tag.removeColorTokens().tolower();
    int pc = RS_MirrorPeerCount();
    for ( int i = 0; i < pc; i++ )
    {
        String ptag = RS_MirrorPeerTag( i );
        if ( ptag.removeColorTokens().tolower() != want )
            continue;
        String pmap = RS_MirrorPeerMap( i );
        return pmap.removeColorTokens().tolower();
    }
    return "";
}

// Once a second: refresh what we know about the other servers and, if this one
// is empty, join whichever of them the players are on. Everything the follow
// rule needs is recomputed here and the verdict cached in followMeshBusy, so the
// other ~60 calls a second this gets are free.
void RACE_FollowThink()
{
    if ( realTime < followNextTick )
        return;
    followNextTick = realTime + IDLE_FOLLOW_TICK;

    RACE_FollowObserve();

    if ( RACE_AnyHumanPresent() )
    {
        // Somebody is here, so this box follows nobody: its own players own its
        // map. Drop the debounce with it, so a box that briefly had someone on
        // it starts the countdown over rather than switching the instant they
        // disconnect. followMeshBusy is irrelevant while we are occupied (the
        // caller returns before reading it) — false is just the honest value
        // for "not currently following anything".
        followTargetTag = "";
        followTargetMap = "";
        followTargetSince = 0;
        followMeshBusy = false;
        return;
    }

    followMeshBusy = RACE_FollowBusyPeer();
}

// Follow the busy server, and report whether the mesh has people on it at all.
//
// Returns TRUE whenever somebody is playing somewhere on the mesh, whether or
// not that ended in a map change here — the caller uses it to hold the random
// idle rotation back. Returns false only when the mesh is genuinely quiet, which
// is when wandering off to a random map is the right thing to do.
bool RACE_FollowBusyPeer()
{
    if ( rs_idle_follow.integer <= 0 )
        return false;
    if ( !RACE_MirrorEnabled() )
        return false;

    // A passed mesh vote is already taking us somewhere; leave it alone (and
    // hold the rotation, since a vote means people are on the mesh).
    if ( mvSwitching )
        return true;

    String tag = RACE_FollowBestPeer();
    if ( tag.length() == 0 )
    {
        followTargetTag = "";
        followTargetMap = "";
        followTargetSince = 0;
        return false; // nobody anywhere: back to the random rotation
    }

    String map = RACE_FollowPeerMap( tag );
    if ( map.length() == 0 )
        return true; // heard its players but not its keepalive: it is loading, wait

    if ( tag != followTargetTag || map != followTargetMap )
    {
        // New target (or the one we were watching moved): restart the debounce
        // and price the map once, since RACE_MapExists walks every installed pk3.
        followTargetTag = tag;
        followTargetMap = map;
        followTargetSince = ( realTime == 0 ) ? 1 : realTime;
        followTargetHere = RACE_MapExists( map );
        if ( !followTargetHere )
            G_Print( "Idle follow: [" + tag + "] is playing " + map + ", which is not installed here; staying put.\n" );
        return true;
    }

    Cvar mapnameCvar( "mapname", "", 0 );
    if ( map == mapnameCvar.string.removeColorTokens().tolower() )
        return true; // already where the players are

    // Not installed, or blocked here since we last looked (the blocklist is
    // refreshed live): hold this map rather than rotating away from the mesh.
    if ( !followTargetHere || RACE_IsMapBlocked( map ) )
        return true;

    int seconds = rs_idle_follow_seconds.integer;
    if ( seconds < 0 )
        seconds = 0;
    if ( realTime - followTargetSince < uint( seconds ) * 1000 )
        return true;

    randmap_passed = map;                     // the same proven randmap change path
    G_Print( "Idle follow: nobody here and " + followPeerCountOf( tag ) + " player(s) on ["
            + tag + "], switching to their map " + map + "\n" );
    match.launchState( MATCH_STATE_POSTMATCH );
    return true;
}

// Called every frame from GT_ThinkRules. Decides what an unattended server does
// with its map: join the players on another server if the mesh has any, and
// otherwise cycle to a fresh map once the idle threshold is crossed.
void RACE_IdleRotateThink()
{
    // Only act from live play, never during the scoreboard window or a pending
    // change we already launched (launchState moves the state out of PLAYTIME,
    // which is also what stops either path re-firing before the map swaps).
    if ( match.getState() != MATCH_STATE_PLAYTIME )
        return;

    // Follow the busy server (once a second, whatever our own state: the peer
    // memory has to already be warm at the moment our last player leaves).
    RACE_FollowThink();

    if ( RACE_AnyHumanPresent() )
    {
        // Someone is here — racing or not. Reset the clock so it only ever counts
        // a CONTINUOUS empty stretch (a player who joins and leaves restarts the
        // countdown), and so an idle player who is still on the box can never
        // have the map changed out from under them.
        raceIdleSince = 0;
        return;
    }

    // Nobody here, but somebody is playing elsewhere on the mesh: hold this map.
    // That covers the follow having already put us on their map, and equally the
    // cases where we couldn't follow at all (map not installed here, blocked) —
    // rotating away from the busy map is precisely what this is meant to stop.
    if ( followMeshBusy )
        return;

    int minutes = rs_idle_rotate_minutes.integer;
    if ( minutes <= 0 )
        return; // random rotation disabled

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
