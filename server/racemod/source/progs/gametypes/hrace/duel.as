// 1v1 duels: "/duel <player>" challenges someone to a head-to-head on the map
// you are both already standing on.
//
// SITE MODULE (like flag.as): the only thing in here that touches an engine
// native is the result report (RS_ApiReportDuel), so a base build without the
// racesow engine patches simply never sets rs_api_duel_url and every duel is
// local, in-memory and unreported. Everything else — the challenge, the live
// scoring, the grace period — is stock AngelScript.
//
// The shape, in one paragraph. A duel is an invitation (DUEL_INVITE_TTL_MS to
// answer) that becomes a live head-to-head on the CURRENT map: from the moment
// it is accepted, every non-practice finish either player records on that map,
// in that direction, updates their best time, and the FASTER best time is the
// lead. The lead can change hands as often as they can beat each other until
// the duel CONCLUDES, which happens on whichever comes first: the map changes,
// a duellist forfeits, or a duellist leaves and does not come back inside
// rs_duel_grace seconds. Whoever holds the faster time at that moment wins, and
// the finished match-up is POSTed to the central API so it lands on both
// players' profiles.
//
// Three decisions worth stating up front, because they are load-bearing:
//
//   * A duellist is identified by CLEAN NAME, not by client slot. That is what
//     makes the grace period work at all: a player who drops and reconnects
//     lands in whatever slot happens to be free, so a slot number stops meaning
//     them the moment they leave. Every other per-player feature here that has
//     to survive a reconnect (saved starts, awards, player records) already
//     keys on the same colour-stripped lowercase name, so duels do too. The
//     binding from name back to slot is rebuilt from scratch every think rather
//     than patched from the connect/disconnect events, which means there is
//     exactly ONE piece of code that decides who is present and it cannot drift
//     out of step with reality.
//
//     The known consequence: RENAMING mid-duel reads as leaving. The duel then
//     runs down its grace period, and renaming back inside it resumes exactly
//     where it was. That is an answer rather than a missing feature — the result
//     is filed under the name it was raced under, so "which name goes on this
//     duel" has to be decided somehow, and "the one you agreed to it under" is
//     the only answer with no ambiguity in it. Following renames instead would
//     mean deciding, about a slot whose occupant changed between two sweeps,
//     whether that was a rename or a different person connecting — which is the
//     exact guess that keying on the name exists to avoid.
//
//   * Every message a duel produces is printed to the two duellists and to
//     nobody else. A duel is a private arrangement between two players; the
//     rest of the server did not ask to watch somebody else's score, and a
//     busy server would otherwise turn into a wall of other people's splits.
//
//   * The direction is part of the duel. "/reverse" is a different leaderboard
//     (RACE_EffectiveMapName appends "-reversed"), so a reversed run cannot be
//     compared against a forward one. The duel records the direction it was
//     accepted in and only counts finishes in that direction — telling the
//     player once, rather than silently dropping the run.
//
// All duel state is per-map by construction: the map change concludes every
// duel and the module's arrays are script globals that reset with the map. So
// nothing in here has to survive GT_Shutdown, and none of it is written to
// disk.

// Where finished match-ups are POSTed (the central /api/game/duel). Empty = the
// feature still works in-game, it is just never recorded anywhere. Same
// fail-soft posture as every other rs_api_* consumer in this mod.
Cvar rsApiDuelUrl( "rs_api_duel_url", "", 0 );

// How long a duellist may be disconnected before the duel is concluded without
// them. Archived so a box can tune it; 0 concludes the moment they drop.
Cvar rs_duel_grace( "rs_duel_grace", "300", CVAR_ARCHIVE );

// How long an unanswered "/duel <player>" invitation stands. Long enough to
// notice mid-run, short enough that a forgotten invite is not still waiting
// when the map changes.
const uint DUEL_INVITE_TTL_MS = 60000;

// Minimum gap between one player's invitations. An invitation prints to another
// player, so without this "/duel" is a message spammer with extra steps. Same
// shape (and roughly the same volume) as the "/flag" cooldown.
const uint DUEL_INVITE_COOLDOWN_MS = 5000;

// Hard caps. maxClients is 16 on these boxes, so eight simultaneous duels is
// already "everybody on the server is duelling somebody"; the invite cap is the
// same bound plus room for the unanswered ones. Both exist so a bug in the
// expiry paths degrades into a refusal rather than an unbounded array.
const uint DUEL_MAX = 8;
const uint DUEL_INVITES_MAX = 16;

// How often the presence/expiry sweep runs. Every frame would be wasteful for
// state that changes on human timescales (someone dropping, an invite ageing
// out), and the grace period is measured in minutes.
const uint DUEL_THINK_INTERVAL_MS = 500;

uint raceDuelLastThink = 0;

// Per-slot invite cooldown, indexed by playerNum like the /flag cooldown. Slot
// indexed rather than name-keyed on purpose: this throttles the CONNECTION, so
// reconnecting to shed it is not a shortcut worth caring about.
uint[] raceDuelLastInvite( maxClients );


