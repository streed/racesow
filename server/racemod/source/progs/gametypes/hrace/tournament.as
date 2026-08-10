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
//   3. Getting everyone onto the right map. "callvote tourneymap [mask]" picks
//      from the pool and reuses the proven randmap change path (set
//      randmap_passed, launch POSTMATCH — see commands.as). The mask is a
//      /tmaps row number, a map name, part of one, or nothing at all for a
//      random pool map; "/tourneyvote [mask]" is the shortcut that resolves it
//      and calls that same vote for the resolved map by name.
//
//   4. Telling people it is on. A tournament nobody hears about is a tournament
//      nobody enters, and the website is the only other place it is advertised.
//      So while one is LIVE the box says so: once to each player shortly after
//      they join, once to everyone the moment a tournament starts mid-session,
//      and then on a slow rs_tourney_announce_interval rotation. All three are
//      the same pitch (RACE_TourneyPitch) and all three are silent unless a
//      tournament is actually running with a real player on the box.
//
// Fail-open throughout: empty rs_api_tourney_url = the feature is off and every
// command says so; a failed fetch just retries next interval.
//
// Payload contract (web/tournaments.js gameTourneyText):
//   RSTOURNEY
//   T<TAB><id><TAB><slug><TAB><startsAt><TAB><endsAt><TAB><name>
//   S<TAB><live|soon><TAB><secondsLeft><TAB><entrants>
//   M<TAB><mapname>
//   ...
// At most one T line — the tournament running NOW, or the next one due if none
// is — followed by its state and its pool. A bare header is the real "nothing
// scheduled" state. Line-walked with RACE_LocateFrom because getToken would
// split the multi-word name; tabs delimit so a name with spaces survives intact.

Cvar rsApiTourneyUrl( "rs_api_tourney_url", "", 0 );
Cvar rsApiTourneyJoinUrl( "rs_api_tourney_join_url", "", 0 );
// Seconds between "a tournament is on" broadcasts; 0 mutes the rotation (the
// per-player notice on join and the it-just-started announce still fire — those
// are news, not a rotation). Archived and defaulted to the same cadence as
// rs_announce_interval so the two nudges sit at the same, tunable volume.
Cvar rs_tourney_announce_interval( "rs_tourney_announce_interval", "600", CVAR_ARCHIVE );

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
// How long after a player is first seen spawned before their personal "there is
// a tournament on" notice prints. Joining already dumps the MOTD, their PB for
// this map and any achievement popups into the console; landing on top of that
// is landing in a scroll nobody reads.
const uint TOURNEY_GREET_DELAY_MS = 12000;
// Floor on rs_tourney_announce_interval; below it the rotation is off entirely.
const int TOURNEY_ANNOUNCE_MIN_S = 60;

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

// Whether that tournament is running RIGHT NOW, and how long until it ends (or
// starts, when it hasn't). AngelScript has no wall clock, so neither is derived
// here — both are resolved web-side at fetch time and carried on the S line.
// The feed refreshes every API_TOURNEY_REFRESH_MS, which is why the countdown
// is only ever printed coarsely (RACE_TourneyFmtSpan): at day/hour/minute
// granularity a payload up to a minute old reads exactly the same as a fresh
// one, and nothing has to tick between fetches.
bool raceTourneyLive = false;
int raceTourneySecsLeft = 0;
int raceTourneyEntrants = 0;

// Announce bookkeeping. raceTourneyStateSeen exists so the FIRST payload parsed
// on a map only records the state: the game module persists the last payload
// across map changes (RS_TourneyText), so without it every map load would look
// like a tournament that had just started and re-announce it.
bool raceTourneyStateSeen = false;
bool raceTourneyWasLive = false;
String raceTourneyLastSlug = "";
bool raceTourneyAnnounceNow = false;  // a tournament went live since the last parse
// Wall-clock deadline (realTime, ms) for the next rotation broadcast. realTime
// rather than levelTime keeps the cadence steady across map changes and match
// states, matching announcement.as.
uint raceTourneyAnnounceNext = 0;

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

