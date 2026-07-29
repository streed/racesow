// Persistent per-player START position for a map, from the central stats API.
//
// A player picks where they want to begin a map with /savestart; it is stored in
// the central DB keyed by their clean nick + map + direction (race / reverse).
// The next time they join the server on that map they spawn right there instead
// of the map's default start — "start in the last place you saved".
//
// Two directions, one row each: /savestart in a normal prerace saves the "race"
// start; /savestart while reversed saves the "reverse" start (which /reverse then
// restores instead of its auto-computed spot). /clearstart forgets the saved
// start for the direction you're in.
//
// The GET (restore) mirrors playerrecord.as: a PER-PLAYER fetch on join, keyed by
// player slot via the RS_ApiFetchSavedStart native, so several joiners can be in
// flight at once. The API (web/db.js savedStartText) answers with a header then
// one line per saved direction:
//   //starts
//   race <x> <y> <z> <pitch> <yaw> <roll>
//   reverse <x> <y> <z> <pitch> <yaw> <roll>
// The think poller parses it, teleports the player to their race start on their
// first prerace spawn, and stashes the reverse start for /reverse. The save/clear
// direction is a fire-and-forget POST (RS_ApiSaveStart), same shape as /flag.
//
// Fail-open by design: no-op when the URLs are empty; a failed fetch or a "no
// saved start" answer leaves the player at the map default. Never applied to a
// reversed player as their race start, to mirror/TV puppets, or over a position
// the player has already saved by hand this session.

Cvar rsApiSavedStartGetUrl( "rs_api_savedstart_get_url", "", 0 );
Cvar rsApiSavedStartPostUrl( "rs_api_savedstart_post_url", "", 0 );

// Issue a per-player saved-start fetch for the current map on join. No-op when the
// feature is off, or for a fake client (mirror puppet / TV director). Keyed by the
// player's slot; the parsed result is applied later from the think loop.
void RACE_TriggerSavedStartFetch( Player@ player )
{
    if ( rsApiSavedStartGetUrl.string.length() == 0 )
        return;
    if ( player is null || player.client is null )
        return;
    if ( RACE_MirrorIsFakeClient( player.client ) || RACE_IsTvClient( player.client ) )
        return;

    String cleanName = player.client.name.removeColorTokens().tolower();
    if ( cleanName.length() == 0 )
        return;

    Cvar mapNameVar( "mapname", "", 0 );
    player.pendingSavedStartFetch = true;
    // Public endpoint, no token (like ranks / player-record). The native
    // URL-encodes the name (it can carry spaces / punctuation).
    RS_ApiFetchSavedStart( rsApiSavedStartGetUrl.string, "", mapNameVar.string.tolower(),
        cleanName, player.client.playerNum );
}

// Parse the "//starts" payload into the player's race / reverse start slots. Each
// data line is "<race|reverse> <x> <y> <z> <pitch> <yaw> <roll>"; getToken splits
// on any whitespace (so newlines are irrelevant) and the "//starts" header token
// is skipped. A missing direction leaves its slot invalid (nothing to restore).
void RACE_ParseSavedStarts( Player@ player, const String &in text )
{
    player.savedRaceStartValid = false;
    player.savedReverseStartValid = false;

    int i = 0;
    while ( true )
    {
        String tok = text.getToken( i );
        if ( tok.length() == 0 )
            break;
        if ( tok == "race" || tok == "reverse" )
        {
            Vec3 loc( text.getToken( i + 1 ).toFloat(), text.getToken( i + 2 ).toFloat(), text.getToken( i + 3 ).toFloat() );
            Vec3 ang( text.getToken( i + 4 ).toFloat(), text.getToken( i + 5 ).toFloat(), text.getToken( i + 6 ).toFloat() );
            if ( tok == "race" )
            {
                player.savedRaceStart.location = loc;
                player.savedRaceStart.angles = ang;
                player.savedRaceStartValid = true;
            }
            else
            {
                player.savedReverseStart.location = loc;
                player.savedReverseStart.angles = ang;
                player.savedReverseStartValid = true;
            }
            i += 7;
        }
        else
        {
            i += 1;
        }
    }
}

// Teleport the player to their saved RACE start, once, on a live prerace body.
// Captures the fresh spawn's health/armor/weapons via currentPosition() and only
// overrides origin + facing, so the player keeps a normal loadout — a saved start
// is a relocation, not a stored inventory. Populating slot 0 makes every later
// /kill / restart return here too. Guarded so it never fires for a reversed
// player, never overrides a hand-saved prerace spot, and never repeats.
void RACE_MaybeApplySavedStart( Player@ player )
{
    if ( player is null || player.client is null )
        return;
    if ( player.savedStartApplied || !player.savedRaceStartValid || player.reversed )
        return;
    if ( RACE_MirrorIsFakeClient( player.client ) )
        return;
    if ( !player.preRace() )
        return; // only from a clean prerace state (not mid-race / practice)

    Entity@ ent = player.client.getEnt();
    if ( @ent == null || ent.health <= 0 )
        return; // wait for a live body

    // The player already saved a prerace spot by hand this session — respect it.
    Position@ slot0 = player.preRacePositionStore.get( "" );
    if ( @slot0 != null && slot0.saved )
    {
        player.savedStartApplied = true;
        return;
    }

    Position p = player.currentPosition(); // fresh-spawn health/armor/weapons
    p.location = player.savedRaceStart.location;
    p.angles = player.savedRaceStart.angles;
    p.velocity = Vec3();
    p.saved = true;
    p.recalled = false;
    p.skipWeapons = false;
    player.preRacePositionStore.set( "", p );
    player.applyPosition( p );
    player.savedStartApplied = true;

    player.client.printMessage( S_COLOR_GREEN + "Spawned at your saved start for this map. " + S_COLOR_WHITE + "/clearstart" + S_COLOR_GREEN + " to forget it.\n" );
}