// One side of a duel. `cleanName` is the identity; everything else is a
// snapshot that the think loop refreshes.
class DuelSide
{
    String cleanName;    // colour-stripped, lowercased: survives a reconnect
    String displayName;  // last seen coloured name, for printing
    String login;        // MM login if there is one (usually empty)
    int slot;            // current client slot, or -1 when not connected
    uint bestTime;       // best counted finish in ms; 0 = has not finished yet
    uint finishes;       // counted finishes, for the profile line
    uint goneSince;      // levelTime they went missing; 0 = present
    bool warnedDirection; // "that run was the other way round" printed once

    DuelSide()
    {
        this.slot = -1;
        this.bestTime = 0;
        this.finishes = 0;
        this.goneSince = 0;
        this.warnedDirection = false;
    }

    // The client in this side's slot, or null when they are not connected.
    // Never trust the cached slot on its own: the sweep rebinds it, but a
    // caller can run between a disconnect and the next sweep.
    Client@ liveClient()
    {
        if ( this.slot < 0 || this.slot >= maxClients )
            return null;
        Client@ client = G_GetClient( this.slot );
        if ( @client == null || client.state() < CS_SPAWNED )
            return null;
        if ( client.name.removeColorTokens().tolower() != this.cleanName )
            return null;
        return client;
    }

    void print( const String &in msg )
    {
        Client@ client = this.liveClient();
        if ( @client != null )
            client.printMessage( msg );
    }
}

// A live head-to-head. `a` is the challenger, `b` the player who accepted;
// which is which only matters for reporting, never for scoring.
class Duel
{
    DuelSide a;
    DuelSide b;
    String mapName;   // effective name, so a reverse duel is "<map>-reversed"
    bool reversed;    // the direction finishes must be in to count
    uint startedAt;   // levelTime at accept, for the duration on the report
    bool over;

    Duel()
    {
        this.startedAt = 0;
        this.over = false;
    }

    // The side belonging to this clean name, or null. Returned by handle so
    // callers mutate the duel rather than a copy.
    DuelSide@ side( const String &in cleanName )
    {
        if ( this.a.cleanName == cleanName )
            return @this.a;
        if ( this.b.cleanName == cleanName )
            return @this.b;
        return null;
    }

    DuelSide@ other( const String &in cleanName )
    {
        if ( this.a.cleanName == cleanName )
            return @this.b;
        if ( this.b.cleanName == cleanName )
            return @this.a;
        return null;
    }

    void printBoth( const String &in msg )
    {
        this.a.print( msg );
        this.b.print( msg );
    }
}

// A sent-but-unanswered invitation.
class DuelInvite
{
    String fromClean;
    String fromDisplay;
    String toClean;
    String toDisplay;
    uint sentAt;
}

Duel@[] raceDuels;
DuelInvite@[] raceDuelInvites;


// --- small shared helpers ------------------------------------------------

String RACE_DuelCleanName( Client@ client )
{
    if ( @client == null )
        return "";
    return client.name.removeColorTokens().tolower();
}

// May this client take part in a duel at all? Mirror bots stand for players on
// a PEER server (their finishes arrive over the mesh, not through completeRace)
// and the TV camera is not a player, so neither can hold up their end.
bool RACE_DuelEligible( Client@ client )
{
    if ( @client == null || client.state() < CS_SPAWNED )
        return false;
    if ( RACE_IsPuppet( client ) || RACE_IsTvClient( client ) )
        return false;
    return RACE_DuelCleanName( client ).length() > 0;
}

// The live duel this clean name is in, or null. A player is in at most one.
Duel@ RACE_DuelFor( const String &in cleanName )
{
    if ( cleanName.length() == 0 )
        return null;
    for ( uint i = 0; i < raceDuels.length(); i++ )
    {
        if ( raceDuels[i].over )
            continue;
        if ( @raceDuels[i].side( cleanName ) != null )
            return raceDuels[i];
    }
    return null;
}

// Seconds -> "m:ss", for the grace countdown. RACE_TimeToString is a race clock
// (mm:ss.mmm) and reads wrong for "you have 4:12 left to come back".
String RACE_DuelCountdown( uint seconds )
{
    uint mins = seconds / 60;
    uint secs = seconds % 60;
    return mins + ":" + ( secs < 10 ? "0" : "" ) + secs;
}

// The scoreline both players see: two times and who is up. Written from the
// point of view of `you`, so each player reads their own version.
String RACE_DuelScoreLine( Duel@ d, DuelSide@ you )
{
    // Handle, not a copy: a ternary over a script class would copy-construct
    // the side and every "them" read would be a snapshot.
    DuelSide@ them = d.other( you.cleanName );
    if ( @them == null )
        return "";

    String mine = you.bestTime == 0 ? S_COLOR_ORANGE + "no time" : S_COLOR_WHITE + RACE_TimeToString( you.bestTime );
    String theirs = them.bestTime == 0 ? S_COLOR_ORANGE + "no time" : S_COLOR_WHITE + RACE_TimeToString( them.bestTime );

    String line = S_COLOR_YELLOW + "DUEL " + S_COLOR_WHITE + "vs " + them.displayName
            + S_COLOR_WHITE + " on " + S_COLOR_WHITE + d.mapName + S_COLOR_WHITE + "  -  you "
            + mine + S_COLOR_WHITE + ", them " + theirs;

    if ( you.bestTime != 0 && them.bestTime != 0 )
    {
        if ( you.bestTime < them.bestTime )
            line += S_COLOR_GREEN + "  (you lead by " + RACE_TimeToString( them.bestTime - you.bestTime ) + ")";
        else if ( them.bestTime < you.bestTime )
            line += S_COLOR_RED + "  (behind by " + RACE_TimeToString( you.bestTime - them.bestTime ) + ")";
        else
            line += S_COLOR_YELLOW + "  (dead level)";
    }
    return line + "\n";
}


