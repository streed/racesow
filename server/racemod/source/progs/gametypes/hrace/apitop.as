// Live top scores from the central stats API.
//
// When rs_api_top_url is set (see server/entrypoint.sh, which derives it
// from INGEST_URL), the gametype periodically asks the RS_ApiFetchTop native
// to GET <rs_api_top_url>?map=<mapname>. The central API answers in the
// EXACT topscores file format (see web/db.js gameTopscoresText) and the
// native swaps the payload atomically into topscores/race/<mapname>.txt.
// When RS_ApiPollTop() reports a fresh file, the records are re-read through
// the SAME loader + merge path used at map start (RACE_LoadTopScores ->
// RACE_AddTopScore) — so `top`, the HUD record lines and "server record"
// announcements all behave exactly as before, but reflect records set on
// EVERY server feeding the API, within one refresh interval.
//
// If the API is down or rs_api_top_url is empty, nothing changes: the local
// topscores file keeps serving as the source, exactly like stock behaviour.
// A record set on THIS server is still written to the local file and
// reported to the API immediately (racelog.as); the next fetch round-trips
// it back, so brief API gaps cannot lose in-memory records (levelRecords is
// only ever merged into, never cleared by a fetch).

Cvar rsApiTopUrl( "rs_api_top_url", "", 0 );

// How often a node re-pulls the central top-50. This is what decides how long a
// record set on ANOTHER node stays invisible here — in `top`, in the HUD record
// lines and in the scoreboard's "Diff" column. It used to be a minute, and twice
// that per board because the base/reverse variants alternated.
//
// 10s is affordable because of what the fetch actually costs. The payload is
// Redis-cached with a TTL several times this interval, so most polls are answered
// without touching Postgres, and the cache is evicted the moment a record lands —
// which is why freshness comes from the eviction, not from the TTL, and why
// polling faster does not mean rebuilding faster. The native then suppresses an
// unchanged payload before the gametype re-parses anything, so a quiet map costs
// nothing beyond the request itself. What it buys is convergence: a record set on
// EU now shows on US within ~10s instead of up to two minutes.
const uint API_TOP_REFRESH_MS = 10 * 1000;
// 0 = no fetch yet this map (scripts reload per map), so the first think
// frame fires one immediately; then one per refresh interval. Same levelTime
// idiom as lastRecordSent in hrace.as.
uint apiTopLastFetch = 0;
// The native coalesces topscores fetches with a single per-type generation
// counter, dropping any but the latest-queued as "superseded". Queuing base AND
// "<map>-reversed" in the same frame therefore races — the reversed fetch (added
// second) supersedes the base one, so the base board would never be written.
// Alternate the two variants across refresh cycles so each is the sole in-flight
// topscores fetch when it completes.
bool apiTopFetchReversed = false;

// ...but only alternate when the reverse board is actually being looked at.
// Unconditional alternation cost the STANDARD board half its refresh rate — one
// fetch every other cycle, so 120 s, not the 60 s the constant above reads like —
// and that board is what `top`, the HUD record lines and the scoreboard's "Diff"
// column are drawn from for practically every player. Reverse is a per-player
// niche: with nobody racing it, RACE_Records( true ) is never read, so spending
// every other cycle on it is pure latency for no reader.
bool RACE_AnyoneReversed()
{
    Team@ team = G_GetTeam( TEAM_PLAYERS );
    for ( int i = 0; @team.ent( i ) != null; i++ )
    {
        Player@ player = RACE_GetPlayer( team.ent( i ).client );
        if ( player !is null && player.reversed )
            return true;
    }
    return false;
}