// A rough "2d 3h" / "45m" for a countdown. Coarse on purpose — see the note on
// raceTourneySecsLeft: the number is only as fresh as the last fetch, and an
// exact second would advertise a precision the feed does not have.
String RACE_TourneyFmtSpan( int secs )
{
    if ( secs <= 0 )
        return "any moment";
    int days = secs / 86400;
    int hours = ( secs % 86400 ) / 3600;
    int mins = ( secs % 3600 ) / 60;
    if ( days > 0 )
    {
        // Build-then-append rather than a String ternary (Warsow-AS strictness).
        String s = "" + days + "d";
        if ( hours > 0 )
            s += " " + hours + "h";
        return s;
    }
    if ( hours > 0 )
    {
        String s = "" + hours + "h";
        if ( mins > 0 )
            s += " " + mins + "m";
        return s;
    }
    if ( mins > 0 )
        return "" + mins + "m";
    return "under a minute";
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
    raceTourneyLive = false;
    raceTourneySecsLeft = 0;
    raceTourneyEntrants = 0;
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
        if ( kind == "S" )
        {
            // S \t live|soon \t secondsLeft \t entrants
            uint u1 = RACE_LocateFrom( line, "\t", 0 );
            if ( u1 >= line.length() )
                continue;
            uint u2 = RACE_LocateFrom( line, "\t", u1 + 1 );
            if ( u2 >= line.length() )
                continue;
            uint u3 = RACE_LocateFrom( line, "\t", u2 + 1 );
            if ( u3 >= line.length() )
                continue;
            raceTourneyLive = ( line.substr( u1 + 1, u2 - u1 - 1 ) == "live" );
            raceTourneySecsLeft = line.substr( u2 + 1, u3 - u2 - 1 ).toInt();
            raceTourneyEntrants = line.substr( u3 + 1 ).toInt();
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

    // Did a tournament START between this payload and the last one? That is
    // news worth interrupting for, so flag it for the announce tick instead of
    // making everyone wait out the rotation. A different slug counts too: one
    // edition ending as the next begins is, to everyone on the box, a new
    // tournament starting.
    bool live = raceTourneyKnown && raceTourneyLive;
    if ( raceTourneyStateSeen && live && ( !raceTourneyWasLive || raceTourneySlug != raceTourneyLastSlug ) )
        raceTourneyAnnounceNow = true;
    raceTourneyStateSeen = true;
    raceTourneyWasLive = live;
    raceTourneyLastSlug = raceTourneySlug;
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

    RACE_TourneyAnnounceTick();
    RACE_TourneyGreetThink();
}

// Print one line to one client, or to everyone when `client` is null. The two
// halves of every announcement path differ only here.
void RACE_TourneyPrintLine( Client@ client, const String &in line )
{
    if ( @client == null )
        G_PrintMsg( null, line );
    else
        client.printMessage( line );
}

// The pitch: what is on, how long it has left, and the one command that gets
// you into it. Sent per line (each print is its own reliable command — see the
// 1024-char command buffer note in the engine docs) and deliberately short: it
// interrupts whatever the player was doing, so it earns four lines at most.
void RACE_TourneyPitch( Client@ client )
{
    if ( !raceTourneyKnown )
        return;

    // Assign-then-branch instead of a String ternary (Warsow-AS strictness).
    String head = S_COLOR_ORANGE + ">> TOURNAMENT: " + S_COLOR_WHITE + raceTourneyName;
    if ( raceTourneyLive )
        head = S_COLOR_ORANGE + ">> TOURNAMENT LIVE: " + S_COLOR_WHITE + raceTourneyName;
    RACE_TourneyPrintLine( client, head + "\n" );

    String facts = S_COLOR_WHITE + "" + raceTourneyMaps.length() + " map";
    if ( raceTourneyMaps.length() != 1 )
        facts += "s";
    if ( raceTourneySecsLeft > 0 )
    {
        String when = " until it starts";
        if ( raceTourneyLive )
            when = " left";
        facts += S_COLOR_ORANGE + " | " + S_COLOR_WHITE + RACE_TourneyFmtSpan( raceTourneySecsLeft ) + when;
    }
    if ( raceTourneyEntrants > 0 )
        facts += S_COLOR_ORANGE + " | " + S_COLOR_WHITE + raceTourneyEntrants + " entered";
    RACE_TourneyPrintLine( client, facts + "\n" );

    RACE_TourneyPrintLine( client, S_COLOR_WHITE + "Enter free right here with " + S_COLOR_ORANGE
        + "/tournament join" + S_COLOR_WHITE + " - every run on a pool map then counts.\n" );

    // Assign-then-branch again: which nudge follows depends on where they are.
    String tail = S_COLOR_WHITE + "Pool: " + S_COLOR_ORANGE + "/tmaps" + S_COLOR_WHITE + " - switch to one with "
        + S_COLOR_ORANGE + "/tourneyvote" + S_COLOR_WHITE + ".\n";
    if ( RACE_TourneyOnPoolMap() )
        tail = S_COLOR_GREEN + "This map is in the pool" + S_COLOR_WHITE + " - your next run scores.\n";
    RACE_TourneyPrintLine( client, tail );
}

// Pitch to the whole box, and count everyone present as told: a player who just
// heard the broadcast must not get their personal copy 12 seconds later.
void RACE_TourneyPitchAll()
{
    RACE_TourneyPitch( null );
    for ( int i = 0; i < maxClients; i++ )
    {
        Client@ client = G_GetClient( i );
        if ( @client == null || client.state() < CS_SPAWNED )
            continue;
        Player@ player = RACE_GetPlayer( client );
        if ( player is null )
            continue;
        player.tourneyNoticeSent = true;
    }
}

// The rotation gap in milliseconds, or 0 when the rotation is off. Anything
// under TOURNEY_ANNOUNCE_MIN_S is treated as off rather than obeyed: this print
// interrupts everyone on the box, and a mis-typed "5" would be a spam loop
// nobody could mute except by finding this cvar again.
uint RACE_TourneyRotationMs()
{
    int interval = rs_tourney_announce_interval.integer;
    if ( interval < TOURNEY_ANNOUNCE_MIN_S )
        return 0;
    return uint( interval ) * 1000;
}

// Broadcast when a tournament starts, then on the slow rotation. Silent unless
// something is actually LIVE and a real player is on the box — an empty server
// announcing a tournament to nobody just fills its own console log (the same
// reasoning, and the same RACE_RealPlayerCount guard, as announcement.as).
void RACE_TourneyAnnounceTick()
{
    if ( !raceTourneyKnown || !raceTourneyLive )
    {
        // Nothing on: re-arm so whatever starts next gets a full interval
        // before its first rotation broadcast rather than an immediate one.
        raceTourneyAnnounceNext = 0;
        raceTourneyAnnounceNow = false;
        return;
    }

    uint gap = RACE_TourneyRotationMs();

    if ( raceTourneyAnnounceNow )
    {
        // Consume it either way: if the box is empty, the news is stale by the
        // time anyone arrives, and they get the personal notice on join.
        raceTourneyAnnounceNow = false;
        if ( RACE_RealPlayerCount() > 0 )
        {
            RACE_TourneyPitchAll();
            raceTourneyAnnounceNext = realTime + gap;
            return;
        }
    }

    if ( gap == 0 )
        return; // rotation off

    // First eligible frame: arm the timer instead of firing, so the rotation
    // lands an interval in rather than the moment a map loads.
    if ( raceTourneyAnnounceNext == 0 )
    {
        raceTourneyAnnounceNext = realTime + gap;
        return;
    }
    if ( realTime < raceTourneyAnnounceNext )
        return;
    // Re-arm even when the print below is skipped, so an idle stretch doesn't
    // fire the instant someone joins mid-interval.
    raceTourneyAnnounceNext = realTime + gap;
    if ( RACE_RealPlayerCount() <= 0 )
        return;
    RACE_TourneyPitchAll();
}

// One personal notice per player per map while a tournament is live, a few
// seconds after they are properly in. Walks every slot (not just TEAM_PLAYERS)
// so a spectator hears about it too — they can enter and start racing.
void RACE_TourneyGreetThink()
{
    if ( !raceTourneyKnown || !raceTourneyLive )
        return;

    for ( int i = 0; i < maxClients; i++ )
    {
        Client@ client = G_GetClient( i );
        // Same liveness guard the ghostbot sweep uses — the ONLY client-slot
        // idiom proven at boot in this codebase.
        if ( @client == null || client.state() < CS_SPAWNED )
            continue;
        // Mirror bots stand in for players on OTHER servers and the TV client
        // is a camera; neither can type /tournament join.
        if ( RACE_MirrorIsFakeClient( client ) || RACE_IsTvClient( client ) )
            continue;
        Player@ player = RACE_GetPlayer( client );
        if ( player is null || player.tourneyNoticeSent )
            continue;

        if ( player.tourneyNoticeAt == 0 )
        {
            // levelTime can be 0 on the very first frame, so 1 is the "armed"
            // sentinel (0 means "not scheduled"), as in RACE_TriggerTourneyJoin.
            player.tourneyNoticeAt = levelTime + TOURNEY_GREET_DELAY_MS;
            if ( player.tourneyNoticeAt == 0 )
                player.tourneyNoticeAt = 1;
            continue;
        }
        if ( levelTime < player.tourneyNoticeAt )
            continue;

        player.tourneyNoticeSent = true;
        RACE_TourneyPitch( client );
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
        // Whatever the answer, they have just been talking to the tournament —
        // the unprompted "there is one on" notice would be noise now.
        player.tourneyNoticeSent = true;
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
    // They asked, so they know: don't also push the unprompted notice at them
    // moments later.
    Player@ reader = RACE_GetPlayer( client );
    if ( reader !is null )
        reader.tourneyNoticeSent = true;

    if ( !raceTourneyKnown )
    {
        client.printMessage( S_COLOR_YELLOW + "No tournament is scheduled right now.\n" );
        return;
    }

    client.printMessage( S_COLOR_ORANGE + "== " + S_COLOR_WHITE + raceTourneyName + S_COLOR_ORANGE + " ==\n" );
    // Lead with the state: "is this on right now, and how long have I got" is
    // the first thing anyone wants, and the absolute window below answers it
    // only after some mental arithmetic in a timezone that isn't theirs.
    String state = S_COLOR_YELLOW + "Starts in " + RACE_TourneyFmtSpan( raceTourneySecsLeft );
    if ( raceTourneyLive )
        state = S_COLOR_GREEN + "LIVE NOW" + S_COLOR_WHITE + " - " + S_COLOR_YELLOW
            + RACE_TourneyFmtSpan( raceTourneySecsLeft ) + " left";
    if ( raceTourneyEntrants > 0 )
        state += S_COLOR_WHITE + " - " + raceTourneyEntrants + " entered";
    client.printMessage( state + S_COLOR_WHITE + "\n" );
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
    // The list is numbered, so say what the numbers are for: /tourneyvote takes
    // a row number, and without this the numbering is decoration.
    client.printMessage( S_COLOR_WHITE + "Move the server onto one with " + S_COLOR_ORANGE
        + "/tourneyvote <number>" + S_COLOR_WHITE + " - or " + S_COLOR_ORANGE + "/tourneyvote"
        + S_COLOR_WHITE + " for a random one.\n" );
    return true;
}

// How many pool maps the last RACE_PickTourneyMap call had to choose between.
// A global rather than a second out parameter for the same reason
// randmap_matches is one: the draw and the line that announces it are one step
// apart in the caller and nothing can run in between.
uint raceTourneyPickMatches = 0;

/*
 * /tourneyvote [mask]  call the vote to move this server onto a pool map.
 *
 * The mask is the same one "callvote tourneymap" takes — nothing, "*", a /tmaps
 * row number, a map name or part of one — and this resolves it HERE, then calls
 * the vote for the resolved map by name. Two things come out of resolving first:
 * a mask that matches nothing says so to the one player who typed it instead of
 * opening a vote that dies on validation, and the vote everyone sees quotes the
 * actual map rather than "*" (the engine's "called a vote" line prints the
 * argument verbatim).
 *
 * The vote itself is the ordinary callvote — same majority, same timeout, same
 * one-at-a-time rule. This is a shortcut into it, not a second way to move the
 * server.
 */
bool Cmd_TourneyVote( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( rsApiTourneyUrl.string.length() == 0 )
    {
        client.printMessage( S_COLOR_RED + "Tournaments are not available on this server.\n" );
        return false;
    }

    String why = "";
    String picked = RACE_PickTourneyMap( argsString.getToken( 0 ), why );
    if ( picked.length() == 0 )
    {
        client.printMessage( S_COLOR_RED + why + "\n" );
        return false;
    }

    // Pass the resolved NAME, never the mask: the vote re-resolves its argument
    // and an exact name beats every other form of match, so what gets loaded is
    // exactly what was announced here — no second draw.
    String vote = "callvote tourneymap " + picked;
    if ( raceTourneyPickMatches > 1 )
        client.printMessage( S_COLOR_WHITE + "Picked " + S_COLOR_YELLOW + picked + S_COLOR_WHITE
            + " out of " + raceTourneyPickMatches + " matching pool maps.\n" );
    // Same fallback as /hop: a server-issued command can be ignored client-side,
    // so the line they can type themselves is always on screen.
    client.printMessage( S_COLOR_WHITE + "Calling the vote ... if nothing happens, type: "
        + S_COLOR_YELLOW + vote + "\n" );
    client.execGameCommand( vote );
    return true;
}

// Pick the map a "callvote tourneymap [map]" should switch to.
//
// The argument matches the way the rest of the mod matches, because a player who
// has just read /tmaps types back what /tmaps showed them:
//
//   (nothing)   a random pool map that isn't the one everyone is already on
//   3           the third map of the pool, as /tmaps numbers it
//   coldrun     that map
//   aurora      a random pool map whose name contains "aurora"
//
// An exact name always beats a substring, so a pool holding both "coldrun" and
// "coldrun2" can still be voted onto "coldrun". Anything that resolves to the
// map already loaded is refused rather than drawn: it would pass, reload the
// same map and read as a broken vote.
//
// "Installed" is resolved by INTERSECTING the pool with the engine's own map
// list rather than probing each name: GetMapsByPattern is the proven
// enumeration every other vote path uses (it walks ML_GetMapByNum and already
// drops moderator-blocked maps), so this can never vote the server onto a map
// the box never downloaded — which would fail the change and strand it.
//
// Returns "" when there is nothing to switch to; `why` explains it in a line
// meant to be printed straight at the caller.
String RACE_PickTourneyMap( const String &in wanted, String &out why )
{
    why = "";
    raceTourneyPickMatches = 0;
    if ( !raceTourneyKnown || raceTourneyMaps.length() == 0 )
    {
        why = "No tournament pool is available right now.";
        return "";
    }

    Cvar mapnameCvar( "mapname", "", 0 );
    String current = mapnameCvar.string.removeColorTokens().tolower();
    String want = wanted.removeColorTokens().tolower();
    if ( want == "*" )
        want = ""; // same "surprise me" spelling randmap takes

    // A bare number is a /tmaps row: that listing is numbered, so it is what
    // gets read out loud. Resolved against the WHOLE pool — the list they saw —
    // rather than the installed subset, or the numbers would not line up. A map
    // actually NAMED in digits (there are maps called "001") wins over the row
    // number, because that is the one reading of the argument that can only have
    // been meant literally.
    bool namedExactly = false;
    for ( uint i = 0; want.length() > 0 && i < raceTourneyMaps.length(); i++ )
    {
        if ( raceTourneyMaps[i] == want )
        {
            namedExactly = true;
            break;
        }
    }
    if ( want.length() > 0 && !namedExactly && want.isNumeric() )
    {
        int n = want.toInt();
        if ( n < 1 || n > int( raceTourneyMaps.length() ) )
        {
            why = "There is no pool map " + n + ". /tmaps lists the "
                + raceTourneyMaps.length() + " there are.";
            return "";
        }
        want = raceTourneyMaps[n - 1];
    }

    // Empty pattern = every installed, non-blocked map. Deliberately NOT
    // passing `ignore`: the current map is filtered below, where knowing that
    // it was what the argument asked for is what makes the refusal readable.
    String pattern = "";
    String[] installed = GetMapsByPattern( pattern );

    String[] exact;
    String[] loose;
    bool namedCurrent = false;
    for ( uint i = 0; i < raceTourneyMaps.length(); i++ )
    {
        String m = raceTourneyMaps[i];
        bool isExact = ( want.length() > 0 && m == want );
        if ( want.length() > 0 && !isExact && !PatternMatch( m, want ) )
            continue;

        // Never a candidate, but remember that they asked for it: "you are
        // already there" and "no such map" are different answers.
        if ( m == current )
        {
            namedCurrent = true;
            continue;
        }

        // Take the ENGINE's spelling, not the lowercased feed name: that is
        // what gets handed to `map <name>`, and it is the form every other
        // vote path (randmap, meshvote, the idle rotation) passes through.
        for ( uint j = 0; j < installed.length(); j++ )
        {
            if ( installed[j].removeColorTokens().tolower() == m )
            {
                if ( isExact )
                    exact.insertLast( installed[j] );
                else
                    loose.insertLast( installed[j] );
                break;
            }
        }
    }

    // Assign-then-branch rather than a ternary over an array (Warsow-AS
    // strictness): the exact hit wins outright when there is one.
    String[] pool = loose;
    if ( exact.length() > 0 )
        pool = exact;

    if ( pool.length() == 0 )
    {
        if ( namedCurrent )
            why = "This server is already on " + current + ".";
        else if ( want.length() > 0 )
            why = "\"" + want + "\" is not an installed, unblocked map in the tournament pool. Try /tmaps.";
        else
            why = "No other tournament map is installed on this server.";
        return "";
    }

    raceTourneyPickMatches = pool.length();
    return pool[randrange( pool.length() )];
}

///*****************************************************************
/// Callvote hooks — the racesow.org implementation of the two hook points
/// base commands.as offers for vote names it does not own itself.
///
/// `tourneymap` used to be a branch inside Cmd_CallvoteValidate, which meant
/// the BASE vote handler called RACE_PickTourneyMap and read
/// raceTourneyPickMatches — two symbols that vanish with this module. The
/// bookkeeping below moved with it, deliberately kept separate from randmap's
/// slots so the two vote types can never hand each other a pick.
///*****************************************************************

uint tourneymap_time = 0;
String tourneymap_pick = "";
String tourneymap_arg = "";
uint tourneymap_matches = 0;

// Claim `tourneymap`; return CALLVOTE_UNHANDLED for anything else so the base
// handler carries on to its own vote names and finally to "Unknown callvote".
int RACE_HookCallvoteValidate( Client@ client, const String &in votename, const String &in argsString )
{
    if ( votename != "tourneymap" )
        return CALLVOTE_UNHANDLED;

    // The engine calls callvotevalidate MORE THAN ONCE for a single vote —
    // once when it is called and again roughly every second it stays open —
    // so the pool draw has to happen once per VOTE, not once per call, or
    // the vote announces one map and loads another. randmap does that with
    // its delay dance alone; this keeps the drawn map itself (and the
    // argument it was drawn for), which makes reuse a positive test rather
    // than an inference from the clock:
    //
    //   nothing drawn yet -> draw (the clock alone would skip this in the
    //                        first second of a map, and the vote would then
    //                        pass with no map at all)
    //   argument changed  -> draw (a different vote, whatever the clock says)
    //   pick gone stale   -> draw (a later vote; the one in flight is
    //                        re-validated well inside RANDMAP_DELAY_MAX)
    String want = argsString.getToken( 1 );
    if ( tourneymap_pick.length() == 0
         || want != tourneymap_arg
         || levelTime - tourneymap_time > RANDMAP_DELAY_MAX )
    {
        String why = "";
        String picked = RACE_PickTourneyMap( want, why );
        if ( picked.length() == 0 )
        {
            client.printMessage( S_COLOR_RED + why + "\n" );
            return CALLVOTE_REJECTED;
        }
        tourneymap_pick = picked;
        tourneymap_arg = want;
        tourneymap_matches = raceTourneyPickMatches;

        // Announce on the DRAW, not on a particular re-validation: the
        // engine's own "called a vote" line quotes the player's argument,
        // which for the no-argument form names no map at all, so this is
        // the only place anyone is told what they are voting for. Doing it
        // here also means it is said exactly once however often the engine
        // re-validates.
        String note = S_COLOR_YELLOW + "Tournament map: " + S_COLOR_WHITE + tourneymap_pick;
        if ( tourneymap_matches > 1 )
            note += S_COLOR_YELLOW + " (out of " + S_COLOR_WHITE + tourneymap_matches
                + S_COLOR_YELLOW + " pool maps that match)";
        G_PrintMsg( null, note + "\n" );
    }

    tourneymap_time = levelTime;
    return CALLVOTE_VALID;
}

// Does this layer own the vote at all? Asked separately from the pick below so
// that "my vote, but nothing was drawn" stays distinguishable from "not my
// vote" — otherwise a tourneymap vote that resolved to nothing would slip past
// the base handler's "the vote passed but no map was chosen" guard and pass
// silently, changing nothing.
bool RACE_HookOwnsCallvote( const String &in votename )
{
    return votename == "tourneymap";
}

// The map a hooked vote resolved to, read by Cmd_CallvotePassed only when
// RACE_HookOwnsCallvote said yes. May legitimately be empty.
String RACE_HookCallvotePassedTarget( const String &in votename )
{
    if ( votename == "tourneymap" )
        return tourneymap_pick;
    return "";
}
