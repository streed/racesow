// Cross-server mesh map vote (master model).
//
// A NEW mechanism, separate from the native callvote (Cmd_CallvoteValidate /
// Cmd_CallvotePassed are untouched). Any player can start a mesh-wide vote to
// change ALL peered servers to a new map together:
//
//   /meshvote <map>     start a vote (you become the master)
//   /meshvote yes|no    cast / change your vote
//   /meshvote status    show the live tally
//   /meshvote cancel    master only: abort the vote
//
// The ORIGINATING server is the MASTER for that vote: it is the only one that
// aggregates tallies and decides pass/fail, so there is no distributed
// consensus / split-brain. Every server casts locally and broadcasts its own
// (yes,no,eligible) subtotal; the master sums them, and on pass broadcasts a
// result. Servers switch on receiving the result (no cross-server clock sync
// needed — the spread is just network latency). Only ONE mesh vote runs at a
// time; a simultaneous second open resolves to the lexicographically-smaller
// vote id so all servers converge on the same vote without negotiation.
//
// Rides the mesh 'E' event channel (kinds O/T/R -> RS_MirrorNextEvent types
// 4/5/6), reusing the HMAC auth, dedup window and re-send-once loss insurance.

const uint MESHVOTE_DURATION = 60000;       // ms voting window (60s)
const uint MESHVOTE_COOLDOWN = 30000;       // ms before another vote may open
const uint MESHVOTE_TALLY_INTERVAL = 1000;  // ms between subtotal broadcasts
const uint MESHVOTE_RESULT_INTERVAL = 500;  // ms between result re-broadcasts
const uint MESHVOTE_SWITCH_DELAY = 1500;    // ms after result before the switch
const uint MESHVOTE_EXPIRE_GRACE = 8000;    // ms past deadline before giving up (master gone)
const int MESHVOTE_MIN_YES = 2;             // floor so one player can't move the mesh

// --- active vote state (all reset on map load, which is fine: a passed vote
//     ends in a map load anyway, and a vote in flight during an unrelated map
//     change is simply abandoned on that server) ---
bool mvActive = false;
String mvVoteId = "";
String mvMap = "";
String mvMaster = "";   // tag of the originating (master) server
bool mvIsMaster = false;
uint mvDeadline = 0;    // realTime the vote closes
int[] mvBallot( maxClients ); // per local client: 0 none, 1 yes, 2 no

// master-only aggregation: latest subtotal per peer tag (parallel arrays)
String[] mvTagList;
int[] mvTagYes;
int[] mvTagNo;
int[] mvTagElig;

// pending switch (set on pass, on master and peers alike)
bool mvSwitching = false;
String mvSwitchMap = "";
uint mvSwitchAt = 0;

// result re-broadcast (master only): keep re-sending R for a short window so
// every peer — even one that missed the open — reliably learns and switches.
bool mvResultActive = false;
String mvResultId = "";
String mvResultText = "";
uint mvResultUntil = 0;
String mvLastResultId = ""; // dedup: the last vote id we acted a result on

uint mvNextTally = 0;
uint mvNextResult = 0;
uint mvCooldownUntil = 0;

void RACE_MeshVoteInit()
{
    G_RegisterCommand( "meshvote" );
    G_RegisterCommand( "mv" ); // short alias
}

// Deterministic lexicographic compare (String has no opCmp, only opEquals) so
// two simultaneously-opened votes resolve to the same survivor everywhere.
bool RACE_MeshVoteIdLess( const String &in a, const String &in b )
{
    uint n = a.length() < b.length() ? a.length() : b.length();
    for ( uint i = 0; i < n; i++ )
    {
        uint8 ca = a[i];
        uint8 cb = b[i];
        if ( ca != cb )
            return ca < cb;
    }
    return a.length() < b.length();
}