// --- invitations ---------------------------------------------------------

// Drop an invitation by index (it was answered, expired, or one of the two
// players vanished).
void RACE_DuelDropInvite( uint i )
{
    if ( i < raceDuelInvites.length() )
        raceDuelInvites.removeAt( i );
}

// The outstanding invitation from `fromClean` to `toClean`, or -1.
int RACE_DuelFindInvite( const String &in fromClean, const String &in toClean )
{
    for ( uint i = 0; i < raceDuelInvites.length(); i++ )
    {
        if ( raceDuelInvites[i].fromClean == fromClean && raceDuelInvites[i].toClean == toClean )
            return int( i );
    }
    return -1;
}

// Every invitation waiting for `toClean` to answer, newest last.
uint[] RACE_DuelInvitesFor( const String &in toClean )
{
    uint[] found;
    for ( uint i = 0; i < raceDuelInvites.length(); i++ )
    {
        if ( raceDuelInvites[i].toClean == toClean )
            found.insertLast( i );
    }
    return found;
}

// Forget every invitation either of these two players is part of. Called when a
// duel starts, so the loser of a race to accept is not left holding an invite
// that can no longer be answered.
void RACE_DuelClearInvitesInvolving( const String &in cleanA, const String &in cleanB )
{
    for ( int i = int( raceDuelInvites.length() ) - 1; i >= 0; i-- )
    {
        DuelInvite@ inv = raceDuelInvites[ uint( i ) ];
        if ( inv.fromClean == cleanA || inv.toClean == cleanA
                || inv.fromClean == cleanB || inv.toClean == cleanB )
            raceDuelInvites.removeAt( uint( i ) );
    }
}

// Find a connected, duel-eligible client by clean name.
Client@ RACE_DuelClientByClean( const String &in cleanName )
{
    if ( cleanName.length() == 0 )
        return null;
    for ( int i = 0; i < maxClients; i++ )
    {
        Client@ client = G_GetClient( i );
        if ( !RACE_DuelEligible( client ) )
            continue;
        if ( RACE_DuelCleanName( client ) == cleanName )
            return client;
    }
    return null;
}


// --- starting and ending a duel ------------------------------------------

// Turn an accepted invitation into a live duel. Both clients are known to be
// connected and free (the accept path checked); this only builds the state and
// tells the two of them.
void RACE_DuelBegin( Client@ from, Client@ to )
{
    Player@ challenger = RACE_GetPlayer( from );

    Duel@ duel = Duel();
    duel.a.cleanName = RACE_DuelCleanName( from );
    duel.a.displayName = from.name;
    duel.a.login = from.getMMLogin();
    duel.a.slot = from.playerNum;
    duel.b.cleanName = RACE_DuelCleanName( to );
    duel.b.displayName = to.name;
    duel.b.login = to.getMMLogin();
    duel.b.slot = to.playerNum;
    // The direction is fixed at accept time from the CHALLENGER's, because the
    // challenge named a specific race; whoever accepts is agreeing to that one.
    duel.reversed = challenger.reversed;
    duel.mapName = RACE_EffectiveMapName( duel.reversed );
    duel.startedAt = levelTime;

    raceDuels.insertLast( duel );
    RACE_DuelClearInvitesInvolving( duel.a.cleanName, duel.b.cleanName );

    String head = S_COLOR_YELLOW + "DUEL ON: " + S_COLOR_WHITE + from.name + S_COLOR_YELLOW
            + " vs " + S_COLOR_WHITE + to.name + S_COLOR_YELLOW + " on " + S_COLOR_WHITE + duel.mapName + "\n";
    String rules = S_COLOR_WHITE + "Fastest time when the map changes wins. "
            + S_COLOR_YELLOW + "/duel" + S_COLOR_WHITE + " for the score, "
            + S_COLOR_YELLOW + "/forfeit" + S_COLOR_WHITE + " to concede.\n";

    from.printMessage( head );
    from.printMessage( rules );
    to.printMessage( head );
    to.printMessage( rules );

    if ( duel.reversed )
    {
        String note = S_COLOR_ORANGE + "This duel is REVERSED - only reverse runs count.\n";
        from.printMessage( note );
        to.printMessage( note );
    }
}

