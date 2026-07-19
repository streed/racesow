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
// never triggers checkpoints.
//
// Visibility. rs_wr_ghost (default on) toggles the ghost SERVER-WIDE. An
// individual player can hide it for THEMSELVES with the "wrghost off" command
// (Cmd_WrGhost below): the server marks the viewer's edict and culls the ghost
// from just their snapshot (SNAP_SnapCullEntity, via RS_SetHideWrGhost) without
// touching mesh ghosts, other players' views, or the scoreboard. The stock
// client also offers cg_raceGhostsAlpha (set it to 0 to hide ALL race ghosts,
// mesh ones included) - note cg_raceGhosts does NOT affect the player-model
// ghost, it only shells projectiles, so "cg_raceGhosts 0" does not hide it.

Cvar rsWrGhost( "rs_wr_ghost", "1", 0 );
// GET target for the WR ghost (INGEST_URL/api/game/ghost); set by entrypoint.sh.
Cvar rsWrGhostUrl( "rs_wr_ghost_url", "", 0 );
// When on a mesh, re-pull the canonical WR ghost the moment a peer advertises a
// faster finish time for our map, so every meshed server races the same current
// WR ghost instead of a stale map-load snapshot. Default on; harmless (a no-op)
// when not meshed. See RACE_GhostThink's mesh trigger.
Cvar rsWrGhostMeshSync( "rs_wr_ghost_mesh_sync", "1", 0 );
// Per-frame easing factor for ghost playback (0..1). Higher = snappier, lower =
// smoother/laggier; matches the mesh mirror-bot low-pass (MIRROR_SMOOTH). 0
// disables easing (raw interpolation, for A/B comparison).
Cvar rsWrGhostSmooth( "rs_wr_ghost_smooth", "0.35", 0 );

const uint GHOST_FETCH_RETRY_MS = 30000; // re-ask if the first fetch found none
const uint GHOST_FINISH_PAUSE_MS = 1500; // hold at the finish before looping
// While a ghost is loaded, periodically re-pull the canonical WR so records set
// elsewhere (website, a non-meshed feeder, a peer we can't hear) still converge
// within a bounded time even without a mesh signal. Cheap: the endpoint is
// cache-fronted and we only swap when the returned ghost is actually faster.
const uint GHOST_REPOLL_MS = 60000;
// Cooldown between mesh-triggered re-fetches, so N servers hearing the same new
// WR don't hammer the endpoint (a per-server jitter is added on top).
const uint GHOST_REFETCH_COOLDOWN_MS = 5000;
// How many times to re-fetch for a given peer best before giving up on it. A
// few spaced tries ride out the web store's short response cache (a just-set WR
// may be a few seconds stale) without looping forever on a fast time that never
// produced an uploadable ghost. Budget resets when a strictly-faster peer best
// appears. GHOST_MESH_CHASE_TRIES * (cooldown+jitter) should exceed the
// /api/game/ghost cache TTL.
const int GHOST_MESH_CHASE_TRIES = 4;
// Distance beyond which we snap the eased pose instead of smoothing toward it
// (the finish->start loop teleport, or a corrupt frame). Matches mirror.as.
const float GHOST_SNAP_DISTANCE = 512.0f;

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

// propagation state
uint raceGhostNextRepoll = 0;          // next unconditional canonical re-pull
uint raceGhostRefetchCooldownUntil = 0; // earliest next mesh-triggered re-fetch
int raceGhostChasedMeshBest = 0;       // fastest peer time we're chasing (ms), 0 = none
int raceGhostChaseTriesLeft = 0;       // remaining re-fetch attempts for it

// playback state
uint raceGhostClock = 0;    // ms into the run
uint raceGhostLastReal = 0; // realTime of the last drive tick
uint raceGhostPauseUntil = 0;

// per-frame eased render pose (the low-pass that removes snapshot-beat jitter,
// most visible when a spectator chases the ghost in-eyes)
Vec3 raceGhostRenderPos;
Vec3 raceGhostRenderAng;
bool raceGhostHasRender = false;

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

// Per-client "wrghost off" preference. An AngelScript global, so it persists
// across map changes (the script module outlives level reloads); the matching
// engine-side edict flag is zeroed on every reload, so RACE_GhostApplyPref
// re-asserts this on (re)spawn. Default false = the player sees the WR ghost.
bool[] raceGhostHiddenFor( maxClients );

void RACE_GhostInit()
{
    // cvars auto-register. Register the per-player visibility toggle.
    G_RegisterCommand( "wrghost" );
    for ( int i = 0; i < maxClients; i++ )
        raceGhostHiddenFor[i] = false;
}

// Re-assert this client's saved WR-ghost preference on the engine. Called on
// every (re)spawn from GT_PlayerRespawn, because a level reload zeroes the
// per-edict flag - without this a player's "wrghost off" would silently reset
// each map. Cheap (a single native call); skips out-of-range slots.
void RACE_GhostApplyPref( int playerNum )
{
    if ( playerNum < 0 || playerNum >= maxClients )
        return;
    RS_SetHideWrGhost( playerNum, raceGhostHiddenFor[playerNum] );
}