bool RACE_MapExists( const String &in name )
{
    String want = name.removeColorTokens().tolower();
    if ( want.length() == 0 )
        return false;
    uint i = 0;
    while ( true )
    {
        const String@ m = ML_GetMapByNum( i++ );
        if ( @m == null )
            break;
        // Length first: this walks every installed .bsp — ~4,600 of them — and
        // tolower() builds a throwaway String for each one it is called on. A
        // length mismatch rules a name out with an integer compare and no
        // allocation, which is almost all of them. Sound because the comparison
        // below already assumes an installed map name carries no colour tokens
        // (it lowercases m but does not strip it), and tolower() never changes
        // length.
        if ( m.length() != want.length() )
            continue;
        if ( m.tolower() == want )
            return true;
    }
    return false;
}

// Local voting-eligible clients = spawned, on the players team, real humans
// (mirror bots and spectators don't vote).
bool RACE_MeshVoteEligible( int i )
{
    if ( RS_MirrorBotIs( i ) )
        return false;
    Client@ c = G_GetClient( i );
    return c.state() >= CS_SPAWNED && c.team != TEAM_SPECTATOR;
}

void RACE_MeshVoteLocalCounts( int &out yes, int &out no, int &out elig )
{
    yes = 0; no = 0; elig = 0;
    for ( int i = 0; i < maxClients; i++ )
    {
        if ( !RACE_MeshVoteEligible( i ) )
            continue;
        elig++;
        if ( mvBallot[i] == 1 ) yes++;
        else if ( mvBallot[i] == 2 ) no++;
    }
}

void RACE_MeshVoteReset( uint cooldownMs )
{
    mvActive = false;
    mvVoteId = ""; mvMap = ""; mvMaster = ""; mvIsMaster = false;
    for ( int i = 0; i < maxClients; i++ )
        mvBallot[i] = 0;
    mvTagList.resize( 0 ); mvTagYes.resize( 0 ); mvTagNo.resize( 0 ); mvTagElig.resize( 0 );
    if ( cooldownMs > 0 )
        mvCooldownUntil = realTime + cooldownMs;
}

// Master: record/replace a peer server's latest subtotal.
void RACE_MeshVoteStoreTag( const String &in tag, int yes, int no, int elig )
{
    for ( uint i = 0; i < mvTagList.length(); i++ )
    {
        if ( mvTagList[i] == tag )
        {
            mvTagYes[i] = yes; mvTagNo[i] = no; mvTagElig[i] = elig;
            return;
        }
    }
    mvTagList.insertLast( tag );
    mvTagYes.insertLast( yes );
    mvTagNo.insertLast( no );
    mvTagElig.insertLast( elig );
}

// Master: total across all peer subtotals PLUS this server's own local count.
void RACE_MeshVoteAggregate( int &out yes, int &out no, int &out elig )
{
    int ly, ln, le;
    RACE_MeshVoteLocalCounts( ly, ln, le );
    yes = ly; no = ln; elig = le;
    for ( uint i = 0; i < mvTagList.length(); i++ )
    {
        yes += mvTagYes[i]; no += mvTagNo[i]; elig += mvTagElig[i];
    }
}

void RACE_MeshVoteAnnounce( const String &in msg )
{
    G_PrintMsg( null, S_COLOR_ORANGE + "[MESHVOTE] " + S_COLOR_WHITE + msg + "\n" );
}

///*****************************************************************
/// Command
///*****************************************************************