// Conclude a duel and report it. `reason` is one of "map_change", "disconnect"
// or "forfeit"; `forfeitedBy` is the clean name of whoever conceded and is empty
// otherwise. A forfeit is the ONE case where the times do not decide it — a
// player who concedes loses however fast they were.
//
// Idempotent via `over`: the map-change sweep and GT_Shutdown both run, and a
// player can forfeit in the same frame the last duellist drops.
void RACE_DuelConclude( Duel@ d, const String &in reason, const String &in forfeitedBy )
{
    if ( d.over )
        return;
    d.over = true;

    // "a" | "b" | "draw". Nobody finishing is not a draw, it is a non-event —
    // see the report gate below.
    String winner = "draw";
    if ( forfeitedBy.length() > 0 )
        winner = forfeitedBy == d.a.cleanName ? "b" : "a";
    else if ( d.a.bestTime != 0 && ( d.b.bestTime == 0 || d.a.bestTime < d.b.bestTime ) )
        winner = "a";
    else if ( d.b.bestTime != 0 && ( d.a.bestTime == 0 || d.b.bestTime < d.a.bestTime ) )
        winner = "b";

    String why = "";
    if ( reason == "map_change" )
        why = " (map change)";
    else if ( reason == "disconnect" )
        why = " (opponent left)";
    else if ( reason == "forfeit" )
        why = " (forfeit)";

    // Tell each side its own result. Whoever is still here is the only one who
    // can be told, which is exactly right for the disconnect case.
    for ( uint i = 0; i < 2; i++ )
    {
        // if/else rather than a ternary: a conditional over a script class
        // copy-constructs, and these have to be the duel's own sides.
        DuelSide@ you;
        DuelSide@ them;
        if ( i == 0 )
        {
            @you = @d.a;
            @them = @d.b;
        }
        else
        {
            @you = @d.b;
            @them = @d.a;
        }
        String youAre = i == 0 ? "a" : "b";

        if ( d.a.bestTime == 0 && d.b.bestTime == 0 )
        {
            you.print( S_COLOR_YELLOW + "DUEL OVER" + S_COLOR_WHITE + " vs " + them.displayName
                    + S_COLOR_WHITE + " - neither of you finished, so nothing was recorded.\n" );
            continue;
        }

        String verdict;
        if ( winner == "draw" )
            verdict = S_COLOR_YELLOW + "DRAW";
        else if ( winner == youAre )
            verdict = S_COLOR_GREEN + "YOU WIN";
        else
            verdict = S_COLOR_RED + "YOU LOSE";

        String mine = you.bestTime == 0 ? "no time" : RACE_TimeToString( you.bestTime );
        String theirs = them.bestTime == 0 ? "no time" : RACE_TimeToString( them.bestTime );

        you.print( verdict + S_COLOR_WHITE + " - " + mine + " vs " + theirs + " (" + them.displayName
                + S_COLOR_WHITE + ") on " + d.mapName + S_COLOR_WHITE + why + "\n" );
    }

    RACE_DuelReport( d, winner, reason );
}

// POST a concluded duel to the central API so it appears on both profiles.
// Fire-and-forget, same posture as the finish and flag reports: a duel that
// fails to deliver is a duel that is not on the website, and there is nothing
// useful to say to the players about that.
void RACE_DuelReport( Duel@ d, const String &in winner, const String &in reason )
{
    if ( rsApiDuelUrl.string.length() == 0 )
        return;

    // A duel neither player finished is a non-event: two people stood on a map
    // and the map changed. Recording it would put an empty row on two profiles.
    if ( d.a.bestTime == 0 && d.b.bestTime == 0 )
        return;

    uint durationMs = levelTime > d.startedAt ? levelTime - d.startedAt : 0;

    RS_ApiReportDuel( rsApiDuelUrl.string, rsApiToken.string, rsApiVersion.string,
            d.mapName,
            d.a.displayName, d.a.login, int( d.a.bestTime ), int( d.a.finishes ),
            d.b.displayName, d.b.login, int( d.b.bestTime ), int( d.b.finishes ),
            winner, reason, int( durationMs / 1000 ) );
}


// --- live scoring --------------------------------------------------------