// Reset a slot to the default (visible) on a genuine connect, so a new player
// never inherits the previous occupant's choice. Called from GT_scoreEvent.
void RACE_GhostResetPref( int playerNum )
{
    if ( playerNum < 0 || playerNum >= maxClients )
        return;
    raceGhostHiddenFor[playerNum] = false;
    RS_SetHideWrGhost( playerNum, false );
}

// wrghost [on|off|toggle] - per-player toggle for the in-game WR ghost racer.
// Hides/shows ONLY the WR ghost for the caller (server-side per-client cull),
// leaving mesh ghosts and everyone else's view untouched. No argument toggles.
bool Cmd_WrGhost( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( @client == null )
        return false;

    int slot = client.playerNum;
    if ( slot < 0 || slot >= maxClients )
        return false;

    bool hide;
    String arg = argsString.getToken( 0 ).tolower();
    if ( arg == "" || arg == "toggle" )
        hide = !raceGhostHiddenFor[slot];
    else if ( arg == "off" || arg == "0" || arg == "hide" )
        hide = true;
    else if ( arg == "on" || arg == "1" || arg == "show" )
        hide = false;
    else
    {
        client.printMessage( "Usage: " + S_COLOR_YELLOW + "wrghost [on|off]" + S_COLOR_WHITE
                + " - show or hide the world-record ghost racer (just for you).\n" );
        return true;
    }

    raceGhostHiddenFor[slot] = hide;
    RS_SetHideWrGhost( slot, hide );

    if ( hide )
        client.printMessage( S_COLOR_YELLOW + "World-record ghost hidden" + S_COLOR_WHITE
                + " for you - use " + S_COLOR_GREEN + "wrghost on" + S_COLOR_WHITE + " to bring it back.\n" );
    else
        client.printMessage( S_COLOR_GREEN + "World-record ghost shown" + S_COLOR_WHITE
                + " for you - use " + S_COLOR_GREEN + "wrghost off" + S_COLOR_WHITE + " to hide it.\n" );
    return true;
}

