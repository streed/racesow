// In-game world-record "ghost racer" (replay feature, Phase 3).
//
// On every map that has a stored WR ghost, the server fetches the recorded
// trajectory from the central API (RS_ApiFetchGhost, parsed in g_rs_api.cpp),
// spawns one frozen fake-client through the mesh-bot natives, and drives it
// along the path each frame — looping, with a short pause at the finish — so
// live players can watch and race the record.
//
// The ghost reuses the proven mesh-bot rendering path (RS_MirrorBotAdd /
// Update / Remove) but is driven non-solid (flags bit 2) so real racers pass
// straight through it, and it is excluded from the player count and scoreboard
// (see RACE_RealPlayerCount + the raceGhostBotSlot skip in hrace.as). It never
// enters a race (startRace refuses fake clients) so it is never timed and
// never triggers checkpoints. Toggle with rs_wr_ghost (default on); a distracted
// player can also hide it client-side with cg_raceGhosts 0.

Cvar rsWrGhost( "rs_wr_ghost", "1", 0 );
// GET target for the WR ghost (INGEST_URL/api/game/ghost); set by entrypoint.sh.
Cvar rsWrGhostUrl( "rs_wr_ghost_url", "", 0 );

const uint GHOST_FETCH_RETRY_MS = 30000; // re-ask if the first fetch found none
const uint GHOST_FINISH_PAUSE_MS = 1500; // hold at the finish before looping

int raceGhostBotSlot = -1;
Vec3[] raceGhostOrigin;
Vec3[] raceGhostAngle;
Vec3[] raceGhostVel;
int raceGhostFrameCount = 0;
int raceGhostHz = 25;
uint raceGhostTimeMs = 0;
String raceGhostHolder = "";
bool raceGhostLoaded = false;
bool raceGhostFetched = false;
uint raceGhostNextFetch = 0;

// playback state
uint raceGhostClock = 0;    // ms into the run
uint raceGhostLastReal = 0; // realTime of the last drive tick
uint raceGhostPauseUntil = 0;

bool RACE_WrGhostEnabled()
{
    return rsWrGhost.boolean && rsWrGhostUrl.string.length() > 0;
}

// Real (non-fake-client) players on the team — used for the autorecord toggle
// in hrace.as so neither the WR ghost nor mesh bots keep it recording forever.
int RACE_RealPlayerCount()
{
    int n = 0;
    Team@ team = G_GetTeam( TEAM_PLAYERS );
    for ( int i = 0; @team.ent( i ) != null; i++ )
    {
        if ( !RS_MirrorBotIs( team.ent( i ).client.playerNum ) )
            n++;
    }
    return n;
}

void RACE_GhostInit()
{
    // cvars auto-register; nothing else needed at gametype init.
}

// Map load: drop any stale bot and arm a fresh fetch of this map's WR ghost.
void RACE_GhostSpawnGametype()
{
    RACE_GhostDespawn();
    raceGhostLoaded = false;
    raceGhostFetched = false;
    raceGhostFrameCount = 0;
    raceGhostNextFetch = 0;
}

void RACE_GhostShutdown()
{
    RACE_GhostDespawn();
}

void RACE_GhostDespawn()
{
    if ( raceGhostBotSlot >= 0 )
    {
        // release a spectator chasing the ghost back to free-fly (clearing
        // chaseActive alone freezes them at PM_FREEZE - see RACE_MirrorReleaseChasers)
        RACE_MirrorReleaseChasers( raceGhostBotSlot, "" );
        RS_MirrorBotRemove( raceGhostBotSlot );
        raceGhostBotSlot = -1;
    }
}