// Poll for landed per-player fetches and apply them; also retry the apply for a
// player whose start arrived while they were still a spectator / dead. Called
// from GT_ThinkRules; a no-op when the feature is off. Iterates racing players
// (a prerace player is on TEAM_PLAYERS), mirroring RACE_ApiPlayerRecordThink.
void RACE_ApiSavedStartThink()
{
    if ( rsApiSavedStartGetUrl.string.length() == 0 )
        return;

    Team@ team = G_GetTeam( TEAM_PLAYERS );
    for ( int i = 0; @team.ent( i ) != null; i++ )
    {
        Player@ player = RACE_GetPlayer( team.ent( i ).client );
        if ( player is null || player.client is null )
            continue;

        if ( player.pendingSavedStartFetch )
        {
            int result = RS_ApiPollSavedStart( player.client.playerNum );
            if ( result == 1 )
            {
                RACE_ParseSavedStarts( player, RS_SavedStartText( player.client.playerNum ) );
                player.pendingSavedStartFetch = false;
            }
            else if ( result == -1 )
            {
                player.pendingSavedStartFetch = false; // failed / none — stay at default
            }
        }

        // Apply once the player is a live prerace body (may be a frame or two
        // after the payload landed). Gated internally so this is cheap + one-shot.
        if ( player.savedRaceStartValid && !player.savedStartApplied )
            RACE_MaybeApplySavedStart( player );
    }
}

// Space-separated "x y z pitch yaw roll" for the POST body. Pure numbers, so the
// web can split + range-check them and there is no injection surface.
String RACE_SavedStartCoords( const Vec3 &in loc, const Vec3 &in ang )
{
    return "" + loc.x + " " + loc.y + " " + loc.z + " " + ang.x + " " + ang.y + " " + ang.z;
}

// /savestart - persist the player's current spot as their personal start for this
// map (race or reverse, depending on the direction they're in), and apply it
// locally so it takes effect immediately.
bool Cmd_SaveStart( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( rsApiSavedStartPostUrl.string.length() == 0 )
    {
        client.printMessage( S_COLOR_RED + "Saving a start is not available on this server.\n" );
        return false;
    }

    Player@ player = RACE_GetPlayer( client );
    if ( !player.preRace() )
    {
        client.printMessage( S_COLOR_RED + "You can only save your start before a run - not during a race or in practice mode. Use " + S_COLOR_WHITE + "/kill" + S_COLOR_RED + " first.\n" );
        return false;
    }

    // Reuse the prerace save: alive + standable-ground checks, and it writes the
    // prerace slot 0 (which in reverse mode is the reverse spawn). It prints its
    // own error on failure.
    if ( !player.savePosition( "" ) )
        return false;

    Position@ slot0 = player.preRacePositionStore.get( "" );
    if ( @slot0 == null || !slot0.saved )
        return false;

    bool reverse = player.reversed;
    // A hand save must win over a still-in-flight DB fetch for the race start.
    if ( !reverse )
        player.savedStartApplied = true;

    Cvar mapNameVar( "mapname", "", 0 );
    String mapName = mapNameVar.string.tolower();
    RS_ApiSaveStart( rsApiSavedStartPostUrl.string, rsApiToken.string, mapName,
        client.name, client.getMMLogin(), reverse ? "reverse" : "race",
        RACE_SavedStartCoords( slot0.location, slot0.angles ) );

    client.printMessage( S_COLOR_GREEN + "Saved your " + ( reverse ? "reverse " : "" ) + "start for "
        + S_COLOR_WHITE + mapName + S_COLOR_GREEN + " - you'll spawn here when you rejoin.\n" );
    return true;
}

// /clearstart - forget the saved start for the direction the player is in, both in
// the central DB (empty coords = delete) and locally for this session.
bool Cmd_ClearStart( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( rsApiSavedStartPostUrl.string.length() == 0 )
    {
        client.printMessage( S_COLOR_RED + "Saving a start is not available on this server.\n" );
        return false;
    }

    Player@ player = RACE_GetPlayer( client );
    bool reverse = player.reversed;

    Cvar mapNameVar( "mapname", "", 0 );
    String mapName = mapNameVar.string.tolower();
    // Empty coords => the web deletes the row for this (player, map, direction).
    RS_ApiSaveStart( rsApiSavedStartPostUrl.string, rsApiToken.string, mapName,
        client.name, client.getMMLogin(), reverse ? "reverse" : "race", "" );

    // Drop the local copy so future respawns this session use the map default.
    // Leave the player where they are (don't yank them mid-stand).
    if ( reverse )
        player.savedReverseStartValid = false;
    else
        player.savedRaceStartValid = false;
    if ( player.preRace() )
        player.preRacePositionStore.remove( "" );
    player.savedStartApplied = true;

    client.printMessage( S_COLOR_GREEN + "Cleared your " + ( reverse ? "reverse " : "" ) + "saved start for "
        + S_COLOR_WHITE + mapName + S_COLOR_GREEN + ".\n" );
    return true;
}
