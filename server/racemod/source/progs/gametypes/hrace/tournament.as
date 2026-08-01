// In-game tournaments.
//
// A tournament is defined and scored entirely web-side (see web/tournaments.js):
// it is a time window plus a map pool, and a registered entrant's finishes on
// those maps inside that window count for the tournament board as well as the
// normal leaderboard. Nothing about how a finish is reported changes — the game
// does not tag runs, and this module never touches the race path.
//
// What the game DOES need is three things, and this file is all three:
//
//   1. Knowing what is on. The gametype polls GET /api/game/tournament every
//      API_TOURNEY_REFRESH_MS through the RS_ApiFetchTourney native and caches
//      the parsed result, so "/tournament" and "/tmaps" answer instantly from
//      memory instead of blocking the frame. Same shared fetch/poll/text shape
//      as blockedmaps.as / lastmaps.as, deduped native-side so an unchanged
//      payload is not re-parsed every interval.
//
//   2. Registering a player. "/tournament <code>" redeems the entry code the
//      website minted; "/tournament join" enrols the nick they are playing
//      under with no website round trip. Both go out as ONE per-slot POST
//      (RS_ApiTourneyJoin) whose REPLY is read back and printed — unlike every
//      other POST in this mod, the answer is the point, because the player has
//      to be told whether it worked. One in flight per slot; never retried (a
//      reply landing minutes later would print to whoever holds the slot then),
//      so a failure simply asks them to try again.
//
//   3. Getting everyone onto the right map. "callvote tourneymap [name]" picks
//      from the pool and reuses the proven randmap change path (set
//      randmap_passed, launch POSTMATCH — see commands.as).
//
// Fail-open throughout: empty rs_api_tourney_url = the feature is off and every
// command says so; a failed fetch just retries next interval.
//
// Payload contract (web/tournaments.js gameTourneyText):
//   RSTOURNEY
//   T<TAB><id><TAB><slug><TAB><startsAt><TAB><endsAt><TAB><name>
//   M<TAB><mapname>
//   ...
// At most one T line — the tournament running NOW, or the next one due if none
// is — followed by its pool. A bare header is the real "nothing scheduled"
// state. Line-walked with RACE_LocateFrom because getToken would split the
// multi-word name; tabs delimit so a name with spaces survives intact.

Cvar rsApiTourneyUrl( "rs_api_tourney_url", "", 0 );
Cvar rsApiTourneyJoinUrl( "rs_api_tourney_join_url", "", 0 );

const uint API_TOURNEY_REFRESH_MS = 60 * 1000;
// How long a sign-up may stay in flight before the player is told to retry. The
// native's own request timeout is 10s + up to 5s to connect, so 20s means a
// timeout here is always a request that genuinely went missing (evicted from a
// full queue, dropped at shutdown, or no-opped) rather than one still travelling.
const uint TOURNEY_JOIN_TIMEOUT_MS = 20000;
// Most pool maps printed in one go. Every row is a separate reliable command,
// and a 64-map pool would be 64 of them in a single frame — well past what
// anything else in this mod emits at once (Cmd_Maplist pages at 30). The tail
// is summarised instead; the full pool is always on the website.
const uint TOURNEY_MAPS_SHOWN = 30;

// 0 = no fetch yet this map, so the first think frame fires one immediately;
// then one per refresh interval (same levelTime idiom as apiLastMapsLastFetch).
uint apiTourneyLastFetch = 0;
String raceTourneyParsedText = ""; // last payload parsed (skip an identical re-parse)

bool raceTourneyKnown = false;     // a T line was present in the last payload
String raceTourneyName = "";
String raceTourneySlug = "";
int raceTourneyStartsAt = 0;       // epoch seconds
int raceTourneyEndsAt = 0;
String[] raceTourneyMaps;          // lowercased pool map names, pool order