// --- Verified record announcements ------------------------------------------
// A finish that ranks #1 in the LOCAL top scores is only a genuine server/world
// record if it also beats the CURRENT central records — the local list can be a
// full refresh-interval stale, and is empty at map start before the first
// fetch, so a personal best (or the first finish on a fresh map) would
// false-announce "set a new record". So instead of announcing on the spot,
// completeRace queues the candidate here; we pull the current top scores from
// the API and only announce once the finish is confirmed still the fastest.
bool raceAnnouncePending = false;
uint raceAnnounceTime = 0;
String raceAnnounceName = "";
uint raceAnnounceDeadline = 0;
bool raceAnnounceReversed = false; // which board the pending finish belongs to
// ms to wait for the API before announcing on the local check alone. Two round
// trips through the native's single worker (the finish POST, then this GET) run
// in well under a second, and the timeout is now the NORMAL path rather than the
// exception: /api/ingest evicts the cached topscores board as the finish lands,
// so the verify GET comes back containing the record just set — which can be
// byte-identical to the file the same frame just wrote, and the native suppresses
// an unchanged payload rather than signalling a fresh one. Waiting 6 s to say
// "new record" in that case was the announcement visibly trailing the run. The
// fallback is also safer than it used to be: the board it falls back on is the
// freshly evicted one, not a board up to two minutes old.
const uint ANNOUNCE_VERIFY_TIMEOUT = 3000;

void RACE_DoRecordAnnounce( const String &in playerName, uint finishTime, bool reversed )
{
    RecordTime[]@ board = RACE_Records( reversed );
    String str = playerName + S_COLOR_YELLOW + " set a new " + SERVER_NAME
            + S_COLOR_YELLOW + " record" + ( reversed ? " (reverse)" : "" ) + ": " + S_COLOR_GREEN + RACE_TimeToString( finishTime );
    if ( board[ 1 ].isFinished() )
        str += " " + S_COLOR_YELLOW + "[-" + RACE_TimeToString( board[ 1 ].getFinishTime() - finishTime ) + "]";
    G_PrintMsg( null, str + "\n" );

    // Share the (already API-verified, so never a false positive) record with the
    // rest of the mesh so every server sees it live. Peer-facing only — this
    // server already printed it above.
    RACE_MirrorBroadcastActivity( playerName, "rec", reversed, 1, finishTime, mirrorLocalMap );
}

// Called from completeRace when a finish is a LOCAL #1. Defers the announce
// until a fresh API pull confirms it, unless the API is unconfigured (then we
// can't verify, so fall back to announcing on the local check as before).
void RACE_QueueRecordAnnounce( const String &in playerName, uint finishTime, bool reversed )
{
    if ( rsApiTopUrl.string.length() == 0 )
    {
        RACE_DoRecordAnnounce( playerName, finishTime, reversed );
        return;
    }
    // Two records verified at once is vanishingly rare; flush any prior pending
    // one on its local merit rather than dropping it.
    if ( raceAnnouncePending )
        RACE_DoRecordAnnounce( raceAnnounceName, raceAnnounceTime, raceAnnounceReversed );

    raceAnnouncePending = true;
    raceAnnounceTime = finishTime;
    raceAnnounceName = playerName;
    raceAnnounceReversed = reversed;
    raceAnnounceDeadline = realTime + ANNOUNCE_VERIFY_TIMEOUT;

    // Pull the current records for the matching variant now (don't wait for the
    // periodic interval).
    RS_ApiFetchTop( rsApiTopUrl.string, "", RACE_EffectiveMapName( reversed ) );
    apiTopLastFetch = levelTime == 0 ? 1 : levelTime; // avoid a redundant periodic fetch next frame
}

// Resolve a pending announce. `refreshed` = a fresh API pull just merged into
// levelRecords, so it now reflects every server's records: announce only if the
// finish is still the fastest. On timeout (API unreachable) fall back to the
// local check that already flagged it.
void RACE_CheckPendingAnnounce( bool refreshed )
{
    if ( !raceAnnouncePending )
        return;

    RecordTime[]@ board = RACE_Records( raceAnnounceReversed );
    if ( refreshed )
    {
        if ( !board[ 0 ].isFinished() || raceAnnounceTime <= board[ 0 ].getFinishTime() )
            RACE_DoRecordAnnounce( raceAnnounceName, raceAnnounceTime, raceAnnounceReversed );
        raceAnnouncePending = false;
    }
    else if ( realTime >= raceAnnounceDeadline )
    {
        RACE_DoRecordAnnounce( raceAnnounceName, raceAnnounceTime, raceAnnounceReversed );
        raceAnnouncePending = false;
    }
}