// Map load: drop any stale bot and arm a fresh fetch of this map's WR ghost.
void RACE_GhostSpawnGametype()
{
    RACE_GhostDespawn();
    raceGhostLoaded = false;
    raceGhostFetched = false;
    raceGhostFrameCount = 0;
    raceGhostTimeMs = 0;
    raceGhostNextFetch = 0;
    raceGhostNextRepoll = 0;
    raceGhostRefetchCooldownUntil = 0;
    raceGhostChasedMeshBest = 0;
    raceGhostChaseTriesLeft = 0;
    raceGhostHasRender = false;
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
// arrays, so the per-frame driver interpolates from AngelScript memory. Returns
// true only when a STRICTLY FASTER ghost than the one already loaded was
// adopted — so every re-fetch (periodic re-poll or mesh trigger) is idempotent:
// a fetch that resolves to the same or an ingest-lagged older canonical ghost
// is ignored and the current bot keeps running undisturbed.
bool RACE_GhostLoadFromNative()
{
    int n = RS_GhostLoadedFrames();
    if ( n < 2 )
        return false; // nothing usable in this result; keep any current ghost

    uint newTime = uint( RS_GhostLoadedTime() );
    if ( raceGhostLoaded && raceGhostFrameCount >= 2 && newTime >= raceGhostTimeMs )
        return false; // not an improvement over what we're already playing

    raceGhostFrameCount = n;
    raceGhostHz = RS_GhostLoadedHz();
    if ( raceGhostHz <= 0 )
        raceGhostHz = 25;
    raceGhostTimeMs = newTime;
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
    raceGhostHasRender = false;              // reseed the eased pose for the new path
    raceGhostNextRepoll = realTime + GHOST_REPOLL_MS;

    // A live bot still carries the OLD holder/time in its scoreboard label (set
    // at spawn), so drop it; RACE_GhostThink re-spawns it with the new WR's
    // label on the next tick. No-op on the first load (no bot yet).
    if ( raceGhostBotSlot >= 0 )
        RACE_GhostDespawn();

    return true;
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

    // --- Keep the loaded ghost current as the mesh-wide WR improves ----------
    // The canonical WR ghost lives in the web store (MIN(time) across every
    // server); we just decide WHEN to re-pull it. A re-fetch that isn't actually
    // faster is dropped by RACE_GhostLoadFromNative, so both paths are safe to
    // fire liberally.
    if ( raceGhostLoaded )
    {
        Cvar mapNameVar( "mapname", "", 0 );
        String map = mapNameVar.string.tolower();

        // (1) Mesh signal: a peer on OUR map is advertising a finish faster than
        //     the ghost we're playing -> pull the new canonical WR immediately,
        //     so meshed servers converge on the same ghost in ~seconds instead
        //     of at the next map load. Cooldown + jitter avoid a thundering herd;
        //     the chased-time guard fires at most once per distinct peer best
        //     (so a fast time that never produced an uploadable ghost can't loop).
        if ( rsWrGhostMeshSync.boolean && RACE_MirrorEnabled()
                && realTime >= raceGhostRefetchCooldownUntil )
        {
            int meshBest = RACE_MeshBestFinishForLocalMap();
            if ( meshBest > 0 && uint( meshBest ) < raceGhostTimeMs )
            {
                // A strictly-faster peer best than the one we were chasing
                // (re)opens a small retry budget; the same or a slower one just
                // spends the remaining tries. Adopting the faster ghost drops
                // raceGhostTimeMs to/under meshBest, so the outer test then
                // fails and we stop — no loop on a time that has no ghost.
                if ( raceGhostChasedMeshBest == 0 || meshBest < raceGhostChasedMeshBest )
                {
                    raceGhostChasedMeshBest = meshBest;
                    raceGhostChaseTriesLeft = GHOST_MESH_CHASE_TRIES;
                }
                if ( raceGhostChaseTriesLeft > 0 )
                {
                    raceGhostChaseTriesLeft--;
                    raceGhostRefetchCooldownUntil = realTime + GHOST_REFETCH_COOLDOWN_MS + randrange( 2000 );
                    RS_ApiFetchGhost( rsWrGhostUrl.string, "", map );
                }
            }
        }

        // (2) Periodic backstop (mesh-independent): catches WRs set on the
        //     website or by a feeder we don't mesh with, within GHOST_REPOLL_MS.
        if ( realTime >= raceGhostNextRepoll )
        {
            raceGhostNextRepoll = realTime + GHOST_REPOLL_MS;
            RS_ApiFetchGhost( rsWrGhostUrl.string, "", map );
        }
    }

    if ( !raceGhostLoaded || raceGhostFrameCount < 2 )
        return;

    // spawn lazily once we have a trajectory
    if ( raceGhostBotSlot < 0 )
    {
        String label = "WR " + raceGhostHolder.removeColorTokens() + " (" + RACE_TimeToString( raceGhostTimeMs ) + ")";
        raceGhostBotSlot = RS_MirrorBotAdd( label, "WR", 255, 210, 63, false ); // racer-kind bot
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
            raceGhostHasRender = false; // snap to the start; don't smear back across the map
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

    // Sample the trajectory at the current clock: i0 is the keyframe at/just
    // before now, frac the fraction toward i0+1.
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

    // Position: velocity-aware cubic Hermite (uses the recorded per-frame
    // velocity at each end as a tangent) so tight strafe arcs are followed
    // rather than chorded. Fall back to the straight Lerp if the spline would
    // bulge implausibly far past the segment (a glitch/discontinuity frame),
    // so it can never overshoot into geometry.
    Vec3 linPos = Lerp( raceGhostOrigin[i0], frac, raceGhostOrigin[i0 + 1] );
    Vec3 pos = HermitePos( raceGhostOrigin[i0], raceGhostVel[i0],
            raceGhostOrigin[i0 + 1], raceGhostVel[i0 + 1], frac, float( step ) / 1000.0f );
    Vec3 dev = pos - linPos;
    if ( dev * dev > GHOST_SNAP_DISTANCE * GHOST_SNAP_DISTANCE )
        pos = linPos;

    Vec3 vel = Lerp( raceGhostVel[i0], frac, raceGhostVel[i0 + 1] );
    Vec3 ang = LerpAngles( raceGhostAngle[i0], frac, raceGhostAngle[i0 + 1] );

    // Ease the PUSHED pose toward the sampled target each frame — a low-pass
    // that absorbs the beat between the ~62Hz game-frame clock and the client's
    // 40Hz (sv_pps) snapshot sampling. Without it the raw sub-frame value latched
    // at snapshot time jitters, worst of all when a spectator chases the ghost
    // in-eyes. This mirrors the (already-smooth) mesh mirror-bot path. Snap
    // instead of smearing on a large jump (loop teleport / correction).
    // rs_wr_ghost_smooth 0 disables easing (raw), for A/B comparison.
    float smooth = rsWrGhostSmooth.string.toFloat();
    if ( smooth <= 0 || !raceGhostHasRender )
    {
        raceGhostRenderPos = pos;
        raceGhostRenderAng = ang;
        raceGhostHasRender = true;
    }
    else
    {
        if ( smooth > 1 )
            smooth = 1;
        Vec3 d = pos - raceGhostRenderPos;
        if ( d * d > GHOST_SNAP_DISTANCE * GHOST_SNAP_DISTANCE )
        {
            raceGhostRenderPos = pos;
            raceGhostRenderAng = ang;
        }
        else
        {
            raceGhostRenderPos = Lerp( raceGhostRenderPos, smooth, pos );
            raceGhostRenderAng = LerpAngles( raceGhostRenderAng, smooth, ang );
        }
    }

    // flags 3 = bit0 racing hint | bit1 WR ghost (non-solid + force-visible)
    RS_MirrorBotUpdate( raceGhostBotSlot, raceGhostRenderPos, raceGhostRenderAng, vel, 3 );
}