// Shared pre-flight for opening a NEW mesh vote (a map vote or a sync vote): no
// vote already running anywhere in the mesh, off cooldown, and the starter is an
// active player. Prints the reason and returns false when a vote can't start now.
bool RACE_MeshVoteCanStart( Client@ client )
{
    // A vote already running (ours, or a peer's OPEN we adopted) blocks a second
    // one — respect the earlier vote. RACE_MeshVoteOnEvent sets mvActive as soon
    // as a peer's OPEN arrives, so this fires the moment we've heard it.
    if ( mvActive )
    {
        String who = ( mvMaster == rsMirrorTag.string )
                ? "here" : ( "on [" + mvMaster + S_COLOR_WHITE + "]" );
        client.printMessage( "A mesh vote for " + S_COLOR_GREEN + mvMap + S_COLOR_WHITE
                + " is already in progress (started " + who + ") - only one mesh vote at a"
                + " time. Cast yours with " + S_COLOR_GREEN + "/meshvote yes"
                + S_COLOR_WHITE + " or " + S_COLOR_GREEN + "/meshvote no" + S_COLOR_WHITE + ".\n" );
        return false;
    }
    if ( realTime < mvCooldownUntil )
    {
        client.printMessage( "Please wait a bit before starting another mesh vote.\n" );
        return false;
    }
    if ( !RACE_MeshVoteEligible( client.playerNum ) )
    {
        client.printMessage( "Only active players can start a mesh vote.\n" );
        return false;
    }
    return true;
}

// Become master for a fresh vote on an already-resolved, already-validated map
// and broadcast the OPEN to the mesh. `context` is an optional phrase shown in
// the announce right after the map (e.g. a sync's " (syncing to [tag])"). Callers
// MUST have passed RACE_MeshVoteCanStart first.
void RACE_MeshVoteOpen( Client@ client, const String &in map, const String &in context )
{
    mvActive = true;
    mvIsMaster = true;
    mvMaster = rsMirrorTag.string;
    mvVoteId = rsMirrorTag.string + ":" + levelTime;
    mvMap = map;
    mvDeadline = realTime + MESHVOTE_DURATION;
    for ( int i = 0; i < maxClients; i++ )
        mvBallot[i] = 0;
    mvBallot[client.playerNum] = 1; // initiator votes yes
    mvNextTally = 0;

    // O(pen): name = voteId, text = "<map> <durationSec> <initiator>"
    RS_MirrorEvent( "O", mvVoteId, mvMap + " " + ( MESHVOTE_DURATION / 1000 ) + " " + client.name );
    RACE_MeshVoteAnnounce( client.name + " wants to change ALL servers to "
            + S_COLOR_GREEN + mvMap + S_COLOR_WHITE + context
            + " - /meshvote yes | /meshvote no (" + ( MESHVOTE_DURATION / 1000 ) + "s)" );
}

// List the peered servers a player can sync to (tag + current map) from the live
// peer registry — which includes EMPTY peers, since their keepalives carry the
// map (RS_MirrorPeerMap). Used by /meshvote sync with a missing/failed target.
void RACE_MeshVoteListPeers( Client@ client )
{
    RS_MirrorRefresh();
    int pc = RS_MirrorPeerCount();
    int shown = 0;
    for ( int i = 0; i < pc; i++ )
    {
        String ptag = RS_MirrorPeerTag( i );
        if ( ptag.removeColorTokens().length() == 0 )
            continue;
        String pmap = RS_MirrorPeerMap( i );
        String mapPart;
        if ( pmap.length() > 0 )
            mapPart = S_COLOR_GREEN + pmap;
        else
            mapPart = S_COLOR_WHITE + "(unknown map)";
        if ( shown == 0 )
            client.printMessage( "Servers you can sync to:\n" );
        client.printMessage( "  [" + ptag + S_COLOR_WHITE + "] " + mapPart + S_COLOR_WHITE + "\n" );
        shown++;
    }
    if ( shown == 0 )
        client.printMessage( "No peered servers are currently connected.\n" );
}

