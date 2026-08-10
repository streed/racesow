// In-game "Achievement unlocked" announcements from the central award log.
//
// Achievements are EVALUATED web-side (after ingests + a daily sweep, see
// web/achievements.js), so a server learns about fresh awards by polling: each
// real player slot asks the central /api/game/awards endpoint for rows above
// the high-water award row id it has already accounted for. The join-time
// fetch is a SEED (the ?seed=1 variant, requested with after < 0): it answers
// with just the newest row so the mark is set without replaying the player's
// award history as popups. A map change resets the per-slot state and
// re-seeds, so an award landing exactly during a map switch is skipped
// in-game — it still shows on the site profile; this feed is best-effort
// flair, not the record. Worst-case popup lag is roughly the poll interval
// plus the web's post-ingest evaluation debounce.
//
// Payload contract (web/db.js gameAwardsText): "//awards" header line, then
// one "<rowId>\t<tier>\t<title>\t<description>" line per award, oldest first,
// capped server-side (a larger burst pages itself out over successive polls
// because the mark advances to the last row received). Line-walked with
// RACE_LocateFrom — getToken would split multi-word titles.
//
// Fail-open: empty cvar = feature off; a failed fetch or seed just retries on
// the next interval (still as a seed if the mark was never set, so history
// can't spam even after web downtime at join).
//
// Players who don't want the flair silence it per-client with the client cvar
// cg_raceShowAchievements (RACE_AwardsWantedBy). That is purely a DISPLAY
// filter: the poll, the high-water mark and the mesh broadcast run regardless,
// so toggling it back on shows what happens NEXT rather than replaying a
// backlog, and an opted-out player's own unlocks still reach everybody else.

Cvar rsApiAwardsUrl( "rs_api_awards_url", "", 0 );

const uint AWARDS_POLL_INTERVAL = 75000; // ms between per-slot polls
const int AWARDS_ANNOUNCE_MAX = 5;       // popups per poll; the rest summarised

String RACE_AwardTierColor( const String &in tier )
{
    if ( tier == "legend" )
        return S_COLOR_MAGENTA;
    if ( tier == "gold" )
        return S_COLOR_YELLOW;
    if ( tier == "silver" )
        return S_COLOR_WHITE;
    return S_COLOR_ORANGE; // bronze
}

// Does this client want to see achievement announcements? cg_raceShowAchievements
// is a CVAR_ARCHIVE|CVAR_USERINFO client cvar (registered by the racemod UI pak
// as a checkbox in Race Options, or set by hand with `setau`), so the server just
// reads it out of userinfo - no command and no server-side preference to store,
// and a live toggle takes effect on the next line with no reconnect.
// Opt-OUT, unlike the WR ghost's opt-in cg_raceShowWorldRecord: only an explicit
// "0" silences the feed, so an unset cvar - every client without the pak - keeps
// the announcements it has today.
bool RACE_AwardsWantedBy( Client@ client )
{
    if ( @client == null )
        return false;
    return client.getUserInfoKey( "cg_raceShowAchievements" ) != "0";
}

// Print an achievement feed line to every client that hasn't opted out. Stands
// in for G_PrintMsg( null, ... ), whose broadcast form can't skip a client, so
// honouring a per-viewer choice means addressing each client individually.
// Mirror bots are skipped: they have no userinfo of their own (so they'd read as
// opted in) and no console to render it. The TV client deliberately is NOT
// skipped - it holds no cvar either, and the stream keeps showing the feed.
void RACE_AwardsBroadcast( const String &in line )
{
    // A null-target G_PrintMsg also mirrors to the server console (so unlocks
    // show up in `docker logs` / the admin log console); per-client prints do
    // not, so mirror it by hand or the feed vanishes from the logs.
    G_Print( line );

    for ( int i = 0; i < maxClients; i++ )
    {
        Client@ client = G_GetClient( i );
        if ( @client == null || client.state() < CS_SPAWNED )
            continue;
        if ( RACE_MirrorIsFakeClient( client ) )
            continue;
        if ( !RACE_AwardsWantedBy( client ) )
            continue;
        client.printMessage( line );
    }
}

// Kick off a per-slot awards fetch. `after` >= 0 polls for rows above that
// mark; `after` < 0 asks the seed variant (newest row only, nothing announced).
void RACE_TriggerAwardsFetch( Player@ player, int after )
{
    if ( rsApiAwardsUrl.string.length() == 0 )
        return;
    if ( player is null || player.client is null )
        return;
    if ( RACE_MirrorIsFakeClient( player.client ) || RACE_IsTvClient( player.client ) )
        return;

    String cleanName = player.client.name.removeColorTokens().tolower();
    if ( cleanName.length() == 0 )
        return;

    player.pendingAwardsFetch = true;
    // Public endpoint, no token (like ranks / player-record / saved-start).
    // The native URL-encodes the name (it can carry spaces / punctuation).
    RS_ApiFetchAwards( rsApiAwardsUrl.string, "", cleanName, after, player.client.playerNum );
}

