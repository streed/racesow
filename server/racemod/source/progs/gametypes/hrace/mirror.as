// Cross-server player mirroring - script side of the RS_Mirror* natives
// (see the deployment repo's server/enginepatches/g_rs_mirror.cpp).
//
// Peered race servers form a UDP mesh: each one broadcasts its OWN local
// players and chat, and receives the same from every peer (hop limit 1 - a
// mirrored player is never forwarded again). On this side we:
//
//   - publish local player positions at ~10Hz (RS_MirrorBegin/Player/End)
//   - print relayed chat/join/leave with a [TAG] prefix (chat is captured
//     C-side in Cmd_Say_f; we only ever print it, so it cannot loop)
//   - render remote players as translucent, non-solid ghosts when their
//     server runs the same map
//   - /who      lists the rosters of every peered server
//   - /watch    locks a spectator's camera to a remote player's stream so
//               their route can be studied from this server
//
// Everything no-ops unless rs_mirror_tag AND rs_mirror_peers are set (they
// come from MIRROR_* env vars via entrypoint.sh). Like racelog.as, this file
// only compiles against the patched game module that registers the natives.

Cvar rsMirrorTag( "rs_mirror_tag", "", 0 );
Cvar rsMirrorSecret( "rs_mirror_secret", "", 0 );
Cvar rsMirrorPort( "rs_mirror_port", "44450", 0 );
Cvar rsMirrorPeers( "rs_mirror_peers", "", 0 );
Cvar rsMirrorMaxGhosts( "rs_mirror_maxghosts", "32", 0 );
// 1 = log received events and a periodic roster/ghost summary to the server
// console; pairs with the C side's "rs_mirror: stats" line for headless
// verification that the mesh broadcast is flowing
Cvar rsMirrorDebug( "rs_mirror_debug", "0", 0 );

const uint MIRROR_PUBLISH_INTERVAL = 100; // ms between state publishes (~10Hz)
const uint MIRROR_EXTRAPOLATE_MAX = 200;  // ms of dead-reckoning before a ghost freezes
const float MIRROR_SNAP_DISTANCE = 512.0f; // corrections beyond this teleport instead of lerping
const int MIRROR_EVENTS_PER_FRAME = 16;
const int MIRROR_ENTITY_HEADROOM = 64;    // never spawn ghosts into the last edict slots

// EF_RACEGHOST (1 << 17, gs_public.h): the stock 2.1.2 client renders
// entities carrying it as a translucent shell with no shadow, regardless of
// the viewer's cg_raceGhosts setting. Not in the script enums, so hardcoded.
const uint EF_RACEGHOST_FLAG = 131072;

// The model every ghost wears; precached in RACE_MirrorSpawnGametype the same
// way p_client.cpp precaches real player models, so stock clients resolve it
// (and fall back to their base model if not, which is safe).
const String MIRROR_GHOST_MODEL = "bigvic";

class MirrorPlayer
{
    String server; // origin tag
    String name;
    String map;    // origin server's current map
    Vec3 origin;   // last received position
    Vec3 angles;   // pitch yaw roll
    Vec3 velocity;
    int flags;     // 1 = racing
    uint receivedAt; // realTime when the last state row arrived
    bool seen;     // mark/sweep flag for roster sync
    Entity@ ghost;

    MirrorPlayer()
    {
        this.flags = 0;
        this.receivedAt = 0;
        this.seen = false;
        @this.ghost = null;
    }
}

MirrorPlayer@[] mirrorPlayers;
String mirrorLocalMap = "";
uint mirrorNextPublish = 0;
uint mirrorNextSync = 0;
uint mirrorNextDebugSummary = 0;
int mirrorModelIndex = 0;
int mirrorSkinIndex = 0;

// /watch state per client slot; empty server string = not watching
String[] mirrorWatchServer( maxClients );
String[] mirrorWatchName( maxClients );

bool RACE_MirrorEnabled()
{
    return rsMirrorTag.string.length() > 0 && rsMirrorPeers.string.length() > 0;
}