// A player finished a race. Called from Player::completeRace for genuine
// (non-practice) finishes only, so practice runs, cancelled runs and puppets
// never reach here.
//
// This is the whole of the scoring model: a counted finish that beats your own
// duel best becomes your best, and the faster best is the lead.
void RACE_DuelFinish( Player@ player, uint finishTime )
{
    if ( @player == null || @player.client == null )
        return;

    String clean = RACE_DuelCleanName( player.client );
    Duel@ d = RACE_DuelFor( clean );
    if ( @d == null )
        return;

    DuelSide@ you = d.side( clean );
    DuelSide@ them = d.other( clean );
    if ( @you == null || @them == null )
        return;

    // Wrong direction: "/reverse" is a different leaderboard, so the run is
    // real but it is not this duel's race. Say so once — repeating it every lap
    // of a reverse practice session would be worse than saying nothing.
    if ( player.reversed != d.reversed )
    {
        if ( !you.warnedDirection )
        {
            you.warnedDirection = true;
            you.print( S_COLOR_ORANGE + "That run does not count for your duel - it is on "
                    + S_COLOR_WHITE + d.mapName + S_COLOR_ORANGE + ". Use "
                    + S_COLOR_YELLOW + "/reverse" + S_COLOR_ORANGE + " to switch back.\n" );
        }
        return;
    }

    // Keep the display name fresh off the finish: a player who changes name
    // mid-duel keeps their clean-name identity (that is what the whole module
    // keys on) but should be reported and printed under what they race as.
    you.displayName = player.client.name;
    you.finishes++;

    bool ledBefore = you.bestTime != 0 && ( them.bestTime == 0 || you.bestTime < them.bestTime );

    // Not an improvement on your own duel best: the player already saw their
    // run time, and the standings did not move. Stay quiet.
    if ( you.bestTime != 0 && finishTime >= you.bestTime )
        return;

    you.bestTime = finishTime;
    bool ledAfter = them.bestTime == 0 || you.bestTime < them.bestTime;
    bool level = them.bestTime != 0 && you.bestTime == them.bestTime;

    if ( them.bestTime == 0 )
    {
        you.print( S_COLOR_GREEN + "DUEL: you set the pace - " + S_COLOR_WHITE
                + RACE_TimeToString( you.bestTime ) + S_COLOR_GREEN + ". "
                + them.displayName + S_COLOR_GREEN + " has not finished yet.\n" );
        them.print( S_COLOR_YELLOW + "DUEL: " + you.displayName + S_COLOR_YELLOW + " has set "
                + S_COLOR_WHITE + RACE_TimeToString( you.bestTime ) + S_COLOR_YELLOW
                + " - you have not finished yet.\n" );
    }
    else if ( level )
    {
        String msg = S_COLOR_YELLOW + "DUEL: dead level at " + S_COLOR_WHITE
                + RACE_TimeToString( you.bestTime ) + S_COLOR_YELLOW + ".\n";
        you.print( msg );
        them.print( msg );
    }
    else if ( ledAfter && !ledBefore )
    {
        uint gap = them.bestTime - you.bestTime;
        you.print( S_COLOR_GREEN + "DUEL: YOU TAKE THE LEAD - " + S_COLOR_WHITE
                + RACE_TimeToString( you.bestTime ) + S_COLOR_GREEN + ", "
                + RACE_TimeToString( gap ) + " ahead of " + them.displayName + "\n" );
        them.print( S_COLOR_RED + "DUEL: " + you.displayName + S_COLOR_RED + " TAKES THE LEAD - "
                + S_COLOR_WHITE + RACE_TimeToString( you.bestTime ) + S_COLOR_RED + ", "
                + RACE_TimeToString( gap ) + " ahead of your " + RACE_TimeToString( them.bestTime ) + "\n" );
    }
    else if ( ledAfter )
    {
        uint gap = them.bestTime - you.bestTime;
        you.print( S_COLOR_GREEN + "DUEL: new best " + S_COLOR_WHITE + RACE_TimeToString( you.bestTime )
                + S_COLOR_GREEN + " - lead out to " + RACE_TimeToString( gap ) + "\n" );
        them.print( S_COLOR_YELLOW + "DUEL: " + you.displayName + S_COLOR_YELLOW + " improves to "
                + S_COLOR_WHITE + RACE_TimeToString( you.bestTime ) + S_COLOR_YELLOW + " - you are "
                + RACE_TimeToString( gap ) + " behind\n" );
    }
    else
    {
        uint gap = you.bestTime - them.bestTime;
        you.print( S_COLOR_YELLOW + "DUEL: new best " + S_COLOR_WHITE + RACE_TimeToString( you.bestTime )
                + S_COLOR_YELLOW + " - still " + RACE_TimeToString( gap ) + " behind "
                + them.displayName + "\n" );
        them.print( S_COLOR_YELLOW + "DUEL: " + you.displayName + S_COLOR_YELLOW + " improves to "
                + S_COLOR_WHITE + RACE_TimeToString( you.bestTime ) + S_COLOR_YELLOW + " - you still lead by "
                + RACE_TimeToString( gap ) + "\n" );
    }
}


// --- presence sweep ------------------------------------------------------

// Rebind one side to whoever currently holds its name, and report whether that
// player is present. This is the single place that decides presence: the slot
// cached on the side is only ever a hint, and a reconnecting player who lands
// in a different slot is picked up here with no special case.
bool RACE_DuelRebind( DuelSide@ side )
{
    Client@ client = RACE_DuelClientByClean( side.cleanName );
    if ( @client == null )
    {
        side.slot = -1;
        return false;
    }
    side.slot = client.playerNum;
    side.displayName = client.name;
    if ( side.login.length() == 0 )
        side.login = client.getMMLogin();
    return true;
}