void RACE_ApiTopThink()
{
    if ( rsApiTopUrl.string.length() == 0 )
        return;

    int status = RS_ApiPollTop();
    if ( status == 1 )
    {
        // A fresh top-scores file landed on disk — but the poll flag doesn't say
        // which map (standard or "<map>-reversed"), so reload BOTH boards
        // through the normal loader; the merge is idempotent. The standard
        // reload also refreshes the HUD record config strings.
        RACE_LoadTopScores();
        RACE_LoadTopScores( true );
        RACE_CheckPendingAnnounce( true ); // verify any pending record against them
    }
    else
    {
        RACE_CheckPendingAnnounce( false ); // handle the verify timeout
    }

    if ( apiTopLastFetch == 0 || levelTime - apiTopLastFetch >= API_TOP_REFRESH_MS )
    {
        apiTopLastFetch = levelTime == 0 ? 1 : levelTime;
        Cvar mapNameVar( "mapname", "", 0 );
        String baseMap = mapNameVar.string.tolower();
        // empty token: the endpoint is public, so the ingest write-credential
        // has no business riding along on this request. Alternate the standard
        // and reverse-variant boards across cycles (see apiTopFetchReversed) so
        // neither supersedes the other in the native's per-type fetch coalescing;
        // the first fetch on a fresh map is the base board. With nobody racing
        // reversed the alternation is skipped entirely, so the standard board
        // refreshes every cycle instead of every other one.
        if ( apiTopFetchReversed && RACE_AnyoneReversed() )
        {
            RS_ApiFetchTop( rsApiTopUrl.string, "", baseMap + REVERSE_SUFFIX );
            apiTopFetchReversed = false;
        }
        else
        {
            RS_ApiFetchTop( rsApiTopUrl.string, "", baseMap );
            apiTopFetchReversed = true;
        }
    }
}

///*****************************************************************
/// "/top <map>" against the central board
///*****************************************************************
//
// The map-wide fetch above keeps THIS map's board current. This half answers
// "/top <othermap>" and "/prerandmap", where the local topscores file is the
// wrong place to look: it holds only what this box has seen, and for a map it
// has not hosted lately there is usually no file at all — so the command
// answered "No records found" for maps with a full leaderboard on the website.
// The central DB has every server's finishes, so that is what gets asked.
//
// Its own native (RS_ApiFetchMapTop), not RS_ApiFetchTop with a different
// argument: that one writes the level's topscores file and shares the single
// fetch generation that gates the pending record announce, so an arbitrary
// map's payload landing there could satisfy an announcement about the map
// everyone is actually racing. This one is per-player and stays in memory.

// How long a player waits before the request is written off. The native retries
// a transient failure up to MAX_ATTEMPTS with a 2s pause between, so this has to
// outlast that; past it the player is told, and may ask again.
const uint MAPTOP_TIMEOUT_MS = 12000;
// Minimum gap between one player's "/top <map>" requests. The endpoint is cached
// server-side and this is a cheap read, so this is about not letting one player
// turn a chat-speed command into a request flood, not about protecting the DB.
const uint MAPTOP_COOLDOWN_MS = 2000;