// /meshvote sync <server tag | /who number> — vote to move ALL mesh servers to
// whatever map the chosen peer is currently running. The target's map comes from
// the live peer registry (RS_MirrorPeerMap, which works even for an empty peer)
// or, for a /who number, the matching remote player's origin-server map. Once
// resolved to a concrete installed map it reuses the ordinary master vote flow.
bool Cmd_MeshVoteSync( Client@ client, const String &in argsString )
{
    if ( !RACE_MeshVoteCanStart( client ) )
        return true;

    String arg = argsString.getToken( 1 );
    if ( arg.length() == 0 )
    {
        client.printMessage( "Usage: meshvote sync <server tag | /who number> - move ALL servers to that server's current map.\n" );
        RACE_MeshVoteListPeers( client );
        return true;
    }

    RS_MirrorRefresh(); // freshen the peer snapshot we read below

    String targetTag = "";
    String targetMap = "";

    if ( arg.isNumeric() )
    {
        // A /who row number -> that remote player's origin server + its map.
        int n = arg.toInt();
        if ( n < 1 || n > int( mirrorPlayers.length() ) )
        {
            client.printMessage( "There is no /who row " + n + ". Use /who to list the numbered players.\n" );
            return true;
        }
        targetTag = mirrorPlayers[n - 1].server;
        targetMap = mirrorPlayers[n - 1].map;
    }
    else
    {
        // A server tag (case-insensitive substring). Peer tags are unique in the
        // registry, so the match set is at most one server per distinct tag.
        String want = arg.removeColorTokens().tolower();
        if ( want.length() == 0 ) // arg was all colour tokens - would match everything
        {
            client.printMessage( "Give a server tag or a /who number to sync to.\n" );
            RACE_MeshVoteListPeers( client );
            return true;
        }
        int pc = RS_MirrorPeerCount();
        int matches = 0;
        for ( int i = 0; i < pc; i++ )
        {
            String ptag = RS_MirrorPeerTag( i );
            String cleanTag = ptag.removeColorTokens().tolower();
            if ( cleanTag.length() == 0 )
                continue;
            if ( cleanTag.locate( want, 0 ) < cleanTag.length() )
            {
                targetTag = ptag;
                targetMap = RS_MirrorPeerMap( i );
                matches++;
            }
        }
        if ( matches == 0 )
        {
            client.printMessage( "No peered server matches '" + arg + "'.\n" );
            RACE_MeshVoteListPeers( client );
            return true;
        }
        if ( matches > 1 )
        {
            client.printMessage( "More than one server matches '" + arg + "' - be more specific.\n" );
            RACE_MeshVoteListPeers( client );
            return true;
        }
    }

    if ( targetTag.removeColorTokens().tolower() == rsMirrorTag.string.removeColorTokens().tolower() )
    {
        client.printMessage( "That is this server - pick another server to sync to.\n" );
        return true;
    }

    targetMap = targetMap.removeColorTokens().tolower();
    if ( targetMap.length() == 0 )
    {
        client.printMessage( "Don't know what map [" + targetTag + S_COLOR_WHITE + "] is on yet - try again in a moment.\n" );
        return true;
    }
    if ( !RACE_MapExists( targetMap ) )
    {
        client.printMessage( "[" + targetTag + S_COLOR_WHITE + "] is on " + S_COLOR_GREEN + targetMap
                + S_COLOR_WHITE + ", which is not installed on this server.\n" );
        return true;
    }
    if ( RACE_IsMapBlocked( targetMap ) )
    {
        client.printMessage( RACE_MapBlockedReason( targetMap ) );
        return true;
    }

    RACE_MeshVoteOpen( client, targetMap, " (syncing to [" + targetTag + S_COLOR_WHITE + "])" );
    return true;
}

