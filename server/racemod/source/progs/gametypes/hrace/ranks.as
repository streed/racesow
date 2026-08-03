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

// --- Post-finish refresh ------------------------------------------------------
// A finish reorders the whole map's board: the finisher's own rank improves and
// everyone they passed drops one. Waiting out API_RANKS_REFRESH_MS for that meant
// the scoreboard showed a just-improved player their OLD rank for up to a minute —
// the "Pos" column visibly trailing the run it had already announced. So a finish
// asks for an off-schedule pull instead, and stamps what it can read locally in the
// same frame.
//
// levelTime at which a requested pull is due; 0 = nothing pending. Trailing
// debounce (a second finish pushes it back so the pull covers that one too),
// bounded by apiRanksRefetchFirst + POST_FINISH_REFETCH_MAX_MS so a busy map can
// never starve it.
//
// The delay is short because it is NOT waiting for the finish to reach the
// database — the transport already guarantees that ordering. RACE_LogFinish
// queues the report at the top of completeRace(), this pull is queued at the
// bottom of the same frame, and the native drains one FIFO deque on a single
// worker (g_rs_api.cpp): the GET cannot be dequeued until the POST has finished,
// and the ingest handler evicts the cached ranks blob before it answers that POST.
// So the answer to this pull is computed from a database that already has the run.
// The few hundred ms is only a coalescing window, so a pack of players crossing
// the line together costs one fetch instead of one each.
uint apiRanksRefetchAt = 0;
uint apiRanksRefetchFirst = 0;
const uint POST_FINISH_REFETCH_MS = 300;
const uint POST_FINISH_REFETCH_MAX_MS = 2000;

// Whether a landed blob may be applied over a locally stamped rank.
//
// The native coalesces by generation: a response whose gen is not the newest is
// dropped as superseded (g_rs_api.cpp), so whatever RS_ApiPollRanks reports is
// always the answer to the LAST fetch we issued. That makes the test exact rather
// than a guess about timing — every blob from before the post-finish fetch went out
// predates the finish and must not overwrite the stamp, and the first one after it
// is guaranteed to postdate it. Set false when a finish stamps, true again the
// instant the post-finish fetch is issued.
bool apiRanksTrusted = true;
// Belt-and-braces bound in case that fetch never lands (API down, map ending): a
// stamp is never held longer than this, after which the central DB is
// authoritative again and a rank that legitimately dropped settles.
const uint FINISH_RANK_HOLD_MS = 15 * 1000;

// Ask for an off-schedule ranks pull. Called once per finish; see the coalescing
// note on POST_FINISH_REFETCH_MS above for why the small delay is not a race
// guard.
void RACE_RequestRanksRefresh()
{
    if ( rsApiRanksUrl.string.length() == 0 )
        return;

    uint now = levelTime == 0 ? 1 : levelTime;
    if ( apiRanksRefetchAt == 0 )
        apiRanksRefetchFirst = now;

    uint due = now + POST_FINISH_REFETCH_MS;
    uint cap = apiRanksRefetchFirst + POST_FINISH_REFETCH_MAX_MS;
    apiRanksRefetchAt = due > cap ? cap : due;
}

