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
//   //playerrec <rank> <total>
//   "<time>" "<cleanName>" "<numSectors>" "<sector0>" "<sector1>" ...
// The think poller seeds the player's best_recordTime from it (with checkpoints,
// normalized to the live map via the shared RACE_RecordFromTokens), so the
// scoreboard Pos/time works for players ranked past the top-50 board and the
// checkpoint comparison is ready from their first run.
//
// Fail-open by design: no-op when rs_api_player_record_url is empty; on a failed
// fetch OR a "no record here" answer (the native reports -1 for both) the
// player's existing seed is left untouched — nothing is ever cleared on failure.
// Standard board only (like ranks.as): a reversed player keeps their local
// reverse best, so no fetch is issued for them.

Cvar rsApiPlayerRecordUrl( "rs_api_player_record_url", "", 0 );

// Issue a per-player PB fetch for the given player on the current map. No-op when
// the feature is off (empty cvar), for a reversed player (standard board only),
// or for an empty clean name. Re-keys on the CURRENT clean name so a rename
// re-fetches the record that now belongs to the player.
void RACE_TriggerPlayerRecordFetch( Player@ player )
{
    if ( rsApiPlayerRecordUrl.string.length() == 0 )
        return;
    if ( player is null || player.client is null )
        return;
    if ( player.reversed )
        return;
    // Mirror bots (peer-server players) and the TV director are not real local
    // racers — never fetch a record for them (mirrors the enterGame auto-join
    // and GT_PlayerRespawn mirror-bot guards).
    if ( RACE_MirrorIsFakeClient( player.client ) || RACE_IsTvClient( player.client ) )
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

// Parse the "//playerrec <rank> <total>" header line and return <rank>, or -1 if
// the line carries no rank (a header-only no-record marker, defensive only).
int RACE_ParsePlayerRecRank( const String &in header )
{
    uint sp = header.locate( " ", 0 );
    if ( sp >= header.length() )
        return -1;
    int rank = header.substr( sp + 1 ).toInt();
    return rank > 0 ? rank : -1;
}

// Apply a fetched player-record payload to the player: seed best_recordTime (with
// checkpoints) and, if ranks.as has not already given a Pos, the header rank.
void RACE_ApplyPlayerRecord( Player@ player, const String &in text )
{
    if ( player is null || player.client is null )
        return;
    if ( text.length() < 2 || text.substr( 0, 2 ) != "//" )
        return; // not a record payload (the native already gates on "//")

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
        uint nl = text.locate( "\n", 0 );
        // NB: assign-then-narrow, NOT a ?: — the older Warsow AngelScript rejects
        // a ternary whose branches are a String value (substr) and a const String&
        // (text) as different types ("Both expressions must have the same type");
        // Warfork's newer AS accepts it. Both branches here are plain String
        // assignments, so this compiles on both engines.
        String header = text;
        if ( nl <= text.length() )
            header = text.substr( 0, nl );
        int rank = RACE_ParsePlayerRecRank( header );
        if ( rank > 0 )
            player.globalRank = rank;
    }
}

// Poll for landed per-player fetches and apply them. Called from GT_ThinkRules; a
// no-op when rs_api_player_record_url is unset. Iterates racing players (where a
// seeded record actually matters); a fetch issued while a player was elsewhere is
// harmlessly re-issued when they next join.
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
