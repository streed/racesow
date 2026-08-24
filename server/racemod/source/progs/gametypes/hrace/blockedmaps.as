// Live map blocklist from the central admin.
//
// A moderator can block a map in the web admin (map_block table), served at
// GET /api/game/blocked-maps as plain text, one lowercased map name per line.
// At restart server/entrypoint.sh already drops blocked maps from g_maplist,
// but between restarts a freshly blocked map would still be reachable by a
// vote. So the gametype also pulls the list live: every API_BLOCKED_REFRESH_MS
// it asks the RS_ApiFetchBlocked native to GET rs_api_blocked_url, and
// RACE_IsMapBlocked consults the parsed set. Every map-selecting path runs
// through GetMapsByPattern (randmap / meshvote / prerandmap / the /maps
// listing), which filters the blocklist out, so a block takes effect within one
// refresh interval instead of at the next restart. meshvote's explicit
// single-map path checks RACE_IsMapBlocked directly.
//
// RACE_IsMapBlocked also answers true for the base game's own non-race maps,
// which are never playable here for reasons that have nothing to do with a
// moderator — see RACE_IsStockNonRaceMap below.
//
// Fail-open by design: if rs_api_blocked_url is empty or the API is
// unreachable, RACE_IsMapBlocked returns false for the moderator half and
// nothing there is filtered — a network blip must never freeze map voting, and
// the restart-time filter in entrypoint.sh stays the durable backstop. The list
// is only ever replaced by a fresh successful fetch, never cleared by a failure.

Cvar rsApiBlockedUrl( "rs_api_blocked_url", "", 0 );

const uint API_BLOCKED_REFRESH_MS = 30 * 1000;
// 0 = no fetch yet this map, so the first think frame fires one immediately;
// then one per refresh interval (same levelTime idiom as apiTopLastFetch).
uint apiBlockedLastFetch = 0;
String[] raceBlockedMaps; // lowercased, colour-stripped map names currently blocked

// --- Base-game maps that are not race maps -----------------------------------
//
// Every selection path enumerates the ENGINE's map list (ML_GetMapByNum), which
// is every installed .bsp — so since the idle cycle was widened from the curated
// mappool to "every installed map" (maprotate.as, 2026-08-20) the maps that ship
// with Warsow/Warfork themselves have been in the draw alongside the ~4,600 race
// maps. Two problems, one of them fatal:
//
//   - wtutorial1 (Warsow) and wftutorial1 (Warfork) each ship a
//     progs/maps/<name>.as whose MAP_Gametype() hook returns "tutorial". The
//     engine honours it, switches g_gametype and reloads the gametype — which
//     unloads THIS script. Nothing of ours runs after that: no idle rotation to
//     move off the map, and no mirror publish, so the box silently drops out of
//     the mesh and stays there until a human restarts it. US Warfork drew
//     wftutorial1 on 2026-08-21 and sat out of the mesh for three days.
//   - the rest (wdm*/wfdm*, ctf, bomb, duel arenas, and `ui`, which is a menu
//     backdrop rather than a level) have no start/finish triggers at all, so
//     drawing one parks an idle server on ten minutes of nothing raceable. Both
//     boxes did this several times a day.
//
// wrace1/wfrace1 are the stock RACE maps and deliberately stay in the pool —
// wrace1 has real records. The list is explicit rather than a "w*"-prefix rule
// so a community map can never be excluded by an accident of naming; these names
// come from the shipped basewsw/basewf pk3s and only move when the game itself
// does. Unlike the moderator list this rule is local, permanent and never
// fail-open: it needs no fetch, so it holds on a server with no INGEST_URL.
//
// The engine's own built-in `callvote map` does not come through here (it never
// consulted the blocklist either), so gamehealth.sh carries the matching
// recovery half: it reads the gametype back out of getinfo and bounces an engine
// that is no longer running ours.

// Parsed once per script load (script globals reset on every map), then reused
// for the whole pool walk — ~4,600 lookups per rotation or wildcard vote.
String[] raceStockNonRaceMaps;