bool Cmd_MeshVote( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( !RACE_MirrorEnabled() )
    {
        client.printMessage( "Cross-server mirroring is not enabled on this server.\n" );
        return true;
    }

    String sub = argsString.getToken( 0 ).tolower();

    if ( sub == "" )
    {
        client.printMessage( "Usage: meshvote <map | * | pattern*>  |  meshvote sync <server>  |  meshvote yes|no  |  meshvote status  |  meshvote cancel\n" );
        if ( mvActive )
            client.printMessage( "A mesh vote for " + S_COLOR_GREEN + mvMap + S_COLOR_WHITE + " is in progress.\n" );
        return true;
    }

    if ( sub == "yes" || sub == "no" )
    {
        if ( !mvActive )
        {
            client.printMessage( "No mesh vote is in progress. Start one with /meshvote <map>.\n" );
            return true;
        }
        if ( !RACE_MeshVoteEligible( client.playerNum ) )
        {
            client.printMessage( "Only active players can vote (join the game first).\n" );
            return true;
        }
        mvBallot[client.playerNum] = ( sub == "yes" ) ? 1 : 2;
        mvNextTally = 0; // push our updated subtotal promptly
        client.printMessage( "Voted " + ( sub == "yes" ? S_COLOR_GREEN + "YES" : S_COLOR_RED + "NO" )
                + S_COLOR_WHITE + " on the mesh vote for " + S_COLOR_GREEN + mvMap + "\n" );
        return true;
    }

    if ( sub == "status" )
    {
        if ( !mvActive )
        {
            client.printMessage( "No mesh vote is in progress.\n" );
            return true;
        }
        int y, n, e;
        RACE_MeshVoteAggregate( y, n, e ); // note: only meaningful on the master
        int left = ( mvDeadline > realTime ) ? int( ( mvDeadline - realTime ) / 1000 ) : 0;
        client.printMessage( "Mesh vote: " + S_COLOR_GREEN + mvMap + S_COLOR_WHITE
                + " (master [" + mvMaster + "])  yes " + y + " / no " + n + " of " + e
                + " players, " + left + "s left\n" );
        return true;
    }

    if ( sub == "cancel" )
    {
        if ( !mvActive )
            return true;
        if ( !mvIsMaster )
        {
            client.printMessage( "Only the server that started the vote can cancel it.\n" );
            return true;
        }
        RS_MirrorEvent( "R", mvVoteId, "FAIL cancelled" );
        RACE_MeshVoteAnnounce( "vote cancelled by " + client.name );
        RACE_MeshVoteReset( MESHVOTE_COOLDOWN );
        return true;
    }

    if ( sub == "sync" )
        return Cmd_MeshVoteSync( client, argsString );

    // Otherwise: sub is a map name -> START a vote (we become master). The shared
    // pre-flight refuses a second concurrent vote, honours the cooldown, and
    // requires an active starter (RACE_MeshVoteOnEvent sets mvActive as soon as a
    // peer's OPEN arrives, so a peer-started vote blocks us here too).
    if ( !RACE_MeshVoteCanStart( client ) )
        return true;
    String rawArg = argsString.getToken( 0 );
    String map;
    // Wildcard / random selection (same semantics as the native randmap
    // callvote): '*' picks any installed map, 'pat*' a random match, and a
    // strafe / weapon filter ("strafe", "rl", ...) a random map that plays that
    // way. The master resolves it to ONE concrete map here, then broadcasts that
    // map, so every server votes on — and switches to — the same one.
    if ( RACE_IsWeaponFilter( rawArg ) || rawArg.locate( "*", 0 ) < rawArg.length() )
    {
        Cvar mapnameVar( "mapname", "", 0 );
        String current = mapnameVar.string; // local String (matches GetMapsByFilter's String@ param)
        String[] maps = GetMapsByFilter( rawArg, current );
        if ( maps.length() == 0 )
        {
            client.printMessage( "No installed map matches '" + rawArg + "'.\n" );
            return true;
        }
        map = maps[ randrange( maps.length() ) ].removeColorTokens().tolower();
        client.printMessage( "Random map: " + S_COLOR_GREEN + map + S_COLOR_WHITE
                + " (of " + maps.length() + " matches)\n" );
    }
    else
    {
        map = rawArg.removeColorTokens().tolower();
        if ( !RACE_MapExists( map ) )
        {
            client.printMessage( "Map '" + map + "' is not installed on this server.\n" );
            return true;
        }
        // Not playable here: a moderator block from the web admin, or a
        // base-game non-race map (both live behind RACE_IsMapBlocked). The
        // wildcard branch above is already filtered via GetMapsByPattern; this
        // guards the explicit single-map case.
        if ( RACE_IsMapBlocked( map ) )
        {
            client.printMessage( RACE_MapBlockedReason( map ) );
            return true;
        }
    }

    RACE_MeshVoteOpen( client, map, "" );
    return true;
}

