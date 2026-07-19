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
const uint ANNOUNCE_VERIFY_TIMEOUT = 6000; // ms to wait for the API before falling back

void RACE_DoRecordAnnounce( const String &in playerName, uint finishTime, bool reversed )
{
    RecordTime[]@ board = RACE_Records( reversed );
    String str = playerName + S_COLOR_YELLOW + " set a new " + SERVER_NAME
            + S_COLOR_YELLOW + " record" + ( reversed ? " (reverse)" : "" ) + ": " + S_COLOR_GREEN + RACE_TimeToString( finishTime );
    if ( board[ 1 ].isFinished() )
        str += " " + S_COLOR_YELLOW + "[-" + RACE_TimeToString( board[ 1 ].getFinishTime() - finishTime ) + "]";
    G_PrintMsg( null, str + "\n" );
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
        // has no business riding along on this request. Refresh both the
        // standard and the reverse-variant boards.
        RS_ApiFetchTop( rsApiTopUrl.string, "", baseMap );
        RS_ApiFetchTop( rsApiTopUrl.string, "", baseMap + REVERSE_SUFFIX );
    }
}
