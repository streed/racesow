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
// Published into serverinfo (CVAR_SERVERINFO) so the web dashboard can read the
// live mesh state via the getstatus query: a compact, delimiter-safe list of
// the peer servers this node currently hears, each as "TAG:map:players". Must
// stay under MAX_INFO_VALUE (64 chars) and free of \ " ; or the engine's
// Info_Validate rejects the whole value (keeping the previous one). See
// RACE_MirrorPublishStatus.
Cvar rsMeshStatus( "rs_mesh_status", "", CVAR_SERVERINFO );

const uint MIRROR_PUBLISH_INTERVAL = 16; // ms between state publishes/syncs (~60Hz)
const uint MIRROR_EXTRAPOLATE_MAX = 150;  // ms of dead-reckoning before a ghost freezes
const float MIRROR_SNAP_DISTANCE = 512.0f; // corrections beyond this teleport instead of smoothing
// Per-frame easing of the rendered position/view toward the (extrapolated)
// target. Higher = snappier/more responsive, lower = smoother/laggier. This is
// what turns the ~60Hz stepwise updates into continuous, jitter-free motion.
const float MIRROR_SMOOTH = 0.35f;
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
    Vec3 angles;   // pitch yaw roll (the remote player's VIEW angles)
    Vec3 velocity;
    int flags;     // 1 = racing
    uint receivedAt; // realTime when the last state row arrived
    bool seen;     // mark/sweep flag for roster sync
    int botSlot;   // fake-client playerNum representing this player, or -1
    int cr, cg, cb; // random display colour, assigned once
    Vec3 renderPos; // smoothed position actually pushed to the bot
    Vec3 renderAng; // smoothed view angles
    bool hasRender; // renderPos/Ang seeded yet?

    MirrorPlayer()
    {
        this.flags = 0;
        this.receivedAt = 0;
        this.seen = false;
        this.botSlot = -1;
        this.cr = 255; this.cg = 255; this.cb = 255;
        this.hasRender = false;
    }
}

MirrorPlayer@[] mirrorPlayers;
String mirrorLocalMap = "";
uint mirrorNextPublish = 0;
uint mirrorNextSync = 0;
uint mirrorNextDebugSummary = 0;
int mirrorModelIndex = 0;
int mirrorSkinIndex = 0;
uint mirrorColorSeed = 0x9e3779b9; // LCG state for random bot colours

// Give a remote player a bright, random-ish colour (assigned once, so it is
// stable for the player's session). Avoids AngelScript string indexing.
void RACE_MirrorAssignColour( MirrorPlayer@ rp )
{
    mirrorColorSeed = mirrorColorSeed * 1103515245 + 12345;
    rp.cr = int( 70 + ( ( mirrorColorSeed >> 16 ) % 186 ) );
    mirrorColorSeed = mirrorColorSeed * 1103515245 + 12345;
    rp.cg = int( 70 + ( ( mirrorColorSeed >> 16 ) % 186 ) );
    mirrorColorSeed = mirrorColorSeed * 1103515245 + 12345;
    rp.cb = int( 70 + ( ( mirrorColorSeed >> 16 ) % 186 ) );
}

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
    RACE_MeshVoteInit();
}