MirrorPlayer@ RACE_MirrorFind( const String &in server, const String &in name )
{
    for ( uint i = 0; i < mirrorPlayers.length(); i++ )
    {
        if ( mirrorPlayers[i].server == server && mirrorPlayers[i].name == name )
            return mirrorPlayers[i];
    }
    return null;
}

///*****************************************************************
/// Lifecycle (called from hrace.as)
///*****************************************************************

void RACE_MirrorInit()
{
    G_RegisterCommand( "who" );
    G_RegisterCommand( "watch" );
}

void RACE_MirrorSpawnGametype()
{
    // the level reload freed every entity: forget stale ghost handles
    for ( uint i = 0; i < mirrorPlayers.length(); i++ )
        @mirrorPlayers[i].ghost = null;
    for ( int i = 0; i < maxClients; i++ )
    {
        mirrorWatchServer[i] = "";
        mirrorWatchName[i] = "";
    }

    if ( !RACE_MirrorEnabled() )
        return;

    Cvar mapNameVar( "mapname", "", 0 );
    mirrorLocalMap = mapNameVar.string.tolower();

    mirrorModelIndex = G_ModelIndex( "$models/players/" + MIRROR_GHOST_MODEL );
    mirrorSkinIndex = G_SkinIndex( "models/players/" + MIRROR_GHOST_MODEL + "/default" );

    // idempotent: the native only rebinds/re-resolves on actual changes, but
    // always picks up the current map for the packet headers
    RS_MirrorConfigure( rsMirrorTag.string, rsMirrorSecret.string,
            rsMirrorPort.string.toInt(), rsMirrorPeers.string, mirrorLocalMap );
}

void RACE_MirrorShutdown()
{
    for ( uint i = 0; i < mirrorPlayers.length(); i++ )
        RACE_MirrorDespawnGhost( mirrorPlayers[i] );
}

void RACE_MirrorThink()
{
    if ( !RACE_MirrorEnabled() )
        return;

    // Drain chat/join/leave every frame (low latency), but only re-parse the
    // remote snapshot at the peer publish rate — the data changes at most every
    // ~100ms, so re-parsing 48 rows at the full frame rate is wasted work.
    // Ghost/watcher updates stay per-frame: they extrapolate from the cached
    // rows via RACE_MirrorPredict for smooth motion between snapshots.
    RACE_MirrorDrainEvents();
    if ( realTime >= mirrorNextSync )
    {
        mirrorNextSync = realTime + MIRROR_PUBLISH_INTERVAL;
        RACE_MirrorSyncRoster();
    }
    RACE_MirrorUpdateGhosts();
    RACE_MirrorUpdateWatchers();

    if ( realTime >= mirrorNextPublish )
    {
        mirrorNextPublish = realTime + MIRROR_PUBLISH_INTERVAL;
        RACE_MirrorPublish();
    }

    if ( rsMirrorDebug.integer > 0 && realTime >= mirrorNextDebugSummary )
    {
        mirrorNextDebugSummary = realTime + 5000;
        RACE_MirrorDebugSummary();
    }
}

// One console line per remote server every 5s while rs_mirror_debug is on.
void RACE_MirrorDebugSummary()
{
    String[] listed;
    for ( uint i = 0; i < mirrorPlayers.length(); i++ )
    {
        String server = mirrorPlayers[i].server;

        bool done = false;
        for ( uint j = 0; j < listed.length(); j++ )
        {
            if ( listed[j] == server )
                done = true;
        }
        if ( done )
            continue;
        listed.insertLast( server );

        int count = 0;
        int ghosts = 0;
        for ( uint j = 0; j < mirrorPlayers.length(); j++ )
        {
            if ( mirrorPlayers[j].server != server )
                continue;
            count++;
            if ( @mirrorPlayers[j].ghost != null )
                ghosts++;
        }
        G_Print( "rs_mirror(as): roster [" + server + "] map=" + mirrorPlayers[i].map
                + " players=" + count + " ghosts=" + ghosts + "\n" );
    }
    if ( listed.length() == 0 )
        G_Print( "rs_mirror(as): roster empty (no remote players streamed)\n" );
}