// Note there is deliberately no "is it live?" flag here. AngelScript has no
// wall clock, so the game cannot compare the window against now — and it does
// not need to: the web sends the tournament that is RUNNING when one is, and
// the next one otherwise. Everything below therefore states the window as
// absolute dates rather than a countdown that a stale cache could get wrong.

// Format an epoch-seconds timestamp as "YYYY-MM-DD HH:MM UTC" without any date
// library: AngelScript here has no time formatting, so this is plain integer
// arithmetic over the proleptic Gregorian calendar. Only used for display.
String RACE_TourneyFmtTime( int epoch )
{
    if ( epoch <= 0 )
        return "?";
    int days = epoch / 86400;
    int rem = epoch % 86400;
    int hour = rem / 3600;
    int minute = ( rem % 3600 ) / 60;

    // Days since 1970-01-01 -> civil date (Howard Hinnant's civil_from_days,
    // shifted to a 0000-03-01 era so leap handling needs no branching).
    int z = days + 719468;
    int era = ( z >= 0 ? z : z - 146096 ) / 146097;
    int doe = z - era * 146097;                                   // [0, 146096]
    int yoe = ( doe - doe / 1460 + doe / 36524 - doe / 146096 ) / 365; // [0, 399]
    int y = yoe + era * 400;
    int doy = doe - ( 365 * yoe + yoe / 4 - yoe / 100 );           // [0, 365]
    int mp = ( 5 * doy + 2 ) / 153;                                // [0, 11]
    int d = doy - ( 153 * mp + 2 ) / 5 + 1;                        // [1, 31]
    int m = mp + ( mp < 10 ? 3 : -9 );                             // [1, 12]
    if ( m <= 2 )
        y++;

    // Assign-then-pad rather than a ternary producing a concat VALUE (Warsow's
    // older AngelScript rejects that mix — see the savedstarts/awards notes).
    String mm = "" + m;
    if ( m < 10 )
        mm = "0" + m;
    String dd = "" + d;
    if ( d < 10 )
        dd = "0" + d;
    String hh = "" + hour;
    if ( hour < 10 )
        hh = "0" + hour;
    String mi = "" + minute;
    if ( minute < 10 )
        mi = "0" + minute;
    return "" + y + "-" + mm + "-" + dd + " " + hh + ":" + mi + " UTC";
}

// Rebuild the cached tournament from a fetched payload. Tolerant by design: a
// malformed line is skipped rather than failing the whole parse, because this
// only drives display and a vote pool — the scoring is web-side and cannot be
// affected by anything decided here.
void RACE_ParseTourney( const String &in text )
{
    raceTourneyKnown = false;
    raceTourneyName = "";
    raceTourneySlug = "";
    raceTourneyStartsAt = 0;
    raceTourneyEndsAt = 0;
    raceTourneyMaps.resize( 0 );

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
        if ( line.length() < 2 )
            continue;

        String kind = line.substr( 0, 1 );
        if ( kind == "M" )
        {
            String name = line.substr( 2 );
            if ( name.length() > 0 )
                raceTourneyMaps.insertLast( name.removeColorTokens().tolower() );
            continue;
        }
        if ( kind != "T" )
            continue; // header line, or something a newer web version added

        // T \t id \t slug \t startsAt \t endsAt \t name
        uint t1 = RACE_LocateFrom( line, "\t", 0 );
        if ( t1 >= line.length() )
            continue;
        uint t2 = RACE_LocateFrom( line, "\t", t1 + 1 );
        if ( t2 >= line.length() )
            continue;
        uint t3 = RACE_LocateFrom( line, "\t", t2 + 1 );
        if ( t3 >= line.length() )
            continue;
        uint t4 = RACE_LocateFrom( line, "\t", t3 + 1 );
        if ( t4 >= line.length() )
            continue;
        uint t5 = RACE_LocateFrom( line, "\t", t4 + 1 );
        if ( t5 >= line.length() )
            continue;

        raceTourneySlug = line.substr( t2 + 1, t3 - t2 - 1 );
        raceTourneyStartsAt = line.substr( t3 + 1, t4 - t3 - 1 ).toInt();
        raceTourneyEndsAt = line.substr( t4 + 1, t5 - t4 - 1 ).toInt();
        raceTourneyName = line.substr( t5 + 1 );
        if ( raceTourneyName.length() == 0 )
            raceTourneyName = raceTourneySlug;
        raceTourneyKnown = true;
    }

}

