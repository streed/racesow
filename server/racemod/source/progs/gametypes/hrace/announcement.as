// Rotating in-game announcements, editable live from the web admin.
//
// An admin edits the message list at /admin/announcements, served at
// GET /api/game/announcements as plain text (an "RSANN" header line, then one
// message per line). Every API_ANNOUNCE_REFRESH_MS the RS_ApiFetchAnnounce
// native re-fetches the list; when a CHANGED payload lands the messages are
// re-parsed. Every rs_announce_interval seconds one message is broadcast to
// everyone (round-robin), so players get a steady, low-frequency nudge toward
// the website and other news. Same fetch/poll/text shape as motd.as /
// lastmaps.as; the messages carry Warsow ^colors verbatim (the /colors page on
// the website helps admins compose them).
//
// Fail-open and quiet by design: a no-op when rs_api_announce_url is empty,
// silent when the list is empty or no real player is connected (an idle box
// shouldn't fill its console log), and a network blip leaves the last good list
// in place.

Cvar rsApiAnnounceUrl( "rs_api_announce_url", "", 0 );
// Seconds between broadcasts; 0 disables the rotation. Archived so it can be
// tuned or muted per box without a rebuild (the .as recompiles at server boot,
// not at Docker build time).
Cvar rs_announce_interval( "rs_announce_interval", "600", CVAR_ARCHIVE );

const uint API_ANNOUNCE_REFRESH_MS = 60 * 1000;
// 0 = no fetch yet this map, so the first think frame fires one immediately;
// then one per refresh interval (same levelTime idiom as apiMotdLastFetch).
uint apiAnnounceLastFetch = 0;

String[] raceAnnounceMsgs;              // one message per line, in rotation order
String raceAnnounceParsedText = "";    // last payload parsed (skip an identical re-parse)
uint raceAnnounceIdx = 0;              // next message to broadcast

// Wall-clock deadline (realTime, ms) for the next broadcast. realTime (not
// levelTime) keeps the cadence steady across map changes and match states,
// matching RACE_MirrorPresenceTick.
uint raceAnnounceNext = 0;

// Rebuild raceAnnounceMsgs from the fetched payload. Splits on NEWLINES only:
// messages contain spaces, so getToken()'s whitespace split (used by
// lastmaps/blockedmaps for space-free map names) is wrong here — use the same
// locate("\n") idiom as the ranks parser instead. Blank lines are skipped; the
// cap is a defensive backstop (the web already caps the list length).
void RACE_ParseAnnouncements( const String &in text )
{
    raceAnnounceMsgs.resize( 0 );
    uint total = text.length();
    uint pos = 0;
    while ( pos < total && raceAnnounceMsgs.length() < 32 )
    {
        // RACE_LocateFrom returns the string length when "\n" isn't found, so
        // the final unterminated line still gets read (same idiom as ranks.as).
        uint nl = RACE_LocateFrom( text, "\n", pos );
        if ( nl > total )
            nl = total;
        String line = text.substr( pos, nl - pos );
        pos = nl + 1;
        if ( line.length() == 0 )
            continue;
        raceAnnounceMsgs.insertLast( line );
    }
    if ( raceAnnounceIdx >= raceAnnounceMsgs.length() )
        raceAnnounceIdx = 0;
}

// Poll for a freshly-fetched list, refresh on the periodic interval, and
// broadcast on the rotation interval. Called from GT_ThinkRules; a no-op when
// rs_api_announce_url is unset.
void RACE_ApiAnnounceThink()
{
    if ( rsApiAnnounceUrl.string.length() == 0 )
        return;

    if ( apiAnnounceLastFetch == 0 )
    {
        // First think after the per-map script reload (which resets the array):
        // seed from the game module's persisted copy so a message can rotate
        // right away, before the fresh fetch below round-trips. Empty (never
        // fetched) => the array stays empty and nothing is broadcast yet.
        String seed = RS_AnnounceText();
        if ( seed != raceAnnounceParsedText )
        {
            raceAnnounceParsedText = seed;
            RACE_ParseAnnouncements( seed );
        }
    }

    if ( RS_ApiPollAnnounce() == 1 )
    {
        String payload = RS_AnnounceText();
        raceAnnounceParsedText = payload;
        RACE_ParseAnnouncements( payload );
    }

    if ( apiAnnounceLastFetch == 0 || levelTime - apiAnnounceLastFetch >= API_ANNOUNCE_REFRESH_MS )
    {
        apiAnnounceLastFetch = levelTime == 0 ? 1 : levelTime;
        // empty token: the endpoint is public (same as motd / blocked-maps).
        RS_ApiFetchAnnounce( rsApiAnnounceUrl.string, "" );
    }

    RACE_AnnounceBroadcastTick();
}

// Broadcast the next message on the rotation interval and advance round-robin.
// Silent when the rotation is disabled, the list is empty, or the box has no
// real players (the WR ghost and mesh bots are fake clients).
void RACE_AnnounceBroadcastTick()
{
    int interval = rs_announce_interval.integer;
    if ( interval <= 0 )
        return;

    // First eligible frame after (re)start: arm the timer instead of firing
    // instantly, so the first message lands a full interval in rather than the
    // moment a map loads.
    if ( raceAnnounceNext == 0 )
    {
        raceAnnounceNext = realTime + uint( interval ) * 1000;
        return;
    }

    if ( realTime < raceAnnounceNext )
        return;
    // Re-arm even when we skip the print below, so an idle stretch doesn't fire
    // the instant someone joins mid-interval.
    raceAnnounceNext = realTime + uint( interval ) * 1000;

    if ( raceAnnounceMsgs.length() == 0 || RACE_RealPlayerCount() <= 0 )
        return;

    if ( raceAnnounceIdx >= raceAnnounceMsgs.length() )
        raceAnnounceIdx = 0;
    G_PrintMsg( null, raceAnnounceMsgs[raceAnnounceIdx] + "\n" );
    raceAnnounceIdx = ( raceAnnounceIdx + 1 ) % raceAnnounceMsgs.length();
}