void RACE_MirrorPlayerJoined( Client@ client )
{
    if ( !RACE_MirrorEnabled() || @client == null )
        return;
    RS_MirrorEvent( "J", client.name, "" );
}

void RACE_MirrorPlayerLeft( Client@ client )
{
    if ( !RACE_MirrorEnabled() || @client == null )
        return;
    RS_MirrorEvent( "L", client.name, "" );
}

///*****************************************************************
/// Publishing local state (hop limit 1: only OUR players, ever)
///*****************************************************************

void RACE_MirrorPublish()
{
    RS_MirrorBegin();
    for ( int i = 0; i < maxClients; i++ )
    {
        Client@ client = G_GetClient( i );
        if ( client.state() < CS_SPAWNED || client.team == TEAM_SPECTATOR )
            continue;

        Entity@ ent = client.getEnt();
        if ( ent.isGhosting() || ent.moveType == MOVETYPE_NOCLIP )
            continue;

        // practice runs are private; don't stream them
        if ( RACE_GetPlayer( client ).practicing )
            continue;

        int flags = RACE_GetPlayer( client ).inRace ? 1 : 0;
        RS_MirrorPlayer( client.name, ent.origin, ent.angles, ent.velocity, flags );
    }
    RS_MirrorEnd();
}

///*****************************************************************
/// Receiving: roster, chat, ghosts
///*****************************************************************

void RACE_MirrorSyncRoster()
{
    // The C side owns liveness: rows vanish there on leave events and 3s
    // silence, so the roster below is authoritatively current.
    int count = RS_MirrorRefresh();

    for ( uint i = 0; i < mirrorPlayers.length(); i++ )
        mirrorPlayers[i].seen = false;

    for ( int i = 0; i < count; i++ )
    {
        String server = RS_MirrorPlayerServer( i );
        String name = RS_MirrorPlayerName( i );

        MirrorPlayer@ rp = RACE_MirrorFind( server, name );
        if ( @rp == null )
        {
            @rp = MirrorPlayer();
            rp.server = server;
            rp.name = name;
            mirrorPlayers.push_back( @rp );
        }
        rp.seen = true;
        rp.map = RS_MirrorPlayerMap( i );

        // "x y z pitch yaw roll vx vy vz flags ageMs"
        String state = RS_MirrorPlayerState( i );
        rp.origin = Vec3( state.getToken( 0 ).toFloat(), state.getToken( 1 ).toFloat(), state.getToken( 2 ).toFloat() );
        rp.angles = Vec3( state.getToken( 3 ).toFloat(), state.getToken( 4 ).toFloat(), state.getToken( 5 ).toFloat() );
        rp.velocity = Vec3( state.getToken( 6 ).toFloat(), state.getToken( 7 ).toFloat(), state.getToken( 8 ).toFloat() );
        rp.flags = state.getToken( 9 ).toInt();
        rp.receivedAt = realTime - uint( state.getToken( 10 ).toInt() );
    }

    for ( uint i = 0; i < mirrorPlayers.length(); )
    {
        if ( !mirrorPlayers[i].seen )
        {
            RACE_MirrorDespawnGhost( mirrorPlayers[i] );
            mirrorPlayers.removeAt( i );
        }
        else
        {
            i++;
        }
    }
}