// Poll for a freshly-fetched payload and pace the periodic refresh. Called from
// GT_ThinkRules; a no-op when rs_api_tourney_url is unset.
void RACE_ApiTourneyThink()
{
    if ( rsApiTourneyUrl.string.length() == 0 )
        return;

    if ( apiTourneyLastFetch == 0 )
    {
        // First think after the per-map script reload (which resets the globals
        // above): seed from the game module's persisted copy so /tournament
        // works right away, before the fresh fetch below round-trips. Empty
        // (never fetched) => nothing cached and the command says "not ready".
        String seed = RS_TourneyText();
        if ( seed != raceTourneyParsedText )
        {
            raceTourneyParsedText = seed;
            RACE_ParseTourney( seed );
        }
    }

    if ( RS_ApiPollTourney() == 1 )
    {
        String payload = RS_TourneyText();
        raceTourneyParsedText = payload;
        RACE_ParseTourney( payload );
    }

    if ( apiTourneyLastFetch == 0 || levelTime - apiTourneyLastFetch >= API_TOURNEY_REFRESH_MS )
    {
        apiTourneyLastFetch = levelTime == 0 ? 1 : levelTime;
        // empty token: the feed is public (same as blocked-maps / last-maps).
        RS_ApiFetchTourney( rsApiTourneyUrl.string, "" );
    }
}

// Is `mapName` (already lowercased, colour-free) in the current pool?
bool RACE_TourneyHasMap( const String &in mapName )
{
    for ( uint i = 0; i < raceTourneyMaps.length(); i++ )
    {
        if ( raceTourneyMaps[i] == mapName )
            return true;
    }
    return false;
}

// True when the server is sitting on a map that scores for the tournament.
bool RACE_TourneyOnPoolMap()
{
    if ( !raceTourneyKnown )
        return false;
    Cvar mapnameCvar( "mapname", "", 0 );
    return RACE_TourneyHasMap( mapnameCvar.string.removeColorTokens().tolower() );
}

// Poll for landed per-slot join replies and print them. Called from
// GT_ThinkRules alongside the other per-slot polls; a no-op when the feature is
// off or nobody has a request in flight. Walks every client slot (not just
// TEAM_PLAYERS) so a spectator who registers still gets their answer.
void RACE_ApiTourneyJoinThink()
{
    if ( rsApiTourneyJoinUrl.string.length() == 0 )
        return;

    for ( int i = 0; i < maxClients; i++ )
    {
        Client@ client = G_GetClient( i );
        // Same liveness guard the ghostbot sweep uses — the ONLY client-slot
        // idiom proven at boot in this codebase.
        if ( @client == null || client.state() < CS_SPAWNED )
            continue;
        Player@ player = RACE_GetPlayer( client );
        if ( player is null || !player.pendingTourneyJoin )
            continue;

        int result = RS_ApiPollTourneyJoin( client.playerNum );
        if ( result == 0 )
        {
            // Nothing yet. A request that will never be answered must still
            // release the slot, or the player is stuck on "still checking"
            // forever with no way to try again.
            if ( player.tourneyJoinDeadline != 0 && levelTime >= player.tourneyJoinDeadline )
            {
                player.pendingTourneyJoin = false;
                player.tourneyJoinDeadline = 0;
                client.printMessage( S_COLOR_RED + "Tournament sign-up timed out - try again.\n" );
            }
            continue;
        }
        player.pendingTourneyJoin = false;
        player.tourneyJoinDeadline = 0;
        if ( result != 1 )
        {
            client.printMessage( S_COLOR_RED + "Could not reach the tournament server - try again in a moment.\n" );
            continue;
        }
        RACE_PrintTourneyJoinReply( client, RS_TourneyJoinText( client.playerNum ) );
    }
}

