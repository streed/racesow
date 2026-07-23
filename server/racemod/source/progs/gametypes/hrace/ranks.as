// Live per-map GLOBAL ranks from the central stats API.
//
// The local top-50 board (levelRecords, MAX_RECORDS) can only give a scoreboard
// "Pos" to a player whose time is among the 50 best. Every other finisher shows
// a blank Pos. To restore a true rank for EVERYONE, the gametype pulls the map's
// full rank list from the central database: every API_RANKS_REFRESH_MS it asks
// the RS_ApiFetchRanks native to GET <rs_api_ranks_url>?map=<mapname>. The API
// answers (web/db.js gameRanksText) with a header line then one line per
// finisher:
//   //ranks <total_finishers>
//   <rank> <raw display name>
// The blob is parsed into g_rankCleanNames / g_rankValues (each raw name cleaned
// ONCE with the same removeColorTokens().tolower() the scoreboard uses), and the
// scoreboard reads a player's globalRank from it (player.as scoreboardEntry).
//
// Only the STANDARD board is fetched: reverse mode is a per-player niche, so a
// reversed player keeps their local top-50 board position (globalRank stays -1).
//
// Fail-open by design: if rs_api_ranks_url is empty or the API is unreachable,
// nothing changes — the scoreboard falls back to the local top-50 position
// (updatePos). The list is only ever replaced by a fresh successful fetch, never
// cleared by a failure.

Cvar rsApiRanksUrl( "rs_api_ranks_url", "", 0 );

const uint API_RANKS_REFRESH_MS = 60 * 1000;
// 0 = no fetch yet this map, so the first think frame fires one immediately;
// then one per refresh interval (same levelTime idiom as apiBlockedLastFetch).
uint apiRanksLastFetch = 0;

// Parsed ranks blob: parallel arrays (cleaned name -> rank), rebuilt whenever a
// changed payload lands. raceTotalFinishers is the "N" a scoreboard could show
// as the denominator (currently unused by the display, kept for completeness).
String[] g_rankCleanNames;
int[] g_rankValues;
uint raceTotalFinishers = 0;

// Global rank of a colour-stripped, lowercased name, or -1 if not on the board
// (no finish on this map, or the player is racing under a different nick than
// the record was set under — same match posture as the local top-50 board).
int RACE_LookupGlobalRank( const String &in cleanName )
{
    for ( uint i = 0; i < g_rankCleanNames.length(); i++ )
    {
        if ( g_rankCleanNames[i] == cleanName )
            return g_rankValues[i];
    }
    return -1;
}

// Rebuild the parallel arrays from the fetched payload. Line-based (NOT
// getToken): a player name may contain spaces, so each data line is split only
// on its FIRST space — "<rank> <name>" — leaving the rest as the (raw) name. A
// malformed 200 body can't corrupt anything: the native already rejects non-"//"
// bodies, and any stray line that isn't "<int> <name>" is skipped here.
void RACE_ParseRanks( const String &in text )
{
    g_rankCleanNames.resize( 0 );
    g_rankValues.resize( 0 );
    raceTotalFinishers = 0;

    uint total = text.length();
    uint pos = 0;
    while ( pos < total )
    {
        // locate() returns the string length when the token is not found (same
        // idiom as the topscores parser), so the final unterminated line still
        // gets read.
        uint nl = text.locate( "\n", pos );
        if ( nl > total )
            nl = total;
        String line = text.substr( pos, nl - pos );
        pos = nl + 1;

        uint llen = line.length();
        if ( llen == 0 )
            continue;

        // Header "//ranks <total>": read the finisher count, skip the line.
        if ( llen >= 2 && line.substr( 0, 2 ) == "//" )
        {
            uint hsp = line.locate( " ", 0 );
            if ( hsp < llen )
                raceTotalFinishers = uint( line.substr( hsp + 1 ).toInt() );
            continue;
        }

        // Data "<rank> <raw name>": split on the first space only.
        uint sp = line.locate( " ", 0 );
        if ( sp == 0 || sp >= llen )
            continue;
        int rank = line.substr( 0, sp ).toInt();
        if ( rank <= 0 )
            continue;
        String clean = line.substr( sp + 1 ).removeColorTokens().tolower();
        if ( clean.length() == 0 )
            continue;
        g_rankCleanNames.insertLast( clean );
        g_rankValues.insertLast( rank );
    }
}

// Stamp one player's globalRank from the loaded board. Reversed players keep the
// local top-50 position (the standard board's rank would be wrong for them), so
// their globalRank is cleared.
void RACE_ApplyGlobalRankTo( Player@ player )
{
    if ( player is null || player.client is null )
        return;
    if ( player.reversed )
    {
        player.globalRank = -1;
        return;
    }
    player.globalRank = RACE_LookupGlobalRank( player.client.name.removeColorTokens().tolower() );
}

// Re-stamp every in-game player (called when a fresh board lands).
void RACE_ApplyGlobalRanks()
{
    Team@ team = G_GetTeam( TEAM_PLAYERS );
    for ( int i = 0; @team.ent( i ) != null; i++ )
        RACE_ApplyGlobalRankTo( RACE_GetPlayer( team.ent( i ).client ) );
}

// Poll for a freshly-fetched board and refresh on the periodic interval. Called
// from GT_ThinkRules; a no-op when rs_api_ranks_url is unset.
void RACE_ApiRanksThink()
{
    if ( rsApiRanksUrl.string.length() == 0 )
        return;

    if ( apiRanksLastFetch == 0 )
    {
        // First think after the per-map script reload (which resets the arrays
        // to empty). The native worker's fetched copy lives in the game module,
        // which persists across that reload, so seed from it right away — without
        // this there is a window at the start of every map where every Pos is
        // blank while the fresh fetch below round-trips. Empty => fail-open.
        String seed = RS_RanksText();
        RACE_ParseRanks( seed );
        RACE_ApplyGlobalRanks();
    }

    if ( RS_ApiPollRanks() == 1 )
    {
        String payload = RS_RanksText();
        RACE_ParseRanks( payload );
        RACE_ApplyGlobalRanks();
    }

    if ( apiRanksLastFetch == 0 || levelTime - apiRanksLastFetch >= API_RANKS_REFRESH_MS )
    {
        apiRanksLastFetch = levelTime == 0 ? 1 : levelTime;
        Cvar mapNameVar( "mapname", "", 0 );
        // Standard board only (see file header); public endpoint, no token.
        RS_ApiFetchRanks( rsApiRanksUrl.string, "", mapNameVar.string.tolower() );
    }
}