void RACE_MirrorSpawnGametype()
{
    // A level reload drops all clients, so any fake-client bot slots we held
    // are gone — forget them; RACE_MirrorUpdateBots re-adds lazily.
    for ( uint i = 0; i < mirrorPlayers.length(); i++ )
        mirrorPlayers[i].botSlot = -1;
    for ( int i = 0; i < maxClients; i++ )
    {
        mirrorWatchServer[i] = "";
        mirrorWatchName[i] = "";
    }

    if ( !RACE_MirrorEnabled() )
        return;

    Cvar mapNameVar( "mapname", "", 0 );
    mirrorLocalMap = mapNameVar.string.tolower();
    if ( mirrorColorSeed == 0x9e3779b9 )
        mirrorColorSeed ^= levelTime; // vary colours across restarts

    mirrorModelIndex = G_ModelIndex( "$models/players/" + MIRROR_GHOST_MODEL );
    mirrorSkinIndex = G_SkinIndex( "models/players/" + MIRROR_GHOST_MODEL + "/default" );

    // idempotent: the native only rebinds/re-resolves on actual changes, but
    // always picks up the current map for the packet headers
    RS_MirrorConfigure( rsMirrorTag.string, rsMirrorSecret.string,
            rsMirrorPort.string.toInt(), rsMirrorPeers.string, mirrorLocalMap );

    // Announce our (new) map to the mesh so peers print "[TAG] now playing X"
    // and update immediately — fired on every map load, whatever the cause
    // (mesh vote, native callvote, rotation, admin).
    RS_MirrorEvent( "M", mirrorLocalMap, "" );
}

void RACE_MirrorShutdown()
{
    for ( uint i = 0; i < mirrorPlayers.length(); i++ )
        RACE_MirrorRemoveBot( mirrorPlayers[i] );
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
    RACE_MirrorUpdateBots();
    RACE_MirrorUpdateWatchers();
    RACE_MeshVoteThink();

    if ( realTime >= mirrorNextPublish )
    {
        mirrorNextPublish = realTime + MIRROR_PUBLISH_INTERVAL;
        RACE_MirrorPublish();
    }

    // Refresh the serverinfo mesh_status a couple of times a minute is plenty
    // for a dashboard the web polls every ~10s; keep it off the hot path.
    if ( realTime >= mirrorNextStatus )
    {
        mirrorNextStatus = realTime + 2000;
        RACE_MirrorPublishStatus();
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
        int bots = 0;
        for ( uint j = 0; j < mirrorPlayers.length(); j++ )
        {
            if ( mirrorPlayers[j].server != server )
                continue;
            count++;
            if ( mirrorPlayers[j].botSlot >= 0 )
                bots++;
        }
        G_Print( "rs_mirror(as): roster [" + server + "] map=" + mirrorPlayers[i].map
                + " players=" + count + " bots=" + bots + "\n" );
    }
    if ( listed.length() == 0 )
        G_Print( "rs_mirror(as): roster empty (no remote players streamed)\n" );
}

// --- serverinfo mesh_status (read by the web live page) --------------------

uint mirrorNextStatus = 0;
const uint MESH_STATUS_MAX = 63; // MAX_INFO_VALUE (64) - 1

// Strip anything illegal in a serverinfo value (\ " ; or control/non-ASCII) or
// that we use as a field/record delimiter ( : , ), and cap the length, so a
// stray map or tag name can neither corrupt the encoding nor get the whole
// cvar rejected by the engine's Info_Validate.
String RACE_MeshStatusClean( const String &in raw, uint maxLen )
{
    String s = raw.removeColorTokens();
    String clean = "";
    for ( uint i = 0; i < s.length() && clean.length() < maxLen; i++ )
    {
        uint8 c = s[i];
        if ( c < uint8(0x20) || c > uint8(0x7E) )       // control / non-ASCII
            continue;
        if ( c == uint8(0x5C) || c == uint8(0x22) || c == uint8(0x3B)   // \ " ;
                || c == uint8(0x3A) || c == uint8(0x2C) )                // : ,
            continue;
        clean += s.substr( i, 1 );
    }
    return clean;
}

