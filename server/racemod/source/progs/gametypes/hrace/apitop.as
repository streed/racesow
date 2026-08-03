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

const uint API_TOP_REFRESH_MS = 60 * 1000;
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