// Presence, grace and invite expiry. Throttled: everything it watches moves on
// human timescales, and it walks every duel against every client slot.
void RACE_DuelThink()
{
    if ( raceDuelLastThink != 0 && levelTime - raceDuelLastThink < DUEL_THINK_INTERVAL_MS )
        return;
    raceDuelLastThink = levelTime == 0 ? 1 : levelTime;

    // Expire invitations, and drop any whose sender or recipient has gone.
    for ( int i = int( raceDuelInvites.length() ) - 1; i >= 0; i-- )
    {
        DuelInvite@ inv = raceDuelInvites[ uint( i ) ];
        Client@ from = RACE_DuelClientByClean( inv.fromClean );
        Client@ to = RACE_DuelClientByClean( inv.toClean );

        if ( @from == null || @to == null )
        {
            // Whoever is still here is told, so a challenge does not just
            // silently evaporate when the other player leaves.
            if ( @from != null )
                from.printMessage( S_COLOR_ORANGE + "Your duel challenge to " + inv.toDisplay
                        + S_COLOR_ORANGE + " lapsed - they left the server.\n" );
            else if ( @to != null )
                to.printMessage( S_COLOR_ORANGE + "The duel challenge from " + inv.fromDisplay
                        + S_COLOR_ORANGE + " lapsed - they left the server.\n" );
            raceDuelInvites.removeAt( uint( i ) );
            continue;
        }

        if ( levelTime - inv.sentAt >= DUEL_INVITE_TTL_MS )
        {
            from.printMessage( S_COLOR_ORANGE + "Your duel challenge to " + inv.toDisplay
                    + S_COLOR_ORANGE + " expired unanswered.\n" );
            to.printMessage( S_COLOR_ORANGE + "The duel challenge from " + inv.fromDisplay
                    + S_COLOR_ORANGE + " expired.\n" );
            raceDuelInvites.removeAt( uint( i ) );
        }
    }

    uint graceMs = uint( rs_duel_grace.integer < 0 ? 0 : rs_duel_grace.integer ) * 1000;

    for ( int i = int( raceDuels.length() ) - 1; i >= 0; i-- )
    {
        Duel@ d = raceDuels[ uint( i ) ];
        if ( d.over )
        {
            raceDuels.removeAt( uint( i ) );
            continue;
        }

        for ( uint s = 0; s < 2; s++ )
        {
            DuelSide@ side;
            DuelSide@ opp;
            if ( s == 0 )
            {
                @side = @d.a;
                @opp = @d.b;
            }
            else
            {
                @side = @d.b;
                @opp = @d.a;
            }

            bool here = RACE_DuelRebind( side );

            if ( here && side.goneSince != 0 )
            {
                // Back inside the grace period: the duel simply carries on, with
                // whatever times they had already set.
                side.goneSince = 0;
                side.print( S_COLOR_GREEN + "Welcome back - your duel with " + opp.displayName
                        + S_COLOR_GREEN + " is still on.\n" );
                opp.print( S_COLOR_GREEN + side.displayName + S_COLOR_GREEN
                        + " reconnected - the duel is back on.\n" );
                side.print( RACE_DuelScoreLine( d, side ) );
                opp.print( RACE_DuelScoreLine( d, opp ) );
            }
            else if ( !here && side.goneSince == 0 )
            {
                side.goneSince = levelTime == 0 ? 1 : levelTime;
                if ( graceMs > 0 )
                    opp.print( S_COLOR_ORANGE + side.displayName + S_COLOR_ORANGE
                            + " left - the duel is held for " + RACE_DuelCountdown( graceMs / 1000 )
                            + " in case they come back.\n" );
            }
        }

        // Concluded by absence: one of them ran out of grace. Checked after
        // both sides are rebound so a swap of slots inside one sweep cannot be
        // read as a disconnect.
        bool aTimedOut = d.a.goneSince != 0 && levelTime - d.a.goneSince >= graceMs;
        bool bTimedOut = d.b.goneSince != 0 && levelTime - d.b.goneSince >= graceMs;
        if ( aTimedOut || bTimedOut )
        {
            RACE_DuelConclude( d, "disconnect", "" );
            raceDuels.removeAt( uint( i ) );
        }
    }
}

// Every live duel ends here when the map does. Called from the WAITEXIT
// transition (the reliable one: script globals are about to be reset) and again
// from GT_Shutdown, which covers a server stopped mid-map. The `over` flag makes
// the second call a no-op.
void RACE_DuelMapEnded()
{
    for ( uint i = 0; i < raceDuels.length(); i++ )
        RACE_DuelConclude( raceDuels[i], "map_change", "" );
    raceDuels.resize( 0 );
    raceDuelInvites.resize( 0 );
}


// --- commands ------------------------------------------------------------