// Build "TAG:map:players,TAG:map:players,..." for every peer we currently hear
// (peers time out of the snapshot when silent, so the list is exactly the live
// mesh) and publish it into serverinfo. Greedily truncated to stay under
// MAX_INFO_VALUE — the web renders whatever it receives.
void RACE_MirrorPublishStatus()
{
    String status = "";
    int pc = RS_MirrorPeerCount();
    for ( int i = 0; i < pc; i++ )
    {
        String rawTag = RS_MirrorPeerTag( i );
        String tag = RACE_MeshStatusClean( rawTag, 6 );
        if ( tag.length() == 0 )
            continue;
        String map = RACE_MeshStatusClean( RS_MirrorPeerMap( i ), 16 );

        int players = 0;
        for ( uint j = 0; j < mirrorPlayers.length(); j++ )
        {
            if ( mirrorPlayers[j].server == rawTag )
                players++;
        }

        String rec = tag + ":" + map + ":" + players;
        String next = ( status.length() == 0 ) ? rec : ( status + "," + rec );
        if ( next.length() > MESH_STATUS_MAX )
            break; // keep the value valid rather than lose it all to Info_Validate
        status = next;
    }

    // Only write on change: trap_Cvar_Set flags serverinfo dirty every call.
    if ( status != rsMeshStatus.string )
        rsMeshStatus.set( status );
}

// True for our mirror bots (and any fake client). We test SVF_FAKECLIENT on the
// entity rather than only RS_MirrorBotIs because the "connect"/"disconnect"
// score events fire from INSIDE trap_FakeClientConnect / trap_DropClient — i.e.
// before RS_MirrorBotAdd marks the slot (and after RS_MirrorBotRemove clears
// it) — but the engine keeps SVF_FAKECLIENT set for the bot's whole lifetime.
bool RACE_MirrorIsFakeClient( Client@ client )
{
    if ( @client == null )
        return false;
    if ( RS_MirrorBotIs( client.playerNum ) )
        return true;
    Entity@ ent = client.getEnt();
    return @ent != null && ( ent.svflags & SVF_FAKECLIENT ) != 0;
}

void RACE_MirrorPlayerJoined( Client@ client )
{
    if ( !RACE_MirrorEnabled() || @client == null )
        return;
    // Never announce our own mirror bots: they represent players already on a
    // PEER server, so echoing their connect back into the mesh (hop limit 1)
    // would report a remote player as a new local join on their origin server.
    if ( RACE_MirrorIsFakeClient( client ) )
        return;
    RS_MirrorEvent( "J", client.name, "" );
}

void RACE_MirrorPlayerLeft( Client@ client )
{
    if ( !RACE_MirrorEnabled() || @client == null )
        return;
    if ( RACE_MirrorIsFakeClient( client ) )
        return; // mirror bots are peer players, not local ones (see Joined)
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
        // NEVER publish our own mirror bots: they represent OTHER servers'
        // players, so re-broadcasting them would loop them around the mesh
        // (hop limit 1 — a server publishes only its genuine local players).
        if ( RS_MirrorBotIs( i ) )
            continue;

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
            RACE_MirrorRemoveBot( mirrorPlayers[i] );
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
        else if ( type == 7 ) // M: a peer changed map
            G_PrintMsg( null, "[" + tag + S_COLOR_WHITE + "] "
                    + S_COLOR_YELLOW + "now playing " + S_COLOR_GREEN + name + "\n" );
        else if ( type >= 4 && type <= 6 ) // O/T/R mesh-vote events
            RACE_MeshVoteOnEvent( type, tag, name, RS_MirrorEventText() );
    }
}

Vec3 RACE_MirrorPredict( MirrorPlayer@ rp )
{
    uint age = realTime - rp.receivedAt;
    if ( age > MIRROR_EXTRAPOLATE_MAX )
        age = MIRROR_EXTRAPOLATE_MAX; // stale stream: freeze instead of drifting into walls
    return rp.origin + rp.velocity * ( age / 1000.0f );
}