void RACE_MirrorDrainEvents()
{
    for ( int i = 0; i < MIRROR_EVENTS_PER_FRAME; i++ )
    {
        int type = RS_MirrorNextEvent();
        if ( type == 0 )
            break;

        String tag = RS_MirrorEventServer();
        String name = RS_MirrorEventName();

        if ( rsMirrorDebug.integer > 0 )
            G_Print( "rs_mirror(as): event type=" + type + " [" + tag + "] " + name
                    + ( type == 1 ? ( ": " + RS_MirrorEventText() ) : "" ) + "\n" );

        if ( type == 1 )
            G_PrintMsg( null, "[" + tag + S_COLOR_WHITE + "] " + name
                    + S_COLOR_GREEN + ": " + S_COLOR_WHITE + RS_MirrorEventText() + "\n" );
        else if ( type == 2 )
            G_PrintMsg( null, "[" + tag + S_COLOR_WHITE + "] " + name
                    + S_COLOR_YELLOW + " connected\n" );
        else if ( type == 3 )
            G_PrintMsg( null, "[" + tag + S_COLOR_WHITE + "] " + name
                    + S_COLOR_YELLOW + " disconnected\n" );
    }
}

Vec3 RACE_MirrorPredict( MirrorPlayer@ rp )
{
    uint age = realTime - rp.receivedAt;
    if ( age > MIRROR_EXTRAPOLATE_MAX )
        age = MIRROR_EXTRAPOLATE_MAX; // stale stream: freeze instead of drifting into walls
    return rp.origin + rp.velocity * ( age / 1000.0f );
}

Entity@ RACE_MirrorSpawnGhost( MirrorPlayer@ rp )
{
    Entity@ ghost = G_SpawnEntity( "mirror_ghost" );
    if ( @ghost == null )
        return null;

    ghost.type = ET_PLAYER;
    // must be non-zero: modelindex 0 + SOLID_NOT reads as "ghosting" to the
    // engine (G_ISGHOSTING) and the entity stops being networked
    ghost.modelindex = mirrorModelIndex;
    ghost.skinNum = mirrorSkinIndex;
    ghost.team = TEAM_PLAYERS;
    ghost.solid = SOLID_NOT;
    ghost.moveType = MOVETYPE_NONE;
    ghost.svflags = ghost.svflags & ~uint( SVF_NOCLIENT );
    ghost.effects = EF_RACEGHOST_FLAG;
    ghost.setSize( Vec3( -16, -16, -24 ), Vec3( 16, 16, 40 ) );
    ghost.origin = rp.origin;
    ghost.angles = rp.angles;
    ghost.teleported = true;
    ghost.linkEntity();
    return ghost;
}

void RACE_MirrorDespawnGhost( MirrorPlayer@ rp )
{
    if ( @rp.ghost != null )
    {
        rp.ghost.freeEntity();
        @rp.ghost = null;
    }
}

void RACE_MirrorUpdateGhosts()
{
    int ghostCount = 0;
    int maxGhosts = rsMirrorMaxGhosts.integer;

    for ( uint i = 0; i < mirrorPlayers.length(); i++ )
    {
        MirrorPlayer@ rp = mirrorPlayers[i];

        // ghosts only make sense on the same map; chat/roster still flow
        if ( rp.map != mirrorLocalMap )
        {
            RACE_MirrorDespawnGhost( rp );
            continue;
        }

        if ( @rp.ghost == null )
        {
            if ( ghostCount >= maxGhosts || numEntities > maxEntities - MIRROR_ENTITY_HEADROOM )
                continue;
            @rp.ghost = RACE_MirrorSpawnGhost( rp );
            if ( @rp.ghost == null )
                continue;
        }
        ghostCount++;

        Entity@ ghost = rp.ghost;
        Vec3 predicted = RACE_MirrorPredict( rp );

        // respawns/teleports on the origin server arrive as a huge correction;
        // flag it so clients snap instead of drawing a lerp streak across the map
        float dx = predicted.x - ghost.origin.x;
        float dy = predicted.y - ghost.origin.y;
        float dz = predicted.z - ghost.origin.z;
        if ( dx * dx + dy * dy + dz * dz > MIRROR_SNAP_DISTANCE * MIRROR_SNAP_DISTANCE )
            ghost.teleported = true;

        ghost.origin = predicted;
        ghost.angles = rp.angles;
        // the engine transmits ET_PLAYER velocity to clients (origin2), which
        // drives both their extrapolation and the procedural run/jump anims
        ghost.velocity = rp.velocity;
        ghost.linkEntity();
    }
}