// True if <mapName> is one of the base game's own non-race maps. Case
// insensitive, colour tokens stripped — same contract as RACE_IsMapBlocked,
// which folds this in.
//
// The names live in a local built by concatenation rather than a const global:
// Warsow's AngelScript (2.29) is the stricter of the two engines this same
// source has to compile under, and a plain local expression is the form both
// accept without question (see server/test/boot-test.sh on why "it built" says
// nothing about whether it compiles).
bool RACE_IsStockNonRaceMap( const String &in mapName )
{
    if ( raceStockNonRaceMaps.length() == 0 )
    {
        String list = "ui "
            + "wamphi1 wbomb1 wbomb2 wbomb3 wbomb4 wbomb5 wbomb6 wca1 "
            + "wctf1 wctf2 wctf3 wctf4 wctf6 wda1 wda2 wda3 wda4 wda5 "
            + "wdm1 wdm2 wdm4 wdm5 wdm6 wdm7 wdm9 wdm10 wdm11 wdm12 wdm13 "
            + "wdm14 wdm15 wdm16 wdm17 wdm18 wdm19 wtutorial1 "
            + "wfamphi1 wfbomb1 wfbomb2 wfbomb3 wfbomb4 wfbomb5 wfbomb6 "
            + "wfca1 wfca2 wfctf1 wfctf2 wfctf3 wfctf4 wfctf5 wfctf6 "
            + "wfda1 wfda2 wfda3 wfda4 wfda5 "
            + "wfdm1 wfdm2 wfdm3 wfdm4 wfdm5 wfdm6 wfdm7 wfdm8 wfdm9 wfdm10 "
            + "wfdm11 wfdm12 wfdm13 wfdm14 wfdm15 wfdm16 wfdm17 wfdm18 "
            + "wfdm19 wfdm20 wftutorial1";
        for ( int i = 0; ; i++ )
        {
            String tok = list.getToken( i );
            if ( tok.length() == 0 )
                break;
            raceStockNonRaceMaps.insertLast( tok );
        }
    }

    String key = mapName.removeColorTokens().tolower();
    for ( uint i = 0; i < raceStockNonRaceMaps.length(); i++ )
    {
        if ( raceStockNonRaceMaps[i] == key )
            return true;
    }
    return false;
}

// True if <mapName> may not be played here: on the live moderator blocklist, or
// one of the base game's own non-race maps (see RACE_IsStockNonRaceMap above —
// that half is local and permanent, never fail-open). Case-insensitive; colour
// tokens stripped. Folding both into this one predicate is deliberate: every
// path that asks "may this map be selected" — the pool walks in utils.as, the
// idle rotation and the follow-the-busy-server target in maprotate.as, and
// meshvote's three explicit single-map gates — already funnels through here, and
// each of them wants the same answer for both reasons.
//
// Fail-open on the moderator half only: an empty / unfetched / unconfigured list
// blocks nothing.
bool RACE_IsMapBlocked( const String &in mapName )
{
    if ( RACE_IsStockNonRaceMap( mapName ) )
        return true;
    if ( raceBlockedMaps.length() == 0 )
        return false;
    String key = mapName.removeColorTokens().tolower();
    for ( uint i = 0; i < raceBlockedMaps.length(); i++ )
    {
        if ( raceBlockedMaps[i] == key )
            return true;
    }
    return false;
}

// Why a map RACE_IsMapBlocked refused is unavailable, as one line of
// player-facing text. The two halves want different words: a moderator block is
// a decision that can be reversed ("right now"), while a base-game non-race map
// is simply not the kind of map this server plays and never will be.
String RACE_MapBlockedReason( const String &in mapName )
{
    if ( RACE_IsStockNonRaceMap( mapName ) )
        return "Map '" + mapName + "' ships with the base game and is not a race map.\n";
    return "Map '" + mapName + "' is blocked and can't be voted right now.\n";
}

// Rebuild raceBlockedMaps from the fetched payload. getToken() splits on any
// whitespace, so it handles the one-name-per-line format regardless of \n vs
// \r\n line endings and ignores blank lines. A malformed 200 body can't
// over-block: the native already rejects HTML, and any stray token that is not
// an actual map name simply never matches in RACE_IsMapBlocked.
void RACE_ParseBlockedList( const String &in text )
{
    raceBlockedMaps.resize( 0 );
    // getToken() returns "" once the index passes the last token (same idiom as
    // the vote arg parsing). The cap is a defensive backstop against a
    // pathological payload — no server blocks anywhere near this many maps.
    for ( int i = 0; i < 10000; i++ )
    {
        String tok = text.getToken( i );
        if ( tok.length() == 0 )
            break;
        raceBlockedMaps.insertLast( tok.removeColorTokens().tolower() );
    }
}

// Poll for a freshly-fetched list and refresh on the periodic interval. Called
// from GT_ThinkRules; a no-op when rs_api_blocked_url is unset.
void RACE_ApiBlockedThink()
{
    if ( rsApiBlockedUrl.string.length() == 0 )
        return;

    if ( apiBlockedLastFetch == 0 )
    {
        // First think after the gametype script (re)loaded — which happens every
        // map, resetting raceBlockedMaps to empty. The native worker's fetched
        // copy lives in the game module, which persists across that per-map
        // script reload, so seed from it right away: without this there is a
        // window at the start of every map where nothing is blocked while the
        // fresh fetch below round-trips. Empty (never fetched yet) => fail-open.
        String seed = RS_BlockedListText();
        RACE_ParseBlockedList( seed );
    }

    if ( RS_ApiPollBlocked() == 1 )
    {
        String payload = RS_BlockedListText();
        RACE_ParseBlockedList( payload );
    }

    if ( apiBlockedLastFetch == 0 || levelTime - apiBlockedLastFetch >= API_BLOCKED_REFRESH_MS )
    {
        apiBlockedLastFetch = levelTime == 0 ? 1 : levelTime;
        // empty token: the endpoint is public (same as topscores), so the ingest
        // write-credential has no business riding along on this request.
        RS_ApiFetchBlocked( rsApiBlockedUrl.string, "" );
    }
}