// Release any local spectator chasing the given bot slot back to free-fly
// spectate. Clearing chaseActive alone is NOT enough: a chasing spectator has
// movetype MOVETYPE_NONE (the engine's G_GhostClient sets it when chasecam
// starts), and once chaseActive is false the engine's ClientThink maps
// "movetype is neither PLAYER nor NOCLIP" straight to PM_FREEZE — so the
// spectator freezes in place and can only recover by reconnecting. We must
// also restore MOVETYPE_NOCLIP, exactly as the engine's own observer fallback
// does (G_ChasePlayer's "No one to chase" branch in g_chase.cpp), so ClientThink
// yields PM_SPECTATOR and free-fly movement resumes. optionalMsg is printed to
// each released spectator when non-empty.
void RACE_MirrorReleaseChasers( int botSlot, const String &in optionalMsg )
{
    if ( botSlot < 0 )
        return;
    int botEntNum = botSlot + 1;
    for ( int i = 0; i < maxClients; i++ )
    {
        Client@ c = G_GetClient( i );
        if ( c.state() >= CS_SPAWNED && c.chaseActive && c.chaseTarget == botEntNum )
        {
            c.chaseActive = false;                       // drop to free spectate
            c.getEnt().moveType = MOVETYPE_NOCLIP;       // ...and unfreeze the camera
            if ( optionalMsg.length() > 0 )
                c.printMessage( optionalMsg );
        }
    }
}

// Free the fake-client slot that represents this remote player, if any.
// A bot is removed when its source player leaves, goes to spectator, or goes
// idle (their server drops them from the broadcast). Any local player who was
// spectating that bot would be left staring at a dropped slot, so bump them
// back to free-fly spectate first.
void RACE_MirrorRemoveBot( MirrorPlayer@ rp )
{
    if ( rp.botSlot >= 0 )
    {
        RACE_MirrorReleaseChasers( rp.botSlot, "[" + rp.server + S_COLOR_WHITE + "] " + rp.name
                + S_COLOR_YELLOW + " left the race - spectating freely.\n" );
        RS_MirrorBotRemove( rp.botSlot );
        rp.botSlot = -1;
    }
}