// "/duel"            - the score of the duel you are in, or the challenges
//                      waiting for you, or how to start one.
// "/duel <player>"   - challenge a connected player, matched on their name with
//                      colour codes stripped (so "/duel tud" finds "^3tudduf").
bool Cmd_Duel( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( @client == null )
        return false;

    String clean = RACE_DuelCleanName( client );
    String pattern = argsString.getToken( 0 );

    if ( pattern.length() == 0 )
        return RACE_DuelStatus( client, clean );

    Duel@ mine = RACE_DuelFor( clean );
    if ( @mine != null )
    {
        DuelSide@ them = mine.other( clean );
        client.printMessage( S_COLOR_RED + "You are already duelling " + them.displayName
                + S_COLOR_RED + ". Use " + S_COLOR_YELLOW + "/forfeit" + S_COLOR_RED
                + " to end it first.\n" );
        return false;
    }

    if ( !RACE_DuelEligible( client ) )
    {
        client.printMessage( S_COLOR_RED + "You cannot start a duel right now.\n" );
        return false;
    }

    if ( raceDuels.length() >= DUEL_MAX )
    {
        client.printMessage( S_COLOR_RED + "There are already " + DUEL_MAX
                + " duels running on this server - wait for one to finish.\n" );
        return false;
    }

    int pn = client.playerNum;
    if ( raceDuelLastInvite[pn] != 0 && levelTime - raceDuelLastInvite[pn] < DUEL_INVITE_COOLDOWN_MS )
    {
        client.printMessage( S_COLOR_RED + "Slow down - wait a moment before challenging again.\n" );
        return false;
    }

    // Colour-stripped partial match against connected players; prints its own
    // "no match" / "multiple matched" and returns null.
    Player@ target = RACE_GetPlayer( client ).oneMatchingPlayer( pattern );
    if ( @target == null )
        return false;

    Client@ to = target.client;
    if ( to is client )
    {
        client.printMessage( S_COLOR_RED + "You cannot duel yourself.\n" );
        return false;
    }

    // Mirror bots stand in for players on a PEER server and the TV camera is not
    // a player: neither can accept, and neither produces finishes here.
    if ( !RACE_DuelEligible( to ) )
    {
        client.printMessage( to.name + S_COLOR_RED + " cannot be duelled"
                + ( RACE_IsPuppet( to ) ? " - they are playing on another server in the mesh" : "" ) + ".\n" );
        return false;
    }

    String toClean = RACE_DuelCleanName( to );
    if ( @RACE_DuelFor( toClean ) != null )
    {
        client.printMessage( to.name + S_COLOR_RED + " is already in a duel.\n" );
        return false;
    }

    if ( RACE_DuelFindInvite( clean, toClean ) >= 0 )
    {
        client.printMessage( S_COLOR_ORANGE + "You have already challenged " + to.name
                + S_COLOR_ORANGE + " - waiting for an answer.\n" );
        return false;
    }

    // They already challenged US: accept theirs rather than sending a second
    // invitation past it, which is what both players clearly mean.
    int theirs = RACE_DuelFindInvite( toClean, clean );
    if ( theirs >= 0 )
    {
        raceDuelInvites.removeAt( uint( theirs ) );
        RACE_DuelBegin( to, client );
        return true;
    }

    if ( raceDuelInvites.length() >= DUEL_INVITES_MAX )
    {
        client.printMessage( S_COLOR_RED + "Too many duel challenges are pending - try again shortly.\n" );
        return false;
    }

    raceDuelLastInvite[pn] = levelTime == 0 ? 1 : levelTime;

    DuelInvite@ invite = DuelInvite();
    invite.fromClean = clean;
    invite.fromDisplay = client.name;
    invite.toClean = toClean;
    invite.toDisplay = to.name;
    invite.sentAt = levelTime;
    raceDuelInvites.insertLast( invite );

    bool reversed = RACE_GetPlayer( client ).reversed;
    String mapName = RACE_EffectiveMapName( reversed );

    client.printMessage( S_COLOR_GREEN + "Duel challenge sent to " + to.name + S_COLOR_GREEN
            + " on " + S_COLOR_WHITE + mapName + S_COLOR_GREEN + " - they have "
            + ( DUEL_INVITE_TTL_MS / 1000 ) + "s to answer.\n" );
    to.printMessage( S_COLOR_YELLOW + client.name + S_COLOR_YELLOW + " challenges you to a duel on "
            + S_COLOR_WHITE + mapName + S_COLOR_YELLOW + "!\n" );
    to.printMessage( S_COLOR_WHITE + "Type " + S_COLOR_GREEN + "/accept" + S_COLOR_WHITE + " or "
            + S_COLOR_RED + "/decline" + S_COLOR_WHITE + " - fastest time when the map changes wins.\n" );
    return true;
}

// "/duel" with no argument: the score, the pending challenges, or the pitch.
bool RACE_DuelStatus( Client@ client, const String &in clean )
{
    Duel@ d = RACE_DuelFor( clean );
    if ( @d != null )
    {
        DuelSide@ you = d.side( clean );
        DuelSide@ them = d.other( clean );
        client.printMessage( RACE_DuelScoreLine( d, you ) );
        client.printMessage( S_COLOR_WHITE + "Runs: you " + you.finishes + ", them " + them.finishes
                + S_COLOR_WHITE + ".  " + S_COLOR_YELLOW + "/forfeit" + S_COLOR_WHITE + " to concede.\n" );
        if ( them.goneSince != 0 )
        {
            uint graceMs = uint( rs_duel_grace.integer < 0 ? 0 : rs_duel_grace.integer ) * 1000;
            uint goneMs = levelTime - them.goneSince;
            uint leftMs = goneMs >= graceMs ? 0 : graceMs - goneMs;
            client.printMessage( S_COLOR_ORANGE + them.displayName + S_COLOR_ORANGE
                    + " is disconnected - " + RACE_DuelCountdown( leftMs / 1000 ) + " left to return.\n" );
        }
        return true;
    }

    uint[] incoming = RACE_DuelInvitesFor( clean );
    if ( incoming.length() > 0 )
    {
        client.printMessage( S_COLOR_YELLOW + "Duel challenges waiting for you:\n" );
        for ( uint i = 0; i < incoming.length(); i++ )
            client.printMessage( "  " + raceDuelInvites[ incoming[i] ].fromDisplay + S_COLOR_WHITE + "\n" );
        client.printMessage( S_COLOR_WHITE + "Answer with " + S_COLOR_GREEN + "/accept <name>"
                + S_COLOR_WHITE + " or " + S_COLOR_RED + "/decline <name>" + S_COLOR_WHITE
                + " (the name is optional when there is only one).\n" );
        return true;
    }

    client.printMessage( S_COLOR_YELLOW + "/duel <player>" + S_COLOR_WHITE
            + " - challenge someone to a 1v1 on this map. Fastest time when the map changes wins,\n" );
    client.printMessage( S_COLOR_WHITE + "and the result goes on both your profiles at racesow.org.\n" );
    return true;
}