// Ask the central API for <mapName>'s board on <client>'s behalf.
//
// Returns true when the request has been taken and the player will be answered
// by RACE_ApiMapTopThink; false when this server cannot serve it from the API
// at all, which is the caller's cue to fall back to the local file. Note the
// asymmetry: a player-facing REFUSAL (already waiting, on cooldown) also returns
// true, because the player has been told what is happening and must not then get
// a second, stale answer off the disk.
bool RACE_ApiMapTopRequest( Client@ client, const String &in mapName )
{
    if ( rsApiTopUrl.string.length() == 0 )
        return false; // no central API on this server: the local file is all there is
    if ( @client == null )
        return false;

    Player@ player = RACE_GetPlayer( client );
    if ( player is null )
        return false;

    if ( player.pendingMapTopFetch )
    {
        client.printMessage( S_COLOR_YELLOW + "Still looking up " + S_COLOR_WHITE
                + player.mapTopName + S_COLOR_YELLOW + " - hold on.\n" );
        return true;
    }
    if ( player.mapTopNext != 0 && levelTime < player.mapTopNext )
    {
        client.printMessage( S_COLOR_YELLOW + "Hold on a moment before looking up another map.\n" );
        return true;
    }

    player.pendingMapTopFetch = true;
    player.mapTopName = mapName.tolower();
    // levelTime can be 0 on the very first frame, so 1 is the "armed" sentinel
    // (0 means "no deadline"), the same idiom as tourneyJoinDeadline.
    player.mapTopDeadline = levelTime + MAPTOP_TIMEOUT_MS;
    if ( player.mapTopDeadline == 0 )
        player.mapTopDeadline = 1;
    player.mapTopNext = levelTime + MAPTOP_COOLDOWN_MS;
    if ( player.mapTopNext == 0 )
        player.mapTopNext = 1;

    // empty token: /api/game/topscores is public (same as the map-wide fetch
    // above), so the ingest write-credential has no business riding along.
    raceMapTopPending++;
    RS_ApiFetchMapTop( rsApiTopUrl.string, "", player.mapTopName, client.playerNum );
    client.printMessage( S_COLOR_WHITE + "Looking up " + S_COLOR_YELLOW + player.mapTopName
            + S_COLOR_WHITE + "...\n" );
    return true;
}

// How many players are waiting on a board right now. A HINT, not a tally to be
// kept exactly right: the think below recomputes it from the players it finds
// each pass, so a slot whose flag was cleared behind its back — a disconnect, or
// Player.clear() on a rejoin — cannot leave it stuck high. All it has to be is
// zero when nobody is waiting, which is almost always, and that is what makes
// the per-frame cost of this feature a single integer compare.
int raceMapTopPending = 0;

// Poll for landed "/top <map>" boards and print them. Called from GT_ThinkRules;
// a no-op when nobody is waiting or the feature is off.
//
// Walks every client slot rather than a team, because a SPECTATOR may type
// "/top <map>" just as readily as a racer — unlike the join-time fetches, which
// only concern people who are playing.
void RACE_ApiMapTopThink()
{
    if ( raceMapTopPending <= 0 )
        return;
    if ( rsApiTopUrl.string.length() == 0 )
        return;

    int stillPending = 0;
    for ( int i = 0; i < maxClients; i++ )
    {
        Client@ client = G_GetClient( i );
        if ( @client == null || client.state() < CS_SPAWNED )
            continue;
        Player@ player = RACE_GetPlayer( client );
        if ( player is null || !player.pendingMapTopFetch )
            continue;

        int result = RS_ApiPollMapTop( i );
        if ( result == 1 )
        {
            player.pendingMapTopFetch = false;
            // An empty body is the API's "this map has no records", which
            // RACE_RenderMapTop already words correctly for an empty array.
            RecordTime[] central = RACE_ParseTopScores( RS_MapTopText( i ) );
            RACE_RenderMapTop( client, player.mapTopName, @central );
            continue;
        }
        if ( result == -1 )
        {
            player.pendingMapTopFetch = false;
            // Failed for good — most often a 404, i.e. the central DB has never
            // seen a finish on this map. Fall back to whatever this server has
            // cached locally rather than answering with nothing: on a box that
            // has hosted the map, that file is a real (if partial) board.
            RecordTime[] local = RACE_ReadTopScoresFile( player.mapTopName );
            if ( local.length() > 0 && local[ 0 ].isFinished() )
            {
                client.printMessage( S_COLOR_YELLOW
                        + "(central records unavailable - showing this server's own)\n" );
            }
            RACE_RenderMapTop( client, player.mapTopName, @local );
            continue;
        }

        // Still in flight. The deadline is the backstop for a request nothing
        // ever answers (evicted from a full queue, dropped at shutdown, or
        // no-opped by the native): without it the player could never ask again.
        if ( player.mapTopDeadline != 0 && levelTime >= player.mapTopDeadline )
        {
            player.pendingMapTopFetch = false;
            client.printMessage( S_COLOR_RED + "Timed out looking up "
                    + player.mapTopName + " - try again.\n" );
            continue;
        }
        stillPending++;
    }
    raceMapTopPending = stillPending;
}
