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

void RACE_ApiTopThink()
{
    if ( rsApiTopUrl.string.length() == 0 )
        return;

    int status = RS_ApiPollTop();
    if ( status == 1 )
    {
        // Fresh global top scores are on disk — merge them in through the
        // normal loader (also refreshes the HUD record config strings).
        RACE_LoadTopScores();
    }

    if ( apiTopLastFetch == 0 || levelTime - apiTopLastFetch >= API_TOP_REFRESH_MS )
    {
        apiTopLastFetch = levelTime == 0 ? 1 : levelTime;
        Cvar mapNameVar( "mapname", "", 0 );
        // empty token: the endpoint is public, so the ingest write-credential
        // has no business riding along on this request
        RS_ApiFetchTop( rsApiTopUrl.string, "", mapNameVar.string.tolower() );
    }
}