///*****************************************************************
/// /watch - follow a remote player's stream with the spectator camera
///*****************************************************************

void RACE_MirrorStopWatching( int slot, const String &in reason )
{
    if ( mirrorWatchServer[slot] == "" )
        return;
    if ( reason.length() > 0 )
    {
        Client@ client = G_GetClient( slot );
        if ( client.state() >= CS_SPAWNED )
            G_PrintMsg( client.getEnt(), reason );
    }
    mirrorWatchServer[slot] = "";
    mirrorWatchName[slot] = "";
}

void RACE_MirrorUpdateWatchers()
{
    for ( int i = 0; i < maxClients; i++ )
    {
        if ( mirrorWatchServer[i] == "" )
            continue;

        Client@ client = G_GetClient( i );
        if ( client.state() < CS_SPAWNED || client.team != TEAM_SPECTATOR )
        {
            RACE_MirrorStopWatching( i, "" ); // joined the game or left; silent
            continue;
        }

        MirrorPlayer@ rp = RACE_MirrorFind( mirrorWatchServer[i], mirrorWatchName[i] );
        if ( @rp == null || rp.map != mirrorLocalMap )
        {
            RACE_MirrorStopWatching( i, "[" + mirrorWatchServer[i] + S_COLOR_WHITE + "] "
                    + mirrorWatchName[i] + S_COLOR_YELLOW + " is gone - watch stopped.\n" );
            continue;
        }

        // chasecam-style: hang back along the view direction, clamped by a
        // trace so walls don't swallow the camera
        Vec3 predicted = RACE_MirrorPredict( rp );
        Vec3 forward, right, up;
        rp.angles.angleVectors( forward, right, up );
        Vec3 eye = predicted + Vec3( 0, 0, 24 );
        Vec3 wanted = eye + forward * -96.0f;

        Entity@ ent = client.getEnt();
        Trace tr;
        if ( tr.doTrace( eye, Vec3( -4, -4, -4 ), Vec3( 4, 4, 4 ), wanted, ent.entNum, MASK_SOLID ) )
            wanted = tr.endPos;

        ent.origin = wanted;
        ent.angles = rp.angles;
        ent.velocity = Vec3( 0, 0, 0 );
        ent.teleported = true;
    }
}