///*****************************************************************
/// Received mesh events (dispatched from RACE_MirrorDrainEvents)
///  type 4 = O(pen), 5 = T(ally), 6 = R(esult)
///*****************************************************************

void RACE_MeshVoteOnEvent( int type, const String &in tag, const String &in name, const String &in text )
{
    if ( type == 4 ) // OPEN from a peer
    {
        String voteId = name;
        // adopt if we have no vote, or this one wins the tiebreak (smaller id)
        if ( mvActive && voteId == mvVoteId )
            return; // already know it
        if ( mvActive && !RACE_MeshVoteIdLess( voteId, mvVoteId ) )
            return; // keep our (smaller) active vote
        String map = text.getToken( 0 );
        uint durSec = uint( text.getToken( 1 ).toInt() );
        if ( durSec == 0 ) durSec = MESHVOTE_DURATION / 1000;

        mvActive = true;
        mvIsMaster = false;
        mvMaster = tag;
        mvVoteId = voteId;
        mvMap = map;
        mvDeadline = realTime + durSec * 1000;
        for ( int i = 0; i < maxClients; i++ )
            mvBallot[i] = 0;
        mvNextTally = 0;
        String initiator = text.getToken( 2 );
        RACE_MeshVoteAnnounce( "[" + tag + S_COLOR_WHITE + "] " + initiator
                + " wants to change ALL servers to " + S_COLOR_GREEN + mvMap
                + S_COLOR_WHITE + " - /meshvote yes | /meshvote no (" + durSec + "s)" );
        return;
    }

    if ( type == 5 ) // TALLY subtotal from a peer (only the master aggregates)
    {
        if ( !mvActive || !mvIsMaster || name != mvVoteId )
            return;
        int yes = text.getToken( 0 ).toInt();
        int no = text.getToken( 1 ).toInt();
        int elig = text.getToken( 2 ).toInt();
        RACE_MeshVoteStoreTag( tag, yes, no, elig );
        return;
    }

    if ( type == 6 ) // RESULT
    {
        String voteId = name;
        if ( voteId == mvLastResultId )
            return;
        String verdict = text.getToken( 0 );
        if ( verdict == "PASS" )
        {
            // A PASS is accepted from ANY authenticated peer, even one we never
            // saw the open from (packet loss) — this is what makes the switch
            // reach ALL servers. No-op if already on the target map, so a
            // re-broadcast can't loop us. Only set the dedup marker once we act.
            mvLastResultId = voteId;
            RACE_MeshVoteArmSwitch( text.getToken( 1 ) );
        }
        else if ( mvActive && voteId == mvVoteId && tag == mvMaster )
        {
            // A FAIL / cancel is ONLY honored from this vote's own MASTER, so a
            // non-master server can never cancel a mesh vote out from under the
            // rest of the mesh. (The master is the only server that ever
            // broadcasts R, so a legitimate FAIL always satisfies this.)
            mvLastResultId = voteId;
            RACE_MeshVoteAnnounce( "vote failed for " + mvMap );
            RACE_MeshVoteReset( MESHVOTE_COOLDOWN );
        }
        return;
    }
}

