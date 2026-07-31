// Per-player personal-best fetch on join, from the central stats API.
//
// The local top-50 board (RACE_LoadTopScores) only ever seeds best_recordTime
// for a player whose time is among the 50 best (seedBestFromBoard, matched by
// clean name). Everyone else joins with an empty best_recordTime: a blank
// scoreboard time, no local "Pos", and — the part that hurts during a run — no
// checkpoint splits loaded, so the live per-checkpoint "Personal:" comparison
// (checkpoint.as) shows nothing until they re-finish this session.
//
// This module closes that gap. On every join (enterGame / userinfochanged /
// spectator->race, wired in hrace.as) it asks the RS_ApiFetchPlayerRecord native
// to GET <rs_api_player_record_url>?map=<map>&name=<cleanName> for THIS player,
// keyed by their player slot so several joiners can be in flight at once. The API
// answers (web/db.js gamePlayerRecordText) with the player's rank + finish time +
// checkpoint splits in the topscores line format behind a header:
//   //playerrec <rank> <total> <sr>
//   "<time>" "<cleanName>" "<numSectors>" "<sector0>" "<sector1>" ...
// The think poller seeds the player's best_recordTime from it (with checkpoints,
// normalized to the live map via the shared RACE_RecordFromTokens), so the
// scoreboard Pos/time works for players ranked past the top-50 board and the
// checkpoint comparison is ready from their first run.
//
// The header's third field is the player's GLOBAL Skill Rating, which the
// scoreboard shows in its own "SR" column (player.as scoreboardEntry). Being
// global it is the one part of the payload that is true regardless of the map or
// the direction being raced, so it is applied to EVERY player a fetch was issued
// for, while the record/rank is applied only to a player this map's standard
// board actually describes. That widens who is worth fetching for:
//   - reversed racers: fetched (SR only) where they used to be skipped entirely
//   - mirror bots: fetched (SR only) from mirror.as as each bot is created, so
//     peer-server players on the scoreboard carry a rating too
// A player with a rating but no record here gets a header-only answer with rank
// 0, so nothing but the SR lands.
//
// Fail-open by design: no-op when rs_api_player_record_url is empty; on a failed
// fetch OR a "nothing known about this player" answer (the native reports -1 for
// both) the player's existing seed is left untouched — nothing is ever cleared
// on failure, and a web still serving the old two-field header simply leaves the
// SR column blank.

Cvar rsApiPlayerRecordUrl( "rs_api_player_record_url", "", 0 );

// Issue the fetch for one player, keyed on their CURRENT clean name (so a rename
// re-fetches what now belongs to them) and on their client slot. No-op when the
// feature is off (empty cvar) or the clean name is empty. Shared by both entry
// points below; WHO is worth fetching for is their decision, not this one's.
void RACE_IssuePlayerRecordFetch( Player@ player )
{
    if ( rsApiPlayerRecordUrl.string.length() == 0 )
        return;
    if ( player is null || player.client is null )
        return;

    String cleanName = player.client.name.removeColorTokens().tolower();
    if ( cleanName.length() == 0 )
        return;

    Cvar mapNameVar( "mapname", "", 0 );
    player.recordFetchName = cleanName;
    player.pendingRecordFetch = true;
    // Public endpoint, no token (like ranks). The native URL-encodes the name.
    RS_ApiFetchPlayerRecord( rsApiPlayerRecordUrl.string, "", mapNameVar.string.tolower(),
        cleanName, player.client.playerNum );
}

// Join hook for a real local player: seeds their record + checkpoints, or (when
// reversed — the payload describes the standard board) just their Skill Rating.
void RACE_TriggerPlayerRecordFetch( Player@ player )
{
    if ( player is null || player.client is null )
        return;
    // Fake clients never enter through this path as themselves: mirror bots come
    // in through RACE_TriggerMirrorBotRecordFetch below, and the WR ghost racer /
    // TV director are infrastructure with no rating to show (the ghost is hidden
    // from the scoreboard entirely). Mirrors the enterGame auto-join and
    // GT_PlayerRespawn mirror-bot guards.
    if ( RACE_MirrorIsFakeClient( player.client ) || RACE_IsTvClient( player.client ) )
        return;

    RACE_IssuePlayerRecordFetch( player );
}

// Mirror bots stand in for players racing on a PEER server: there is no local
// record to seed for them, but they DO occupy a scoreboard row, and Skill Rating
// is global — so fetch it once per bot as mirror.as creates it (racer bots only;
// spectator bots are not on the players team the poller walks). The apply path
// takes only the SR from the answer.
void RACE_TriggerMirrorBotRecordFetch( int botSlot )
{
    if ( botSlot < 0 )
        return;
    Client@ bc = G_GetClient( botSlot );
    if ( @bc == null )
        return;
    RACE_IssuePlayerRecordFetch( RACE_GetPlayer( bc ) );
}

// Nth space-separated field of the "//playerrec <rank> <total> <sr>" header line
// ("//playerrec" itself is field 0), or "" when the header is shorter than that.
// getToken() is no help here: it treats the whole "//" line as a comment and
// skips straight to the data line, which is exactly why the header is read by
// hand. Tolerates runs of spaces and a header with fields we do not know yet.
String RACE_PlayerRecHeaderField( const String &in header, uint index )
{
    uint total = header.length();
    uint pos = 0;
    uint field = 0;
    while ( pos < total )
    {
        while ( pos < total && header.substr( pos, 1 ) == " " )
            pos++;
        if ( pos >= total )
            break;
        // RACE_LocateFrom returns the string length when the token is not
        // found, so the final field of an unterminated line still reads whole.
        uint sp = RACE_LocateFrom( header, " ", pos );
        if ( sp > total )
            sp = total;
        if ( field == index )
            return header.substr( pos, sp - pos );
        pos = sp;
        field++;
    }
    return "";
}