// Copy the trajectory parsed by the native (after a poll of 1) into script
// arrays once, so the per-frame driver interpolates from AngelScript memory.
void RACE_GhostLoadFromNative()
{
    int n = RS_GhostLoadedFrames();
    if ( n < 2 )
    {
        raceGhostLoaded = false;
        return;
    }
    raceGhostFrameCount = n;
    raceGhostHz = RS_GhostLoadedHz();
    if ( raceGhostHz <= 0 )
        raceGhostHz = 25;
    raceGhostTimeMs = uint( RS_GhostLoadedTime() );
    raceGhostHolder = RS_GhostLoadedName();

    raceGhostOrigin.resize( n );
    raceGhostAngle.resize( n );
    raceGhostVel.resize( n );
    for ( int i = 0; i < n; i++ )
    {
        String s = RS_GhostFrameAt( i );
        raceGhostOrigin[i] = Vec3( s.getToken( 0 ).toFloat(), s.getToken( 1 ).toFloat(), s.getToken( 2 ).toFloat() );
        raceGhostAngle[i]  = Vec3( s.getToken( 3 ).toFloat(), s.getToken( 4 ).toFloat(), s.getToken( 5 ).toFloat() );
        raceGhostVel[i]    = Vec3( s.getToken( 6 ).toFloat(), s.getToken( 7 ).toFloat(), s.getToken( 8 ).toFloat() );
    }
    raceGhostLoaded = true;
    raceGhostClock = 0;
    raceGhostLastReal = realTime;
    raceGhostPauseUntil = 0;
}

// Per-frame: run the fetch handshake, spawn the bot once a trajectory is in,
// and drive it along the path. Called from GT_ThinkRules (before the postmatch
// early-return so it keeps looping on the scoreboard).
void RACE_GhostThink()
{
    if ( !RACE_WrGhostEnabled() )
    {
        RACE_GhostDespawn();
        return;
    }

    // fetch handshake (mirrors hrace/apitop.as)
    int status = RS_ApiPollGhost();
    if ( status == 1 )
        RACE_GhostLoadFromNative();

    if ( !raceGhostFetched || ( !raceGhostLoaded && realTime >= raceGhostNextFetch ) )
    {
        raceGhostFetched = true;
        raceGhostNextFetch = realTime + GHOST_FETCH_RETRY_MS;
        Cvar mapNameVar( "mapname", "", 0 );
        RS_ApiFetchGhost( rsWrGhostUrl.string, "", mapNameVar.string.tolower() );
    }

    if ( !raceGhostLoaded || raceGhostFrameCount < 2 )
        return;

    // spawn lazily once we have a trajectory
    if ( raceGhostBotSlot < 0 )
    {
        String label = "WR " + raceGhostHolder.removeColorTokens() + " (" + RACE_TimeToString( raceGhostTimeMs ) + ")";
        raceGhostBotSlot = RS_MirrorBotAdd( label, "WR", 255, 210, 63 );
        if ( raceGhostBotSlot < 0 )
            return; // no free client slot right now; retry next frame
        raceGhostClock = 0;
        raceGhostLastReal = realTime;
        raceGhostPauseUntil = 0;
    }

    // advance the playback clock by REAL elapsed time (frame-rate independent)
    uint dt = realTime - raceGhostLastReal;
    raceGhostLastReal = realTime;
    if ( dt > 250 )
        dt = 250; // clamp big hitches

    uint step = uint( 1000 / raceGhostHz );
    uint duration = uint( raceGhostFrameCount - 1 ) * step;

    if ( raceGhostPauseUntil > 0 )
    {
        if ( realTime >= raceGhostPauseUntil )
        {
            raceGhostPauseUntil = 0;
            raceGhostClock = 0;
        }
        // else: hold at the finish frame this tick
    }
    else
    {
        raceGhostClock += dt;
        if ( raceGhostClock >= duration )
        {
            raceGhostClock = duration;
            raceGhostPauseUntil = realTime + GHOST_FINISH_PAUSE_MS;
        }
    }

    // interpolate origin/velocity linearly, angles via LerpAngles
    float fidx = float( raceGhostClock ) * float( raceGhostHz ) / 1000.0f;
    int i0 = int( fidx );
    if ( i0 < 0 )
        i0 = 0;
    if ( i0 > raceGhostFrameCount - 2 )
        i0 = raceGhostFrameCount - 2;
    float frac = fidx - float( i0 );
    if ( frac < 0 )
        frac = 0;
    if ( frac > 1 )
        frac = 1;

    Vec3 pos = raceGhostOrigin[i0] + ( raceGhostOrigin[i0 + 1] - raceGhostOrigin[i0] ) * frac;
    Vec3 vel = raceGhostVel[i0] + ( raceGhostVel[i0 + 1] - raceGhostVel[i0] ) * frac;
    Vec3 ang = LerpAngles( raceGhostAngle[i0], frac, raceGhostAngle[i0 + 1] );

    // flags 3 = bit0 racing hint | bit1 WR ghost (non-solid + force-visible)
    RS_MirrorBotUpdate( raceGhostBotSlot, pos, ang, vel, 3 );
}