// Print an "RSTJOIN" reply: header line, then "ok"/"err", then one message per
// remaining line. Colour comes from the status line so the web decides what is
// good news without the game having to interpret the text.
void RACE_PrintTourneyJoinReply( Client@ client, const String &in text )
{
    uint total = text.length();
    uint pos = 0;
    int lineNo = 0;
    bool ok = false;
    while ( pos < total )
    {
        uint nl = RACE_LocateFrom( text, "\n", pos );
        if ( nl > total )
            nl = total;
        String line = text.substr( pos, nl - pos );
        pos = nl + 1;
        lineNo++;
        if ( lineNo == 1 )
            continue; // "RSTJOIN" sentinel
        if ( lineNo == 2 )
        {
            ok = ( line == "ok" );
            continue;
        }
        if ( line.length() == 0 )
            continue;
        // Assign-then-branch instead of a String ternary (Warsow-AS strictness).
        String colour = S_COLOR_RED;
        if ( ok )
            colour = S_COLOR_GREEN;
        client.printMessage( colour + line + S_COLOR_WHITE + "\n" );
    }
    if ( ok && raceTourneyKnown && !RACE_TourneyOnPoolMap() )
    {
        client.printMessage( S_COLOR_YELLOW + "This map is not in the tournament pool - "
            + S_COLOR_WHITE + "callvote tourneymap" + S_COLOR_YELLOW + " to switch to one.\n" );
    }
}

// Fire the per-slot join request. `code` empty = "enrol me in whatever is on".
void RACE_TriggerTourneyJoin( Client@ client, const String &in code )
{
    Player@ player = RACE_GetPlayer( client );
    if ( player is null )
        return;
    player.pendingTourneyJoin = true;
    // levelTime can be 0 on the very first frame, so 1 is the "armed" sentinel
    // (0 means "no deadline"), the same idiom as raceIdleSince in maprotate.as.
    player.tourneyJoinDeadline = levelTime + TOURNEY_JOIN_TIMEOUT_MS;
    if ( player.tourneyJoinDeadline == 0 )
        player.tourneyJoinDeadline = 1;
    RS_ApiTourneyJoin( rsApiTourneyJoinUrl.string, rsApiToken.string, code,
        client.name, client.getMMLogin(), client.playerNum );
}

