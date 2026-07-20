// Live map blocklist from the central admin.
//
// A moderator can block a map in the web admin (map_block table), served at
// GET /api/game/blocked-maps as plain text, one lowercased map name per line.
// At restart server/entrypoint.sh already drops blocked maps from g_maplist,
// but between restarts a freshly blocked map would still be reachable by a
// vote. So the gametype also pulls the list live: every API_BLOCKED_REFRESH_MS
// it asks the RS_ApiFetchBlocked native to GET rs_api_blocked_url, and
// RACE_IsMapBlocked consults the parsed set. Every map-selecting path runs
// through GetMapsByPattern (randmap / meshvote / prerandmap / the /maps
// listing), which filters the blocklist out, so a block takes effect within one
// refresh interval instead of at the next restart. meshvote's explicit
// single-map path checks RACE_IsMapBlocked directly.
//
// Fail-open by design: if rs_api_blocked_url is empty or the API is
// unreachable, RACE_IsMapBlocked returns false and nothing is filtered — a
// network blip must never freeze map voting, and the restart-time filter in
// entrypoint.sh stays the durable backstop. The list is only ever replaced by a
// fresh successful fetch, never cleared by a failure.

Cvar rsApiBlockedUrl( "rs_api_blocked_url", "", 0 );

const uint API_BLOCKED_REFRESH_MS = 30 * 1000;
// 0 = no fetch yet this map, so the first think frame fires one immediately;
// then one per refresh interval (same levelTime idiom as apiTopLastFetch).
uint apiBlockedLastFetch = 0;
String[] raceBlockedMaps; // lowercased, colour-stripped map names currently blocked

// True if <mapName> is on the live blocklist. Case-insensitive; colour tokens
// stripped. Fail-open: an empty / unfetched / unconfigured list yields false.
bool RACE_IsMapBlocked( const String &in mapName )
{
    if ( raceBlockedMaps.length() == 0 )
        return false;
    String key = mapName.removeColorTokens().tolower();
    for ( uint i = 0; i < raceBlockedMaps.length(); i++ )
    {
        if ( raceBlockedMaps[i] == key )
            return true;
    }
    return false;
}

// Rebuild raceBlockedMaps from the fetched payload. getToken() splits on any
// whitespace, so it handles the one-name-per-line format regardless of \n vs
// \r\n line endings and ignores blank lines. A malformed 200 body can't
// over-block: the native already rejects HTML, and any stray token that is not
// an actual map name simply never matches in RACE_IsMapBlocked.
void RACE_ParseBlockedList( const String &in text )
{
    raceBlockedMaps.resize( 0 );
    // getToken() returns "" once the index passes the last token (same idiom as
    // the vote arg parsing). The cap is a defensive backstop against a
    // pathological payload — no server blocks anywhere near this many maps.
    for ( int i = 0; i < 10000; i++ )
    {
        String tok = text.getToken( i );
        if ( tok.length() == 0 )
            break;
        raceBlockedMaps.insertLast( tok.removeColorTokens().tolower() );
    }
}

// Poll for a freshly-fetched list and refresh on the periodic interval. Called
// from GT_ThinkRules; a no-op when rs_api_blocked_url is unset.
void RACE_ApiBlockedThink()
{
    if ( rsApiBlockedUrl.string.length() == 0 )
        return;

    if ( apiBlockedLastFetch == 0 )
    {
        // First think after the gametype script (re)loaded — which happens every
        // map, resetting raceBlockedMaps to empty. The native worker's fetched
        // copy lives in the game module, which persists across that per-map
        // script reload, so seed from it right away: without this there is a
        // window at the start of every map where nothing is blocked while the
        // fresh fetch below round-trips. Empty (never fetched yet) => fail-open.
        String seed = RS_BlockedListText();
        RACE_ParseBlockedList( seed );
    }

    if ( RS_ApiPollBlocked() == 1 )
    {
        String payload = RS_BlockedListText();
        RACE_ParseBlockedList( payload );
    }

    if ( apiBlockedLastFetch == 0 || levelTime - apiBlockedLastFetch >= API_BLOCKED_REFRESH_MS )
    {
        apiBlockedLastFetch = levelTime == 0 ? 1 : levelTime;
        // empty token: the endpoint is public (same as topscores), so the ingest
        // write-credential has no business riding along on this request.
        RS_ApiFetchBlocked( rsApiBlockedUrl.string, "" );
    }
}