void RACE_MeshVoteArmSwitch( const String &in map )
{
    // clear any active vote either way (a result decides it)
    mvActive = false;
    mvCooldownUntil = realTime + MESHVOTE_COOLDOWN;

    if ( map == mirrorLocalMap )
        return; // already on the target — nothing to do (also stops re-loops)
    if ( !RACE_MapExists( map ) )
    {
        RACE_MeshVoteAnnounce( "vote passed for " + map + " but it is not installed here - staying put." );
        return;
    }
    // Blocked by a moderator on THIS server. The open-time guard only runs on the
    // vote's master, and a peer adopts the master's map verbatim — so this
    // terminal switch (the one chokepoint every mesh switch passes through,
    // whether adopted from a peer's OPEN or applied from a PASS result) is where
    // a locally-blocked map must be refused. Diverging from the rest of the mesh
    // is the correct outcome here, same as the not-installed case above.
    if ( RACE_IsMapBlocked( map ) )
    {
        RACE_MeshVoteAnnounce( "vote passed for " + map + " but it is blocked here - staying put." );
        return;
    }
    mvSwitching = true;
    mvSwitchMap = map;
    mvSwitchAt = realTime + MESHVOTE_SWITCH_DELAY;
    RACE_MeshVoteAnnounce( "PASSED - all servers switching to " + S_COLOR_GREEN + map
            + S_COLOR_WHITE + " now!" );
}

// Master: begin broadcasting a result to the whole mesh for a short window and
// apply it locally.
void RACE_MeshVoteBeginResult( const String &in voteId, const String &in resultText )
{
    mvResultActive = true;
    mvResultId = voteId;
    mvResultText = resultText;
    mvResultUntil = realTime + MESHVOTE_SWITCH_DELAY + 200;
    mvNextResult = 0;               // send the first copy immediately
    mvLastResultId = voteId;        // don't re-handle our own result on receipt
    if ( resultText.getToken( 0 ) == "PASS" )
        RACE_MeshVoteArmSwitch( resultText.getToken( 1 ) );
}

///*****************************************************************
/// Per-frame tick (called from RACE_MirrorThink)
///*****************************************************************

void RACE_MeshVoteThink()
{
    // master: re-broadcast the decided result for a short window so EVERY peer
    // (even one that missed the open) reliably gets it and switches.
    if ( mvResultActive )
    {
        if ( realTime >= mvNextResult )
        {
            mvNextResult = realTime + MESHVOTE_RESULT_INTERVAL;
            RS_MirrorEvent( "R", mvResultId, mvResultText );
        }
        if ( realTime >= mvResultUntil )
            mvResultActive = false;
    }

    // execute a pending switch (master and peers alike)
    if ( mvSwitching && realTime >= mvSwitchAt )
    {
        mvSwitching = false;
        G_CmdExecute( "map " + mvSwitchMap + "\n" );
        return;
    }

    if ( !mvActive )
        return;

    // broadcast this server's subtotal periodically (all servers, so the
    // master can aggregate; also keeps the vote "alive" for peers)
    if ( realTime >= mvNextTally )
    {
        mvNextTally = realTime + MESHVOTE_TALLY_INTERVAL;
        int y, n, e;
        RACE_MeshVoteLocalCounts( y, n, e );
        RS_MirrorEvent( "T", mvVoteId, "" + y + " " + n + " " + e );
    }

    if ( mvIsMaster )
    {
        int y, n, e;
        RACE_MeshVoteAggregate( y, n, e );
        bool pass = ( y >= MESHVOTE_MIN_YES ) && ( y * 2 > e );
        if ( pass )
        {
            RACE_MeshVoteBeginResult( mvVoteId, "PASS " + mvMap );
        }
        else if ( realTime >= mvDeadline )
        {
            RACE_MeshVoteAnnounce( "vote failed for " + mvMap + " (yes " + y + " / no " + n + ")" );
            RACE_MeshVoteBeginResult( mvVoteId, "FAIL " + y + " " + n );
            RACE_MeshVoteReset( MESHVOTE_COOLDOWN );
        }
    }
    else
    {
        // non-master: if the master went silent and the deadline is well past,
        // give up so the vote can't wedge (no switch = safe).
        if ( realTime >= mvDeadline + MESHVOTE_EXPIRE_GRACE )
        {
            RACE_MeshVoteAnnounce( "vote for " + mvMap + " expired." );
            RACE_MeshVoteReset( MESHVOTE_COOLDOWN );
        }
    }
}