// <rank> from the header, or -1 if the line carries none (a header-only
// no-record marker: the web sends rank 0 when it has only a rating to report).
int RACE_ParsePlayerRecRank( const String &in header )
{
    String field = RACE_PlayerRecHeaderField( header, 1 );
    if ( field.length() == 0 )
        return -1;
    int rank = field.toInt();
    return rank > 0 ? rank : -1;
}

// <sr> from the header, or -1 when absent (an older web serving the two-field
// header) or 0 (the web's "unrated / unknown player" value) — either way the
// scoreboard column stays blank rather than showing a made-up number.
int RACE_ParsePlayerRecSr( const String &in header )
{
    String field = RACE_PlayerRecHeaderField( header, 3 );
    if ( field.length() == 0 )
        return -1;
    int sr = field.toInt();
    return sr > 0 ? sr : -1;
}

// Apply a fetched player-record payload to the player: the header's global Skill
// Rating always, then — for a player this map's standard board really describes —
// best_recordTime (with checkpoints) and, if ranks.as has not already given a
// Pos, the header rank.
void RACE_ApplyPlayerRecord( Player@ player, const String &in text )
{
    if ( player is null || player.client is null )
        return;
    if ( text.length() < 2 || text.substr( 0, 2 ) != "//" )
        return; // not a record payload (the native already gates on "//")

    // Header line, read before anything else: it carries the Skill Rating, which
    // is global and so applies even when the record below does not.
    // NB: assign-then-narrow, NOT a ?: — the older Warsow AngelScript rejects a
    // ternary whose branches are a String value (substr) and a const String&
    // (text) as different types ("Both expressions must have the same type");
    // Warfork's newer AS accepts it. Both branches here are plain String
    // assignments, so this compiles on both engines.
    uint nl = text.locate( "\n", 0 );
    String header = text;
    if ( nl <= text.length() )
        header = text.substr( 0, nl );

    int sr = RACE_ParsePlayerRecSr( header );
    if ( sr > 0 )
        player.skillRating = sr;

    // Everything below describes THIS map's standard board. A reversed racer runs
    // a different board, and a mirror bot is racing on a peer server entirely, so
    // for them the rating above is all that lands (matching how ranks.as refuses
    // to stamp a standard Pos onto a reversed player).
    if ( player.reversed || RACE_MirrorIsFakeClient( player.client ) )
        return;

    // Data line: getToken skips the leading "//playerrec ..." comment line, so
    // token 0 is the finish time, 1 the name, 2 the sector count, 3.. the sectors
    // (identical framing to the topscores loader). No login is ever appended to
    // the time token here (auth servers gone), so no '|' split is needed.
    String timeToken = text.getToken( 0 );
    if ( timeToken.length() == 0 )
        return; // header-only / empty => this player has no record
    String nameToken = text.getToken( 1 );
    String sectorToken = text.getToken( 2 );
    if ( nameToken.length() == 0 || sectorToken.length() == 0 )
        return;

    uint numSectors = uint( sectorToken.toInt() );
    if ( numSectors > 512 )
        return; // corrupt / hostile line

    uint[] sectorTimes( numSectors );
    for ( uint j = 0; j < numSectors; j++ )
    {
        String st = text.getToken( int( 3 + j ) );
        if ( st.length() == 0 )
            break;
        sectorTimes[ j ] = uint( st.toInt() );
    }

    RecordTime record = RACE_RecordFromTokens( timeToken, "", nameToken, numSectors, sectorTimes );

    // Clobber guard (mirrors seedBestFromBoard): adopt the DB record only when the
    // player has no in-session best yet, or the DB copy is strictly faster — never
    // let a stale/slower DB copy overwrite a fresh live PB set this session or a
    // better top-50 board seed.
    if ( !player.best_recordTime.isFinished() || record.getFinishTime() < player.best_recordTime.getFinishTime() )
    {
        player.best_recordTime = record;
        player.bestMaxSpeed = 0; // the DB carries no per-run max speed
        player.updateScore();
        player.updatePos();
    }

    // Seed the scoreboard Pos from the header rank only when the live ranks feed
    // (ranks.as) has not already stamped one — that feed owns Pos, this is just a
    // first-frame fallback so a player past the top-50 board sees a rank at once.
    if ( player.globalRank <= 0 )
    {
        int rank = RACE_ParsePlayerRecRank( header );
        if ( rank > 0 )
            player.globalRank = rank;
    }
}

// Poll for landed per-player fetches and apply them. Called from GT_ThinkRules; a
// no-op when rs_api_player_record_url is unset. Iterates the players team — where
// a seeded record actually matters, and where mirror racer bots sit too, so their
// SR-only answers land here as well; a fetch issued while a player was elsewhere
// is harmlessly re-issued when they next join.
void RACE_ApiPlayerRecordThink()
{
    if ( rsApiPlayerRecordUrl.string.length() == 0 )
        return;

    Team@ team = G_GetTeam( TEAM_PLAYERS );
    for ( int i = 0; @team.ent( i ) != null; i++ )
    {
        Player@ player = RACE_GetPlayer( team.ent( i ).client );
        if ( player is null || player.client is null || !player.pendingRecordFetch )
            continue;

        int playerNum = player.client.playerNum;
        int result = RS_ApiPollPlayerRecord( playerNum );
        if ( result == 1 )
        {
            String text = RS_PlayerRecordText( playerNum );
            RACE_ApplyPlayerRecord( player, text );
            player.pendingRecordFetch = false;
        }
        else if ( result == -1 )
        {
            // No record for this player, or the API was unreachable — either way
            // leave the existing seed untouched (fail-open) and stop polling.
            player.pendingRecordFetch = false;
        }
    }
}