// Print the current tournament and its pool to one player.
void RACE_PrintTourney( Client@ client )
{
    if ( !raceTourneyKnown )
    {
        client.printMessage( S_COLOR_YELLOW + "No tournament is scheduled right now.\n" );
        return;
    }

    client.printMessage( S_COLOR_ORANGE + "== " + S_COLOR_WHITE + raceTourneyName + S_COLOR_ORANGE + " ==\n" );
    client.printMessage( S_COLOR_WHITE + "Runs " + S_COLOR_YELLOW + RACE_TourneyFmtTime( raceTourneyStartsAt )
        + S_COLOR_WHITE + " to " + S_COLOR_YELLOW + RACE_TourneyFmtTime( raceTourneyEndsAt ) + S_COLOR_WHITE + "\n" );

    if ( raceTourneyMaps.length() == 0 )
    {
        client.printMessage( S_COLOR_YELLOW + "No maps in the pool yet.\n" );
    }
    else
    {
        client.printMessage( S_COLOR_WHITE + "Maps (" + raceTourneyMaps.length() + "):\n" );
        Table table( "r l l" );
        Cvar mapnameCvar( "mapname", "", 0 );
        String current = mapnameCvar.string.removeColorTokens().tolower();
        uint shown = raceTourneyMaps.length();
        if ( shown > TOURNEY_MAPS_SHOWN )
            shown = TOURNEY_MAPS_SHOWN;
        for ( uint i = 0; i < shown; i++ )
        {
            // Lead with "" so this is a string + uint concat (the form used in
            // Cmd_LastMaps / Cmd_Maplist) rather than uint + string.
            table.addCell( "" + ( i + 1 ) + "." );
            table.addCell( S_COLOR_YELLOW + raceTourneyMaps[i] );
            // Assign-then-branch: no String ternary (Warsow-AS strictness).
            String flag = "";
            if ( raceTourneyMaps[i] == current )
                flag = S_COLOR_GREEN + "<- you are here";
            table.addCell( flag );
        }
        uint rows = table.numRows();
        for ( uint i = 0; i < rows; i++ )
            client.printMessage( table.getRow( i ) + "\n" );
        if ( raceTourneyMaps.length() > shown )
            client.printMessage( S_COLOR_YELLOW + "...and " + ( raceTourneyMaps.length() - shown )
                + " more - the full pool is on the website.\n" );
    }

    client.printMessage( S_COLOR_WHITE + "Join at " + S_COLOR_ORANGE + "racesow.org/tournaments/" + raceTourneySlug
        + S_COLOR_WHITE + " for a code, then " + S_COLOR_ORANGE + "/tournament <code>" + S_COLOR_WHITE
        + " - or just " + S_COLOR_ORANGE + "/tournament join" + S_COLOR_WHITE + " right here.\n" );
    client.printMessage( S_COLOR_WHITE + "Every run you set on a pool map before it ends counts.\n" );
}

/*
 * /tournament            show what is on, its maps, and how to enter
 * /tournament join       enrol the nick you are playing under, right now
 * /tournament <code>     redeem an entry code minted on the website
 * /tournament maps       the pool only (same as /tmaps)
 */
bool Cmd_Tournament( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( rsApiTourneyUrl.string.length() == 0 )
    {
        client.printMessage( S_COLOR_RED + "Tournaments are not available on this server.\n" );
        return false;
    }

    String arg = argsString.getToken( 0 ).removeColorTokens();

    if ( arg.length() == 0 || arg.tolower() == "maps" || arg.tolower() == "info" )
    {
        if ( arg.tolower() == "maps" )
            return Cmd_TourneyMaps( client, cmdString, argsString, argc );
        RACE_PrintTourney( client );
        return true;
    }

    if ( rsApiTourneyJoinUrl.string.length() == 0 )
    {
        client.printMessage( S_COLOR_RED + "Tournament sign-up is not available on this server.\n" );
        return false;
    }
    Player@ player = RACE_GetPlayer( client );
    if ( player !is null && player.pendingTourneyJoin )
    {
        client.printMessage( S_COLOR_YELLOW + "Still checking your last tournament request - hold on.\n" );
        return true;
    }

    if ( arg.tolower() == "join" )
    {
        if ( !raceTourneyKnown )
        {
            client.printMessage( S_COLOR_YELLOW + "No tournament is scheduled right now.\n" );
            return true;
        }
        client.printMessage( S_COLOR_WHITE + "Entering you into " + S_COLOR_YELLOW + raceTourneyName
            + S_COLOR_WHITE + "...\n" );
        RACE_TriggerTourneyJoin( client, "" );
        return true;
    }

    // Anything else is treated as an entry code. Length is checked web-side
    // (the code alphabet and format live in web/tournaments.js) — passing it
    // through unmodified keeps exactly one definition of what a code is.
    client.printMessage( S_COLOR_WHITE + "Checking entry code " + S_COLOR_YELLOW + arg + S_COLOR_WHITE + "...\n" );
    RACE_TriggerTourneyJoin( client, arg );
    return true;
}

