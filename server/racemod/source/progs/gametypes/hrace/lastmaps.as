// In-game /lastmaps: the maps most recently played across the network.
//
// The web records every completed run in the finish log; GET /api/game/last-maps
// serves the last 10 DISTINCT maps anyone finished, most-recent first, as plain
// text (one lowercased map name per line). The gametype polls it every
// API_LASTMAPS_REFRESH_MS via the RS_ApiFetchLastMaps native and caches the
// parsed names, so /lastmaps answers instantly from memory rather than blocking
// the frame on a request. The list moves slowly and a minute of staleness is
// fine for "recently played", so the refresh is lazy.
//
// No-op when rs_api_lastmaps_url is empty (the command then tells the player the
// feature is unavailable). Same fetch/poll/text shape as blockedmaps.as /
// mapweapons.as.

Cvar rsApiLastMapsUrl( "rs_api_lastmaps_url", "", 0 );

const uint API_LASTMAPS_REFRESH_MS = 60 * 1000;
// 0 = no fetch yet this map, so the first think frame fires one immediately;
// then one per refresh interval (same levelTime idiom as apiBlockedLastFetch).
uint apiLastMapsLastFetch = 0;
String[] raceLastMaps; // lowercased map names, most-recently-played first
String raceLastMapsParsedText = ""; // last payload parsed (skip an identical re-parse)

// Rebuild raceLastMaps from the fetched payload. Order is preserved (the
// endpoint already emits most-recent first). getToken() splits on any
// whitespace, so it handles \n vs \r\n and ignores blank lines; the cap is a
// defensive backstop (the endpoint only ever serves 10). A malformed 200 body
// can't misbehave here: the native rejects HTML, and this list is display-only.
void RACE_ParseLastMaps( const String &in text )
{
    raceLastMaps.resize( 0 );
    for ( int i = 0; i < 64; i++ )
    {
        String tok = text.getToken( i );
        if ( tok.length() == 0 )
            break;
        raceLastMaps.insertLast( tok.removeColorTokens().tolower() );
    }
}

// Poll for a freshly-fetched list and refresh on the periodic interval. Called
// from GT_ThinkRules; a no-op when rs_api_lastmaps_url is unset.
void RACE_ApiLastMapsThink()
{
    if ( rsApiLastMapsUrl.string.length() == 0 )
        return;

    if ( apiLastMapsLastFetch == 0 )
    {
        // First think after the per-map script reload (which resets the array):
        // seed from the game module's persisted copy so /lastmaps works right
        // away, before the fresh fetch below round-trips. Empty (never fetched)
        // => the array stays empty and the command reports "not ready yet".
        String seed = RS_LastMapsText();
        if ( seed != raceLastMapsParsedText )
        {
            raceLastMapsParsedText = seed;
            RACE_ParseLastMaps( seed );
        }
    }

    if ( RS_ApiPollLastMaps() == 1 )
    {
        String payload = RS_LastMapsText();
        raceLastMapsParsedText = payload;
        RACE_ParseLastMaps( payload );
    }

    if ( apiLastMapsLastFetch == 0 || levelTime - apiLastMapsLastFetch >= API_LASTMAPS_REFRESH_MS )
    {
        apiLastMapsLastFetch = levelTime == 0 ? 1 : levelTime;
        // empty token: the endpoint is public (same as blocked-maps/map-weapons).
        RS_ApiFetchLastMaps( rsApiLastMapsUrl.string, "" );
    }
}

// /lastmaps - show the player the maps most recently played across the network.
bool Cmd_LastMaps( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( rsApiLastMapsUrl.string.length() == 0 )
    {
        client.printMessage( S_COLOR_RED + "Recently-played maps are not available on this server.\n" );
        return false;
    }

    if ( raceLastMaps.length() == 0 )
    {
        client.printMessage( S_COLOR_YELLOW + "The recently-played map list isn't ready yet - try again in a moment.\n" );
        return true;
    }

    client.printMessage( S_COLOR_WHITE + "Last " + raceLastMaps.length() + " maps played:\n" );
    Table table( "r l" );
    for ( uint i = 0; i < raceLastMaps.length(); i++ )
    {
        // Lead with "" so this is a string + uint concat (string on the left,
        // the form used elsewhere, e.g. Cmd_Maplist) rather than uint + string.
        table.addCell( "" + ( i + 1 ) + "." );
        table.addCell( S_COLOR_YELLOW + raceLastMaps[i] );
    }
    uint rows = table.numRows();
    for ( uint i = 0; i < rows; i++ )
        client.printMessage( table.getRow( i ) + "\n" );
    return true;
}