// Called from completeRace() once the local board has been updated. Gives the
// FINISHER a correct "Pos" with no round trip at all: the local top-50 board is not
// a local artefact, it IS the network-wide top 50 (the API serves it in topscores
// format and apitop.as merges it in), so their position on it is their global rank.
//
// Only the finisher is stamped, deliberately. Their rank provably improved (or held)
// — that is what finishing means — so reading it off the board can only move the
// column in the direction the run justifies. Nobody else's rank is safe to infer
// this way: a bystander's rank changes only by being passed, at most by one, and a
// local board that happened to be behind the central one would stamp them a number
// the run does not justify. They are corrected by the pull requested above instead,
// seconds later, which is invisible for a one-place shift.
//
// Reversed players are skipped: ranks.as only ever loads the STANDARD board, so a
// reverse run says nothing about the rank this column shows (same posture as
// RACE_ApplyGlobalRankTo).
void RACE_StampFinishRank( Player@ player )
{
    RACE_RequestRanksRefresh();

    if ( player is null || player.client is null || player.reversed )
        return;
    if ( player.pos <= 0 )
        return; // not on the top-50 board - only the API knows this rank

    // Refuse to stamp from a board that is missing people. On a map this node has
    // never hosted there is no persisted topscores file, so levelRecords is empty
    // until the first apitop fetch lands and updatePos() will happily call a
    // mediocre time "1". The ranks blob header carries the real finisher count, so
    // compare against it: a board holding fewer than it should is behind the
    // central one and its indices mean nothing globally.
    //
    // Skipping is free rather than a compromise — with no blob parsed there is no
    // globalRank either, and scoreboardEntry() already falls back to the very same
    // this.pos. The stamp only ever CHANGES what is displayed in the case this
    // check confirms, which is the case worth having.
    if ( raceTotalFinishers == 0 )
        return;

    uint expected = raceTotalFinishers < uint( MAX_RECORDS ) ? raceTotalFinishers : uint( MAX_RECORDS );
    RecordTime[]@ board = RACE_Records( false );
    uint loaded = 0;
    for ( uint i = 0; i < MAX_RECORDS; i++ )
    {
        if ( !board[ i ].isFinished() )
            break;
        loaded++;
    }
    if ( loaded < expected )
        return;

    player.globalRank = player.pos;
    player.rankStampedAt = levelTime == 0 ? 1 : levelTime;
    apiRanksTrusted = false;
}

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
        // RACE_LocateFrom returns the string length when the token is not
        // found (same idiom as the topscores parser), so the final unterminated
        // line still gets read.
        uint nl = RACE_LocateFrom( text, "\n", pos );
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

    // Hold a freshly stamped rank until a blob we know postdates the finish lands
    // (apiRanksTrusted). Without this, a blob already in flight when the player
    // finished describes the board BEFORE their run, and applying it would bounce
    // the Pos column straight back to the old number for another refresh cycle —
    // the very flicker this module's post-finish pull exists to remove.
    if ( player.rankStampedAt != 0 )
    {
        if ( !apiRanksTrusted && levelTime - player.rankStampedAt < FINISH_RANK_HOLD_MS )
            return;
        player.rankStampedAt = 0;
    }

    player.globalRank = RACE_LookupGlobalRank( player.client.name.removeColorTokens().tolower() );
}

// Drop a player's post-finish stamp so the next lookup is authoritative again.
// Called when their identity changes under them (a rename): the stamped rank was
// read off the board for the OLD nick, so holding it against the new one would
// show a rank that is not theirs.
void RACE_ClearFinishRankStamp( Player@ player )
{
    if ( player !is null )
        player.rankStampedAt = 0;
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

    // A finish asked for an off-schedule pull and its grace delay has elapsed.
    bool refetchDue = apiRanksRefetchAt != 0 && levelTime >= apiRanksRefetchAt;
    if ( refetchDue )
    {
        apiRanksRefetchAt = 0;
        apiRanksRefetchFirst = 0;
        // From here on, whatever the native hands back answers THIS fetch (older
        // ones are dropped as superseded), so it postdates the finish that asked
        // for it and may overwrite the stamped ranks.
        apiRanksTrusted = true;
    }

    if ( refetchDue || apiRanksLastFetch == 0 || levelTime - apiRanksLastFetch >= API_RANKS_REFRESH_MS )
    {
        // Restarting the periodic clock here is deliberate: a post-finish pull is
        // as good as the interval one, so a busy map does not fetch twice in a
        // row. The native supersedes an in-flight fetch of the same type, so an
        // overlapping request is coalesced rather than doubled.
        apiRanksLastFetch = levelTime == 0 ? 1 : levelTime;
        Cvar mapNameVar( "mapname", "", 0 );
        // Standard board only (see file header); public endpoint, no token.
        RS_ApiFetchRanks( rsApiRanksUrl.string, "", mapNameVar.string.tolower() );
    }
}