// /tmaps - the current tournament's map pool, nothing else.
bool Cmd_TourneyMaps( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( rsApiTourneyUrl.string.length() == 0 )
    {
        client.printMessage( S_COLOR_RED + "Tournaments are not available on this server.\n" );
        return false;
    }
    if ( !raceTourneyKnown )
    {
        client.printMessage( S_COLOR_YELLOW + "No tournament is scheduled right now.\n" );
        return true;
    }
    if ( raceTourneyMaps.length() == 0 )
    {
        client.printMessage( S_COLOR_YELLOW + "The tournament pool isn't ready yet - try again in a moment.\n" );
        return true;
    }

    client.printMessage( S_COLOR_WHITE + raceTourneyName + S_COLOR_WHITE + " pool ("
        + raceTourneyMaps.length() + " maps):\n" );
    uint shown = raceTourneyMaps.length();
    if ( shown > TOURNEY_MAPS_SHOWN )
        shown = TOURNEY_MAPS_SHOWN;
    Table table( "r l" );
    for ( uint i = 0; i < shown; i++ )
    {
        table.addCell( "" + ( i + 1 ) + "." );
        table.addCell( S_COLOR_YELLOW + raceTourneyMaps[i] );
    }
    uint rows = table.numRows();
    for ( uint i = 0; i < rows; i++ )
        client.printMessage( table.getRow( i ) + "\n" );
    if ( raceTourneyMaps.length() > shown )
        client.printMessage( S_COLOR_YELLOW + "...and " + ( raceTourneyMaps.length() - shown )
            + " more - the full pool is on the website.\n" );
    return true;
}

// Pick the map a "callvote tourneymap [name]" should switch to.
//
// With no argument: a random pool map that is installed, not blocked and not
// the current one — so repeated votes walk the pool instead of re-picking where
// everyone already is. With an argument: that pool map, if it is installed.
// Returns "" when there is nothing to switch to; `why` explains it.
//
// "Installed" is resolved by INTERSECTING the pool with the engine's own map
// list rather than probing each name: GetMapsByPattern is the proven
// enumeration every other vote path uses (it walks ML_GetMapByNum and already
// drops moderator-blocked maps), so this can never vote the server onto a map
// the box never downloaded — which would fail the change and strand it.
String RACE_PickTourneyMap( const String &in wanted, String &out why )
{
    why = "";
    if ( !raceTourneyKnown || raceTourneyMaps.length() == 0 )
    {
        why = "No tournament pool is available right now.";
        return "";
    }

    Cvar mapnameCvar( "mapname", "", 0 );
    String current = mapnameCvar.string.removeColorTokens().tolower();
    String want = wanted.removeColorTokens().tolower();

    // Empty pattern = every installed, non-blocked map. Deliberately NOT
    // passing `ignore`: with an explicit map argument the current map is a
    // legitimate (if pointless) choice, and the no-argument path filters it
    // below anyway.
    String pattern = "";
    String[] installed = GetMapsByPattern( pattern );

    String[] pool;
    for ( uint i = 0; i < raceTourneyMaps.length(); i++ )
    {
        String m = raceTourneyMaps[i];
        if ( want.length() > 0 && m != want )
            continue;
        if ( want.length() == 0 && m == current )
            continue; // no-op vote

        // Insert the ENGINE's spelling, not the lowercased feed name: that is
        // what gets handed to `map <name>`, and it is the form every other
        // vote path (randmap, meshvote, the idle rotation) passes through.
        for ( uint j = 0; j < installed.length(); j++ )
        {
            if ( installed[j].removeColorTokens().tolower() == m )
            {
                pool.insertLast( installed[j] );
                break;
            }
        }
    }

    if ( pool.length() == 0 )
    {
        if ( want.length() > 0 )
            why = "\"" + want + "\" is not an installed, unblocked map in the tournament pool.";
        else
            why = "No other tournament map is installed on this server.";
        return "";
    }
    return pool[randrange( pool.length() )];
}