// Each frame: keep a real fake-client ("mirror bot") in sync for every remote
// player on OUR map. The bot occupies a client slot, so it appears on the
// scoreboard, is chaseable with the normal spectator controls, and its view
// angles drive a first-person POV when chased "in eyes". Remote players on a
// different map (or that vanished) get their bot dropped.
void RACE_MirrorUpdateBots()
{
    int botCount = 0;
    int maxBots = rsMirrorMaxGhosts.integer;

    for ( uint i = 0; i < mirrorPlayers.length(); i++ )
    {
        MirrorPlayer@ rp = mirrorPlayers[i];

        // bots only make sense on the same map; chat/roster still flow
        if ( rp.map != mirrorLocalMap )
        {
            RACE_MirrorRemoveBot( rp );
            continue;
        }

        if ( rp.botSlot < 0 )
        {
            if ( botCount >= maxBots )
                continue;
            RACE_MirrorAssignColour( rp );
            rp.botSlot = RS_MirrorBotAdd( rp.name, rp.server, rp.cr, rp.cg, rp.cb );
            if ( rp.botSlot < 0 )
                continue; // no free client slot right now; retry next frame
            rp.hasRender = false; // (re)seed smoothing on a fresh bot
        }
        botCount++;

        // Target = the extrapolated position (dead-reckon a little past the last
        // sample so we track fast racers), then EASE the rendered pose toward it
        // each frame. Easing removes the stepwise snap when a new sample lands,
        // turning ~60Hz updates into continuous motion; velocity still drives the
        // client's run/jump animation. Large corrections (respawn/teleport) snap.
        Vec3 target = RACE_MirrorPredict( rp );
        if ( !rp.hasRender )
        {
            rp.renderPos = target;
            rp.renderAng = rp.angles;
            rp.hasRender = true;
        }
        else
        {
            Vec3 d = target - rp.renderPos;
            if ( d * d > MIRROR_SNAP_DISTANCE * MIRROR_SNAP_DISTANCE )
            {
                rp.renderPos = target;
                rp.renderAng = rp.angles;
            }
            else
            {
                rp.renderPos = Lerp( rp.renderPos, MIRROR_SMOOTH, target );
                rp.renderAng = LerpAngles( rp.renderAng, MIRROR_SMOOTH, rp.angles );
            }
        }

        RS_MirrorBotUpdate( rp.botSlot, rp.renderPos, rp.renderAng, rp.velocity, rp.flags );
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

// watch <#|name|off> — because remote players are real fake-client bots here,
// this just points the NATIVE chasecam at the chosen bot, so the normal
// spectator controls (chasenext/chaseprev, in-eyes POV) all work on it. The
// number is the row index shown by /who (position in mirrorPlayers).
bool Cmd_MirrorWatch( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( !RACE_MirrorEnabled() )
    {
        client.printMessage( "Cross-server mirroring is not enabled on this server.\n" );
        return true;
    }

    String first = argsString.getToken( 0 );
    if ( first == "" )
    {
        client.printMessage( "Usage: watch <#>  |  watch <name>  |  watch off   (numbers from /who)\n" );
        client.printMessage( "Remote players are real bots here, so spec + chasenext/chaseprev work too.\n" );
        return true;
    }
    if ( first == "off" )
    {
        client.chaseActive = false;
        client.printMessage( "Watch stopped.\n" );
        return true;
    }
    if ( client.team != TEAM_SPECTATOR )
    {
        client.printMessage( "You must be spectating first (use spec), then watch <#>.\n" );
        return true;
    }

    MirrorPlayer@ found = null;

    if ( first.isNumeric() )
    {
        int n = first.toInt();
        if ( n >= 1 && n <= int( mirrorPlayers.length() ) )
            @found = mirrorPlayers[n - 1];
    }
    if ( @found == null )
    {
        String pattern = argsString.trim().removeColorTokens().tolower();
        for ( uint i = 0; i < mirrorPlayers.length(); i++ )
        {
            String clean = mirrorPlayers[i].name.removeColorTokens().tolower();
            if ( clean == pattern ) { @found = mirrorPlayers[i]; break; }
            if ( @found == null && PatternMatch( clean, pattern ) ) @found = mirrorPlayers[i];
        }
    }

    if ( @found == null )
    {
        client.printMessage( "No remote player matches '" + first + "'. Try /who.\n" );
        return true;
    }
    if ( found.map != mirrorLocalMap || found.botSlot < 0 )
    {
        client.printMessage( "[" + found.server + S_COLOR_WHITE + "] " + found.name
                + S_COLOR_WHITE + " is on " + S_COLOR_GREEN + found.map
                + S_COLOR_WHITE + " - not spectatable here right now.\n" );
        return true;
    }

    // native chasecam onto the mirror bot (entnum = playerNum + 1)
    client.chaseActive = true;
    client.chaseTarget = found.botSlot + 1;
    client.printMessage( "Spectating [" + found.server + S_COLOR_WHITE + "] " + found.name
            + S_COLOR_WHITE + " - chasenext/chaseprev to cycle, watch off to stop.\n" );
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

    if ( mirrorPlayers.length() == 0 )
    {
        client.printMessage( "No peered players online.\n" );
        return true;
    }

    // Numbered rows; the number is what /watch <#> takes (index in mirrorPlayers).
    for ( uint i = 0; i < mirrorPlayers.length(); i++ )
    {
        MirrorPlayer@ rp = mirrorPlayers[i];
        String status;
        if ( rp.map != mirrorLocalMap )
            status = S_COLOR_WHITE + "on " + rp.map;
        else if ( ( rp.flags & 1 ) != 0 )
            status = S_COLOR_GREEN + "racing";
        else
            status = S_COLOR_WHITE + "idle";
        client.printMessage( "  " + S_COLOR_YELLOW + ( i + 1 ) + "." + S_COLOR_WHITE
                + " [" + rp.server + S_COLOR_WHITE + "] " + rp.name + "  " + status + "\n" );
    }
    client.printMessage( S_COLOR_WHITE + "spec, then " + S_COLOR_YELLOW + "watch <#>"
            + S_COLOR_WHITE + " (or chasenext) to spectate a remote player.\n" );

    return true;
}