// Resolve which pending invitation an /accept or /decline means. With one
// waiting the argument is optional; with several it is required and matched
// against the challenger's name the same way /duel matches a target.
int RACE_DuelPickInvite( Client@ client, const String &in clean, const String &in pattern )
{
    uint[] incoming = RACE_DuelInvitesFor( clean );
    if ( incoming.length() == 0 )
    {
        client.printMessage( S_COLOR_RED + "Nobody has challenged you to a duel.\n" );
        return -1;
    }

    if ( pattern.length() == 0 )
    {
        if ( incoming.length() == 1 )
            return int( incoming[0] );
        client.printMessage( S_COLOR_RED + "You have " + incoming.length()
                + " duel challenges - name one:\n" );
        for ( uint i = 0; i < incoming.length(); i++ )
            client.printMessage( "  " + raceDuelInvites[ incoming[i] ].fromDisplay + S_COLOR_WHITE + "\n" );
        return -1;
    }

    String want = pattern.removeColorTokens().tolower();
    int found = -1;
    uint hits = 0;
    for ( uint i = 0; i < incoming.length(); i++ )
    {
        if ( PatternMatch( raceDuelInvites[ incoming[i] ].fromClean, want ) )
        {
            found = int( incoming[i] );
            hits++;
        }
    }
    if ( hits == 0 )
    {
        client.printMessage( S_COLOR_RED + "No pending duel challenge matches \"" + pattern + "\".\n" );
        return -1;
    }
    if ( hits > 1 )
    {
        client.printMessage( S_COLOR_RED + "That matches more than one challenge - be more specific.\n" );
        return -1;
    }
    return found;
}

bool Cmd_DuelAccept( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( @client == null )
        return false;
    String clean = RACE_DuelCleanName( client );

    if ( @RACE_DuelFor( clean ) != null )
    {
        client.printMessage( S_COLOR_RED + "You are already in a duel - " + S_COLOR_YELLOW + "/forfeit"
                + S_COLOR_RED + " to end it first.\n" );
        return false;
    }

    int idx = RACE_DuelPickInvite( client, clean, argsString.getToken( 0 ) );
    if ( idx < 0 )
        return false;

    DuelInvite@ inv = raceDuelInvites[ uint( idx ) ];
    Client@ from = RACE_DuelClientByClean( inv.fromClean );
    if ( @from == null )
    {
        client.printMessage( S_COLOR_RED + inv.fromDisplay + S_COLOR_RED + " has left the server.\n" );
        raceDuelInvites.removeAt( uint( idx ) );
        return false;
    }

    // The challenger may have started a duel with somebody else while this one
    // sat unanswered — first accept wins, and this is the loser of that race.
    if ( @RACE_DuelFor( inv.fromClean ) != null )
    {
        client.printMessage( S_COLOR_RED + from.name + S_COLOR_RED + " has already started a duel with someone else.\n" );
        raceDuelInvites.removeAt( uint( idx ) );
        return false;
    }

    if ( raceDuels.length() >= DUEL_MAX )
    {
        client.printMessage( S_COLOR_RED + "There are too many duels running on this server right now.\n" );
        return false;
    }

    raceDuelInvites.removeAt( uint( idx ) );
    RACE_DuelBegin( from, client );
    return true;
}

bool Cmd_DuelDecline( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( @client == null )
        return false;
    String clean = RACE_DuelCleanName( client );

    int idx = RACE_DuelPickInvite( client, clean, argsString.getToken( 0 ) );
    if ( idx < 0 )
        return false;

    DuelInvite@ inv = raceDuelInvites[ uint( idx ) ];
    Client@ from = RACE_DuelClientByClean( inv.fromClean );
    client.printMessage( S_COLOR_WHITE + "You declined the duel from " + inv.fromDisplay + S_COLOR_WHITE + ".\n" );
    if ( @from != null )
        from.printMessage( client.name + S_COLOR_ORANGE + " declined your duel challenge.\n" );
    raceDuelInvites.removeAt( uint( idx ) );
    return true;
}

// Concede. The one path where the times do not decide the winner: a forfeit is
// a loss however fast you were, which is what makes it a concession rather than
// a way to bank a lead and walk away.
bool Cmd_DuelForfeit( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( @client == null )
        return false;
    String clean = RACE_DuelCleanName( client );

    Duel@ d = RACE_DuelFor( clean );
    if ( @d == null )
    {
        client.printMessage( S_COLOR_RED + "You are not in a duel.\n" );
        return false;
    }

    DuelSide@ them = d.other( clean );
    client.printMessage( S_COLOR_ORANGE + "You forfeited your duel against " + them.displayName + S_COLOR_ORANGE + ".\n" );
    them.print( client.name + S_COLOR_GREEN + " forfeited the duel.\n" );
    RACE_DuelConclude( d, "forfeit", clean );
    return true;
}