bool Cmd_MirrorWatch( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( !RACE_MirrorEnabled() )
    {
        client.printMessage( "Cross-server mirroring is not enabled on this server.\n" );
        return true;
    }

    int slot = client.playerNum;
    String first = argsString.getToken( 0 );

    if ( first == "" || first == "off" )
    {
        if ( mirrorWatchServer[slot] != "" )
        {
            RACE_MirrorStopWatching( slot, "" );
            client.printMessage( "Watch stopped.\n" );
        }
        else
        {
            client.printMessage( "Usage: watch <player>  |  watch <server> <player>  |  watch off\n" );
            client.printMessage( "Follows a player on a peered server (spectators only); see /who.\n" );
        }
        return true;
    }

    if ( client.team != TEAM_SPECTATOR )
    {
        client.printMessage( "You must be spectating to watch remote players (use /spec first).\n" );
        return true;
    }

    // "watch <server> <player>" when the first token names a known peer,
    // otherwise the whole argument string is the player pattern
    String wantServer = "";
    String pattern = argsString.trim();
    if ( argc >= 2 )
    {
        String maybeTag = first.tolower();
        for ( uint i = 0; i < mirrorPlayers.length(); i++ )
        {
            if ( mirrorPlayers[i].server.tolower() == maybeTag )
            {
                wantServer = mirrorPlayers[i].server;
                pattern = pattern.substr( first.length() ).trim();
                break;
            }
        }
    }
    pattern = pattern.removeColorTokens().tolower();

    MirrorPlayer@ found = null;
    bool ambiguous = false;
    for ( uint i = 0; i < mirrorPlayers.length(); i++ )
    {
        MirrorPlayer@ rp = mirrorPlayers[i];
        if ( wantServer != "" && rp.server != wantServer )
            continue;
        String clean = rp.name.removeColorTokens().tolower();
        if ( clean == pattern )
        {
            @found = rp;
            ambiguous = false;
            break; // exact match wins outright
        }
        if ( PatternMatch( clean, pattern ) )
        {
            if ( @found != null )
                ambiguous = true;
            else
                @found = rp;
        }
    }

    if ( @found == null )
    {
        client.printMessage( "No remote player matches '" + pattern + "'. Try /who.\n" );
        return true;
    }
    if ( ambiguous )
    {
        client.printMessage( "Several remote players match '" + pattern + "' - be more specific or give the server tag.\n" );
        return true;
    }
    if ( found.map != mirrorLocalMap )
    {
        client.printMessage( "[" + found.server + S_COLOR_WHITE + "] " + found.name
                + S_COLOR_WHITE + " is playing " + S_COLOR_GREEN + found.map
                + S_COLOR_WHITE + ", but this server is on " + S_COLOR_GREEN + mirrorLocalMap
                + S_COLOR_WHITE + ".\n" );
        return true;
    }

    client.chaseActive = false; // we drive the camera, not the chasecam
    mirrorWatchServer[slot] = found.server;
    mirrorWatchName[slot] = found.name;
    client.printMessage( "Watching [" + found.server + S_COLOR_WHITE + "] " + found.name
            + S_COLOR_WHITE + " - /watch off to stop.\n" );
    return true;
}

///*****************************************************************
/// /who - rosters of every peered server
///*****************************************************************

bool Cmd_MirrorWho( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( !RACE_MirrorEnabled() )
    {
        client.printMessage( "Cross-server mirroring is not enabled on this server.\n" );
        return true;
    }

    int localCount = 0;
    for ( int i = 0; i < maxClients; i++ )
    {
        Client@ other = G_GetClient( i );
        if ( other.state() >= CS_SPAWNED && other.team != TEAM_SPECTATOR )
            localCount++;
    }
    client.printMessage( "[" + rsMirrorTag.string + S_COLOR_WHITE + "] " + S_COLOR_GREEN + mirrorLocalMap
            + S_COLOR_WHITE + " - " + localCount + " playing (this server)\n" );

    String[] listed;
    for ( uint i = 0; i < mirrorPlayers.length(); i++ )
    {
        String server = mirrorPlayers[i].server;

        bool done = false;
        for ( uint j = 0; j < listed.length(); j++ )
        {
            if ( listed[j] == server )
                done = true;
        }
        if ( done )
            continue;
        listed.insertLast( server );

        int count = 0;
        for ( uint j = 0; j < mirrorPlayers.length(); j++ )
        {
            if ( mirrorPlayers[j].server == server )
                count++;
        }

        client.printMessage( "[" + server + S_COLOR_WHITE + "] " + S_COLOR_GREEN + mirrorPlayers[i].map
                + S_COLOR_WHITE + " - " + count + " playing"
                + ( mirrorPlayers[i].map == mirrorLocalMap ? " (visible as ghosts)" : "" ) + "\n" );

        Table table( "l l" );
        for ( uint j = 0; j < mirrorPlayers.length(); j++ )
        {
            MirrorPlayer@ rp = mirrorPlayers[j];
            if ( rp.server != server )
                continue;
            table.addCell( "  " + rp.name );
            table.addCell( ( rp.flags & 1 ) != 0 ? S_COLOR_GREEN + "racing" : S_COLOR_WHITE + "idle" );
        }
        uint rows = table.numRows();
        for ( uint j = 0; j < rows; j++ )
            client.printMessage( table.getRow( j ) + "\n" );
    }

    if ( listed.length() == 0 )
        client.printMessage( "No peered servers online.\n" );

    return true;
}
