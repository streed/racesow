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
// Overflow key: one serverinfo value caps at MAX_INFO_VALUE (64), which only
// fits ~2 "TAG:map:players" records once map names are long (e.g. aurora-speed1),
// so a 3rd+ peer would be dropped. Spill into rs_mesh_status2; the web concats
// the two (live.js parseMeshStatus). Two 63-char keys hold ~6 peers.
Cvar rsMeshStatus2( "rs_mesh_status2", "", CVAR_SERVERINFO );

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

// Wire "flags" bits carried by RS_MirrorPlayer / RS_MirrorPlayerState. bit0 =
// racing, bit2 = the player is spectating on their origin server. bit1 (value
// 2) is reserved for the LOCAL WR-ghost convention consumed by RS_MirrorBotUpdate
// (see ghostbot.as) and is never set on the wire, so remote spectators use bit2.
const int MIRROR_FLAG_RACING = 1;
const int MIRROR_FLAG_SPECTATOR = 4;

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
    int flags;     // bit0 = racing, bit2 = spectating (see MIRROR_FLAG_*)
    int score;     // origin player's best finish time on their map (ms), 0 = none
    bool spectator; // true = spectating on their origin server (no world ghost)
    uint receivedAt; // realTime when the last state row arrived
    bool seen;     // mark/sweep flag for roster sync
    int botSlot;   // fake-client playerNum representing this player, or -1
    bool botIsSpectator; // kind of the fake client currently held in botSlot
    int appliedScore;   // last score pushed onto the bot's scoreboard time (-1 = none yet)
    int cr, cg, cb; // random display colour, assigned once
    Vec3 renderPos; // smoothed position actually pushed to the bot
    Vec3 renderAng; // smoothed view angles
    bool hasRender; // renderPos/Ang seeded yet?

    MirrorPlayer()
    {
        this.flags = 0;
        this.score = 0;
        this.spectator = false;
        this.receivedAt = 0;
        this.seen = false;
        this.botSlot = -1;
        this.botIsSpectator = false;
        this.appliedScore = -1;
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

///*****************************************************************
/// Cross-mesh presence + activity feed — make the mesh feel like one big
/// server. Notable moments (a new server record, a top-3 finish) are broadcast
/// to every peer so each server sees "what's happening on the network" live,
/// and players get an ambient picture of who's online elsewhere.
///
/// The activity broadcast rides the EXISTING bridged chat event ("C") with a
/// sentinel-prefixed payload, so it needs no new native/event kind. The receiver
/// (RACE_MirrorDrainEvents) routes any "C" event whose text starts with the
/// sentinel to RACE_MirrorRenderActivity instead of printing it as chat. Payload
/// (the event's tab-delimited text field, so intra-field spaces are safe):
///   ~RSACT~ <rec|fin> <rev:0|1> <rank> <timeMs> <mapname>
///   ~RSACT~ ach 0 0 0 <tier> <title words...>   (achievement unlocked flair)
///*****************************************************************

const String MESH_ACT_SENTINEL = "~RSACT~";
const uint MESH_PRESENCE_INTERVAL = 180000; // ms between ambient network lines (3 min)
uint mirrorNextPresence = 0;

// Broadcast a notable local finish to the mesh. `actor` = the finishing player's
// name (its own event field, so spaces/colours are fine); no-op when mirroring
// is off. Records use kind "rec" (rank ignored); top finishes use "fin" with the
// 1-based rank; achievement unlocks use "ach" (awards.as) with rev/rank/time
// zeroed and the map field carrying "<tier> <title...>". A server never hears
// its OWN events, so this is peer-facing only — the local server shows its own
// finishes through the normal race announces.
void RACE_MirrorBroadcastActivity( const String &in actor, const String &in kind, bool reversed, int rank, uint timeMs, const String &in map )
{
    if ( !RACE_MirrorEnabled() )
        return;
    String payload = MESH_ACT_SENTINEL + " " + kind + " " + ( reversed ? "1" : "0" )
            + " " + rank + " " + timeMs + " " + map;
    RS_MirrorEvent( "C", actor, payload );
}

// True only for a WELL-FORMED activity payload: the sentinel, a known kind, and
// a non-empty map field. Because activity shares the "C" chat channel, a chat
// line that merely starts with the sentinel would otherwise be mis-rendered as a
// garbled feed entry — this structural check routes such chat back to normal
// display. (A deliberately hand-crafted valid payload typed in chat is still
// flood-limited and self-attributed; a fully spoof-proof feed needs a dedicated
// mesh event kind, i.e. a small native change.)
bool RACE_MirrorLooksLikeActivity( const String &in body )
{
    if ( body.getToken( 0 ) != MESH_ACT_SENTINEL )
        return false;
    String kind = body.getToken( 1 );
    if ( kind != "rec" && kind != "fin" && kind != "ach" )
        return false;
    return body.getToken( 5 ).length() > 0; // map field (ach: tier) present
}

// Render a received activity payload as a one-line network-feed entry. Called
// from RACE_MirrorDrainEvents for a "C" event whose text is sentinel-prefixed.
void RACE_MirrorRenderActivity( const String &in tag, const String &in actor, const String &in payload )
{
    String kind = payload.getToken( 1 );
    bool reversed = payload.getToken( 2 ) == "1";
    int rank = payload.getToken( 3 ).toInt();
    uint timeMs = uint( payload.getToken( 4 ).toInt() );
    String map = payload.getToken( 5 );
    String revNote = "";
    if ( reversed )
        revNote = " (reverse)";
    String head = S_COLOR_ORANGE + ">> " + S_COLOR_WHITE + "[" + tag + S_COLOR_WHITE + "] " + actor;
    if ( kind == "ach" )
    {
        // Token 5 is the tier; the title is every following token (it is the
        // only multi-word field, so a space-joined rebuild is faithful enough).
        String tier = map;
        String title = "";
        for ( int t = 6; ; t++ )
        {
            String tok = payload.getToken( t );
            if ( tok.length() == 0 )
                break;
            if ( title.length() > 0 )
                title += " ";
            title += tok;
        }
        if ( title.length() == 0 )
            title = tier; // degenerate payload: show something rather than nothing
        String color = RACE_AwardTierColor( tier );
        // Per-viewer, like a local unlock: a player who set cg_raceShowAchievements
        // 0 is opting out of the achievement feed as a whole, peers included.
        RACE_AwardsBroadcast( head + " " + color + "unlocked " + S_COLOR_WHITE + "["
                + color + title + S_COLOR_WHITE + "]\n" );
    }
    else if ( kind == "rec" )
        G_PrintMsg( null, head + S_COLOR_YELLOW + " * NEW RECORD " + S_COLOR_WHITE + "on "
                + S_COLOR_GREEN + map + revNote + S_COLOR_WHITE + "  " + S_COLOR_GREEN + RACE_TimeToString( timeMs ) + "\n" );
    else
        G_PrintMsg( null, head + S_COLOR_WHITE + " finished " + S_COLOR_YELLOW + "#" + rank
                + S_COLOR_WHITE + " on " + S_COLOR_GREEN + map + revNote + S_COLOR_WHITE + "  "
                + S_COLOR_GREEN + RACE_TimeToString( timeMs ) + "\n" );
}

// A compact one-line summary of who's online across the mesh right now: each
// peer server that has players, with its count and map. Built from the live peer
// registry (RS_MirrorPeer*, which includes empty peers) counted against the
// remote-player roster (mirrorPlayers).
String RACE_MirrorNetworkLine()
{
    RS_MirrorRefresh();
    int pc = RS_MirrorPeerCount();
    String line = S_COLOR_ORANGE + "Network: " + S_COLOR_WHITE;
    int shown = 0;
    for ( int i = 0; i < pc; i++ )
    {
        String ptag = RS_MirrorPeerTag( i );
        if ( ptag.removeColorTokens().length() == 0 )
            continue;
        int players = 0;
        for ( uint j = 0; j < mirrorPlayers.length(); j++ )
        {
            if ( mirrorPlayers[j].server == ptag && !mirrorPlayers[j].spectator )
                players++;
        }
        if ( players == 0 )
            continue; // compact line: only servers with players
        String pmap = RS_MirrorPeerMap( i );
        if ( shown > 0 )
            line += S_COLOR_WHITE + "   ";
        line += "[" + ptag + S_COLOR_WHITE + "] " + players + S_COLOR_WHITE + " on " + S_COLOR_GREEN + pmap;
        shown++;
    }
    if ( shown == 0 )
        line += "you're the only players online right now";
    return line;
}

// Ambient network line, printed to everyone at a low frequency so players stay
// aware of the wider mesh without typing /who. Silent when nobody is on any peer
// (a solo session shouldn't be nagged). Called each frame from RACE_MirrorThink.
void RACE_MirrorPresenceTick()
{
    if ( realTime < mirrorNextPresence )
        return;
    mirrorNextPresence = realTime + MESH_PRESENCE_INTERVAL;
    if ( mirrorPlayers.length() == 0 )
        return;
    G_PrintMsg( null, RACE_MirrorNetworkLine() + "\n" );
}

// Greet a joining player with the network picture + the commands that make the
// mesh feel like one server. Skipped for a solo session and for fake clients.
void RACE_MirrorGreet( Client@ client )
{
    if ( client is null || RACE_MirrorIsFakeClient( client ) || RACE_IsTvClient( client ) )
        return;
    if ( mirrorPlayers.length() == 0 )
        return;
    client.printMessage( RACE_MirrorNetworkLine() + "\n" );
    client.printMessage( S_COLOR_WHITE + "Use " + S_COLOR_YELLOW + "/who" + S_COLOR_WHITE + " to see everyone, "
            + S_COLOR_YELLOW + "/watch <#>" + S_COLOR_WHITE + " to spectate them, or "
            + S_COLOR_YELLOW + "/meshvote sync <server>" + S_COLOR_WHITE + " to bring their map here.\n" );
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

// Fastest finish time (ms) any peer is currently advertising for OUR map, or 0
// if none. Reads the per-player 'score' already synced over the mesh (see
// RACE_MirrorSyncRoster) — no new wire traffic. Cross-map peer rows are ignored
// (their score is a time on a DIFFERENT map); the C side already purges rows for
// peers that change map, and we further gate on rp.map == mirrorLocalMap so a
// peer mid-map-transition can't leak a foreign time. This is the freshness
// signal the in-game WR ghost racer (ghostbot.as) uses to know a better WR may
// exist and re-pull the canonical ghost from the web store.
int RACE_MeshBestFinishForLocalMap()
{
    int best = 0;
    for ( uint i = 0; i < mirrorPlayers.length(); i++ )
    {
        MirrorPlayer@ rp = mirrorPlayers[i];
        if ( rp.map != mirrorLocalMap || rp.score <= 0 )
            continue;
        if ( best == 0 || rp.score < best )
            best = rp.score;
    }
    return best;
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
    RACE_MirrorPresenceTick();

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
    String status2 = "";
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
            // count active players only (spectators show in /who + the spectator
            // list, but the web "players" tally keeps its prior meaning)
            if ( mirrorPlayers[j].server == rawTag && !mirrorPlayers[j].spectator )
                players++;
        }

        String rec = tag + ":" + map + ":" + players;
        String next = ( status.length() == 0 ) ? rec : ( status + "," + rec );
        if ( next.length() <= MESH_STATUS_MAX )
        {
            status = next;
            continue;
        }
        // First key full: spill this (and any later) record into the overflow key.
        String next2 = ( status2.length() == 0 ) ? rec : ( status2 + "," + rec );
        if ( next2.length() > MESH_STATUS_MAX )
            break; // both keys full — stop rather than lose a value to Info_Validate
        status2 = next2;
    }

    // Only write on change: trap_Cvar_Set flags serverinfo dirty every call.
    if ( status != rsMeshStatus.string )
        rsMeshStatus.set( status );
    if ( status2 != rsMeshStatus2.string )
        rsMeshStatus2.set( status2 );
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

// Canonical "is this slot a puppet rather than a person?" predicate.
//
// The base gametype asked this three different ways — RS_MirrorBotIs( int ),
// RACE_MirrorIsFakeClient( Client@ ), and an equality test against
// raceGhostBotSlot — which meant the base files reached directly for a mesh
// native and a ghost-module global just to answer one question. These two names
// are the single way to ask it, so that when the racesow.org layer is gated out
// there is exactly one thing to reimplement.
//
// Two NAMES rather than an int/Client@ overload pair: overload resolution
// across script sections differs between Warsow's AngelScript 2.29 and
// Warfork's AS2024, and this predicate is called from the scoreboard build, so
// a silent mis-resolution would be expensive to find.
//
// Note the deliberate asymmetry, preserved exactly from the call sites these
// replaced: the Client@ form also accepts anything flagged SVF_FAKECLIENT,
// the int form asks the mesh layer only. Widening the int form would change
// who is skipped in GT_ThinkRules, so it is left alone here.
//
// SVF_FAKECLIENT is a STOCK engine flag, which is what makes a base-only
// implementation of this predicate possible with no natives at all.
bool RACE_IsPuppet( Client@ client )
{
    return RACE_MirrorIsFakeClient( client );
}

bool RACE_IsPuppetNum( int playerNum )
{
    return RS_MirrorBotIs( playerNum );
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
    // The server-side TV camera (rs_tv_name / RACESOW-TV) is infra, not a real
    // player: keep its join off the mesh so peers don't announce it (it is
    // already excluded from mirroring, player counts and /who).
    if ( RACE_IsTvClient( client ) )
        return;
    RS_MirrorEvent( "J", client.name, "" );
}

void RACE_MirrorPlayerLeft( Client@ client )
{
    if ( !RACE_MirrorEnabled() || @client == null )
        return;
    if ( RACE_MirrorIsFakeClient( client ) )
        return; // mirror bots are peer players, not local ones (see Joined)
    if ( RACE_IsTvClient( client ) )
        return; // the TV camera is infra; keep its leave off the mesh (see Joined)
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
        if ( client.state() < CS_SPAWNED )
            continue;

        // Never mirror the local TV camera to peers. It is infra (the website
        // stream's server-side spectator, rs_tv_name), already excluded from the
        // player counts, /who and getstatus. A peer receiving it would collide
        // with its OWN local RACESOW-TV, forcing an engine "(1)" dup-suffix that
        // no longer exact-name-matches rs_tv_name and so breaks that peer's TV
        // auto-director. Keep the camera strictly local to each box.
        if ( RACE_IsTvClient( client ) )
            continue;

        Player@ player = RACE_GetPlayer( client );
        Entity@ ent = client.getEnt();

        // Everyone carries their best finish time on this map so peers can show
        // it on the scoreboard (0 = no time yet).
        int score = player.best_recordTime.isFinished() ? int( player.best_recordTime.getFinishTime() ) : 0;

        if ( client.team == TEAM_SPECTATOR )
        {
            // Publish spectators too, tagged, so peers can list them ("see all
            // players"). A spectator has no meaningful body — the position is
            // ignored by the receiver, which renders them as a spectator entry.
            RS_MirrorPlayer( client.name, ent.origin, ent.angles, ent.velocity, MIRROR_FLAG_SPECTATOR, score );
            continue;
        }

        // Active players: skip transient no-body states (dead / between runs /
        // noclip) and private practice runs — unchanged from before.
        if ( ent.isGhosting() || ent.moveType == MOVETYPE_NOCLIP )
            continue;
        if ( player.practicing )
            continue;

        int flags = player.inRace ? MIRROR_FLAG_RACING : 0;
        RS_MirrorPlayer( client.name, ent.origin, ent.angles, ent.velocity, flags, score );
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

        // "x y z pitch yaw roll vx vy vz flags score ageMs"
        String state = RS_MirrorPlayerState( i );
        rp.origin = Vec3( state.getToken( 0 ).toFloat(), state.getToken( 1 ).toFloat(), state.getToken( 2 ).toFloat() );
        rp.angles = Vec3( state.getToken( 3 ).toFloat(), state.getToken( 4 ).toFloat(), state.getToken( 5 ).toFloat() );
        rp.velocity = Vec3( state.getToken( 6 ).toFloat(), state.getToken( 7 ).toFloat(), state.getToken( 8 ).toFloat() );
        rp.flags = state.getToken( 9 ).toInt();
        rp.score = state.getToken( 10 ).toInt();
        rp.spectator = ( rp.flags & MIRROR_FLAG_SPECTATOR ) != 0;
        rp.receivedAt = realTime - uint( state.getToken( 11 ).toInt() );
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
        {
            // A "C" event is either real cross-server chat or a sentinel-prefixed
            // activity broadcast (record / top finish) — route accordingly.
            String body = RS_MirrorEventText();
            if ( RACE_MirrorLooksLikeActivity( body ) )
                RACE_MirrorRenderActivity( tag, name, body );
            else
                G_PrintMsg( null, "[" + tag + S_COLOR_WHITE + "] " + name
                        + S_COLOR_GREEN + ": " + S_COLOR_WHITE + body + "\n" );
        }
        else if ( type == 2 )
            G_PrintMsg( null, S_COLOR_ORANGE + ">> " + S_COLOR_WHITE + "[" + tag + S_COLOR_WHITE + "] " + name
                    + S_COLOR_YELLOW + " connected\n" );
        else if ( type == 3 )
            G_PrintMsg( null, S_COLOR_ORANGE + ">> " + S_COLOR_WHITE + "[" + tag + S_COLOR_WHITE + "] " + name
                    + S_COLOR_YELLOW + " disconnected\n" );
        else if ( type == 7 ) // M: a peer changed map
            G_PrintMsg( null, S_COLOR_ORANGE + ">> " + S_COLOR_WHITE + "[" + tag + S_COLOR_WHITE + "] "
                    + S_COLOR_YELLOW + "now on " + S_COLOR_GREEN + name + "\n" );
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

        // Bots only make sense for players on OUR map (chat/roster still flow for
        // off-map peers). Racers get a driven in-world ghost on the players team;
        // spectators get a hidden fake client on the spectator team so they show
        // in the peer's spectator list. wantKind: -1 none, 0 racer, 1 spectator.
        int wantKind = -1;
        if ( rp.map == mirrorLocalMap )
            wantKind = rp.spectator ? 1 : 0;

        // A racer<->spectator transition (or the player leaving our map) leaves
        // the held bot as the wrong kind: drop it and re-create it below on the
        // correct team. RACE_MirrorRemoveBot releases anyone chasing it.
        if ( rp.botSlot >= 0 )
        {
            int haveKind = rp.botIsSpectator ? 1 : 0;
            if ( wantKind != haveKind )
                RACE_MirrorRemoveBot( rp );
        }

        if ( wantKind < 0 )
        {
            RACE_MirrorRemoveBot( rp ); // no-op if already gone
            continue;
        }

        if ( rp.botSlot < 0 )
        {
            if ( botCount >= maxBots )
                continue;
            RACE_MirrorAssignColour( rp );
            rp.botSlot = RS_MirrorBotAdd( rp.name, rp.server, rp.cr, rp.cg, rp.cb, wantKind == 1 );
            if ( rp.botSlot < 0 )
                continue; // no free client slot right now; retry next frame
            rp.botIsSpectator = ( wantKind == 1 );
            rp.appliedScore = -1;  // force a scoreboard-time refresh onto the new bot
            rp.hasRender = false;  // (re)seed smoothing on a fresh bot
            // Pull this remote player's global Skill Rating for the scoreboard's
            // SR column (playerrecord.as applies ONLY the rating to a bot — its
            // time comes from the peer over the mesh, not from our map's board).
            // Racer bots only: spectator bots are not on the players team the
            // record poller walks, so a fetch for one would never be collected.
            if ( wantKind == 0 )
                RACE_TriggerMirrorBotRecordFetch( rp.botSlot );
        }
        botCount++;

        if ( wantKind == 1 )
            continue; // spectator bot: no in-world transform to drive, no scoreboard time

        // Reflect the remote player's synced best time + racing state onto the
        // fake client so the peer scoreboard shows their time (idempotent).
        RACE_MirrorApplyScore( rp );

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

// Push the remote player's synced best time onto its fake client so the peer
// scoreboard renders it (the race scoreboard reads Player.best_recordTime), and
// mirror their racing state into the "Racing" column. best_recordTime is only
// rewritten when the value actually changes. A minimal one-checkpoint finished
// RecordTime is enough: the scoreboard only reads isFinished()/getFinishTime().
void RACE_MirrorApplyScore( MirrorPlayer@ rp )
{
    if ( rp.botSlot < 0 )
        return;
    Client@ bc = G_GetClient( rp.botSlot );
    if ( @bc == null )
        return;
    Player@ bp = RACE_GetPlayer( bc );
    bp.inRace = ( rp.flags & MIRROR_FLAG_RACING ) != 0;

    if ( rp.appliedScore == rp.score )
        return;
    rp.appliedScore = rp.score;

    // best_recordTime is a PERSISTENT per-slot object — a real human may inherit
    // this client slot after the bot is dropped — so keep its checkpoints array
    // the exact shape the rest of the gametype relies on (numCheckpoints+1, set
    // for every slot at map spawn). Never shrink it: code elsewhere indexes
    // checkpoints[numCheckpoints], so a 1-element array would fault. The finish
    // time lives in the last slot, matching a real finish (player.as).
    if ( rp.score > 0 )
    {
        RecordTime rt;
        rt.setupArrays( numCheckpoints + 1 );
        rt.checkpoints[ numCheckpoints ] = Checkpoint( uint( rp.score ), CheckpointType_Finish );
        rt.type = RecordTimeType_Finished;
        bp.best_recordTime = rt;
    }
    else
    {
        bp.best_recordTime.clear(); // already sized numCheckpoints+1; clear() keeps the shape
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
    if ( found.spectator )
    {
        client.printMessage( "[" + found.server + S_COLOR_WHITE + "] " + found.name
                + S_COLOR_WHITE + " is spectating - nothing to watch.\n" );
        return true;
    }
    if ( found.map != mirrorLocalMap || found.botSlot < 0 || found.botIsSpectator )
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

    RS_MirrorRefresh();

    // Real local humans (exclude the mirror bots that stand in for peer players).
    int localCount = 0;
    for ( int i = 0; i < maxClients; i++ )
    {
        Client@ other = G_GetClient( i );
        if ( other.state() >= CS_SPAWNED && other.team != TEAM_SPECTATOR && !RACE_MirrorIsFakeClient( other ) )
            localCount++;
    }

    int pc = RS_MirrorPeerCount();
    int totalPlayers = localCount + int( mirrorPlayers.length() );
    String plural = "";
    if ( totalPlayers != 1 )
        plural = "s";
    client.printMessage( S_COLOR_ORANGE + "Network: " + S_COLOR_WHITE + totalPlayers
            + " player" + plural + " on " + ( pc + 1 ) + " servers\n" );

    // This server, then every peer (including EMPTY ones — their keepalives carry
    // the map), each with its live player count. This is the "one big server,
    // different maps" view.
    client.printMessage( "  " + S_COLOR_GREEN + "[" + rsMirrorTag.string + S_COLOR_GREEN + "] "
            + S_COLOR_WHITE + mirrorLocalMap + " - " + localCount + " here " + S_COLOR_YELLOW + "(you)\n" );
    for ( int i = 0; i < pc; i++ )
    {
        String ptag = RS_MirrorPeerTag( i );
        if ( ptag.removeColorTokens().length() == 0 )
            continue;
        int players = 0;
        for ( uint j = 0; j < mirrorPlayers.length(); j++ )
        {
            if ( mirrorPlayers[j].server == ptag && !mirrorPlayers[j].spectator )
                players++;
        }
        String pmap = RS_MirrorPeerMap( i );
        String mapPart;
        if ( pmap.length() > 0 )
            mapPart = S_COLOR_GREEN + pmap;
        else
            mapPart = S_COLOR_WHITE + "(unknown)";
        String countPart;
        if ( players > 0 )
            countPart = "" + players + " playing";
        else
            countPart = "empty";
        client.printMessage( "  [" + ptag + S_COLOR_WHITE + "] " + mapPart
                + S_COLOR_WHITE + " - " + countPart + "\n" );
    }

    if ( mirrorPlayers.length() == 0 )
    {
        if ( localCount <= 1 )
            client.printMessage( S_COLOR_WHITE + "You've got the network to yourself right now.\n" );
        return true;
    }

    // Numbered rows; the number is what /watch <#> takes (index in mirrorPlayers).
    client.printMessage( S_COLOR_WHITE + "Players elsewhere " + S_COLOR_YELLOW + "(watch <#>)" + S_COLOR_WHITE + ":\n" );
    for ( uint i = 0; i < mirrorPlayers.length(); i++ )
    {
        MirrorPlayer@ rp = mirrorPlayers[i];
        String status;
        if ( rp.spectator )
            status = ( rp.map != mirrorLocalMap )
                    ? ( S_COLOR_WHITE + "spectating on " + rp.map )
                    : ( S_COLOR_WHITE + "spectating" );
        else if ( rp.map != mirrorLocalMap )
            status = S_COLOR_WHITE + "on " + rp.map;
        else if ( ( rp.flags & MIRROR_FLAG_RACING ) != 0 )
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