// Announce one fresh award to the earner, the local server and the mesh. Only
// the earner's own popup + line answer to their cg_raceShowAchievements; the
// server-wide line is filtered per RECIPIENT and the mesh flair always goes
// out, so opting out mutes your console, not your unlocks.
void RACE_AnnounceAward( Player@ player, const String &in tier, const String &in title, const String &in desc )
{
    Client@ client = player.client;
    String color = RACE_AwardTierColor( tier );

    if ( RACE_AwardsWantedBy( client ) )
    {
        client.addAward( color + "Achievement unlocked: " + title );
        // Assign-then-append: no String ?: — Warsow's older AS rejects a ternary
        // mixing a concat VALUE with a literal (see savedstarts deploy gotcha).
        String descNote = "";
        if ( desc.length() > 0 )
            descNote = " - " + desc;
        client.printMessage( color + "Achievement unlocked: " + S_COLOR_WHITE + title
            + descNote + S_COLOR_WHITE + " (" + color + tier + S_COLOR_WHITE + ")\n" );
    }
    RACE_AwardsBroadcast( S_COLOR_ORANGE + ">> " + S_COLOR_WHITE + client.name + " " + color
        + "unlocked " + S_COLOR_WHITE + "[" + color + title + S_COLOR_WHITE + "]\n" );
    // Cross-server flair on the mesh activity feed (mirror.as kind "ach"): the
    // trailing free-text field carries "<tier> <title...>" — tier first because
    // the renderer token-walks and the title is the only multi-word part.
    RACE_MirrorBroadcastActivity( client.name, "ach", false, 0, 0, tier + " " + title );
}

// Parse an "//awards" payload for this slot: advance the high-water mark over
// every row received, and pop announcements only for a mark-holding (seeded)
// player — the seed pass itself must stay silent.
void RACE_ParseAwards( Player@ player, const String &in text )
{
    bool announce = player.awardsSeeded;
    int shown = 0;
    int extra = 0;

    uint total = text.length();
    uint pos = 0;
    while ( pos < total )
    {
        // RACE_LocateFrom returns the string length when "\n" isn't found, so
        // the final unterminated line still gets read (same idiom as ranks.as).
        uint nl = RACE_LocateFrom( text, "\n", pos );
        if ( nl > total )
            nl = total;
        String line = text.substr( pos, nl - pos );
        pos = nl + 1;
        if ( line.length() == 0 || line.substr( 0, 2 ) == "//" )
            continue;

        uint t1 = RACE_LocateFrom( line, "\t", 0 );
        if ( t1 >= line.length() )
            continue; // malformed line - skip
        uint t2 = RACE_LocateFrom( line, "\t", t1 + 1 );
        if ( t2 >= line.length() )
            continue;
        uint t3 = RACE_LocateFrom( line, "\t", t2 + 1 );

        int rowId = line.substr( 0, t1 ).toInt();
        String tier = line.substr( t1 + 1, t2 - t1 - 1 );
        // Assign-then-narrow instead of String ?: (Warsow-AS strictness).
        String title = line.substr( t2 + 1 );
        String desc = "";
        if ( t3 < line.length() )
        {
            title = line.substr( t2 + 1, t3 - t2 - 1 );
            desc = line.substr( t3 + 1 );
        }

        if ( rowId <= 0 || title.length() == 0 )
            continue;
        if ( rowId > player.awardsHighWater )
            player.awardsHighWater = rowId;

        if ( !announce )
            continue;
        if ( shown < AWARDS_ANNOUNCE_MAX )
        {
            RACE_AnnounceAward( player, tier, title, desc );
            shown++;
        }
        else
        {
            extra++;
        }
    }

    if ( extra > 0 && RACE_AwardsWantedBy( player.client ) )
        player.client.printMessage( S_COLOR_YELLOW + "...and " + extra
            + " more achievements - see your profile on racesow.org\n" );

    player.awardsSeeded = true;
}

// Poll for landed per-slot fetches and pace the periodic re-poll. Called from
// GT_ThinkRules; a no-op when the feature is off. Iterates racing players like
// RACE_ApiSavedStartThink; a fresh Player (nextAwardsPoll 0, not seeded)
// self-seeds on its first pass, so no explicit enterGame hook is needed — but
// the poll only runs for TEAM_PLAYERS, so a pure spectator stays silent.
void RACE_ApiAwardsThink()
{
    if ( rsApiAwardsUrl.string.length() == 0 )
        return;

    Team@ team = G_GetTeam( TEAM_PLAYERS );
    for ( int i = 0; @team.ent( i ) != null; i++ )
    {
        Player@ player = RACE_GetPlayer( team.ent( i ).client );
        if ( player is null || player.client is null )
            continue;
        if ( RACE_MirrorIsFakeClient( player.client ) || RACE_IsTvClient( player.client ) )
            continue;

        if ( player.pendingAwardsFetch )
        {
            int result = RS_ApiPollAwards( player.client.playerNum );
            if ( result != 0 )
            {
                if ( result == 1 )
                    RACE_ParseAwards( player, RS_AwardsText( player.client.playerNum ) );
                // -1: failed for good - stay unseeded/marked as-is and retry
                // on the next interval (a seed retry still can't spam).
                player.pendingAwardsFetch = false;
                player.nextAwardsPoll = realTime + AWARDS_POLL_INTERVAL;
            }
            continue;
        }

        if ( realTime >= player.nextAwardsPoll )
        {
            RACE_TriggerAwardsFetch( player, player.awardsSeeded ? player.awardsHighWater : -1 );
            // Push the next slot even if the trigger no-opped (renaming to an
            // empty clean name etc.) so this never busy-loops.
            player.nextAwardsPoll = realTime + AWARDS_POLL_INTERVAL;
        }
    }
}
