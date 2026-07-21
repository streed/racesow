// Live message of the day from the central admin.
//
// An admin edits the MOTD at /admin/motd, served at GET /api/game/motd as
// plain text (an "RSMOTD" header line, then the message — possibly empty,
// meaning "show no MOTD"). Every API_MOTD_REFRESH_MS this asks the
// RS_ApiFetchMotd native to GET rs_api_motd_url; when a CHANGED payload lands
// (the native dedupes, so poll only reports 1 on an actual edit) the text is
// written into the engine's sv_MOTDString cvar. The engine serves that cvar
// to every connecting client's "svmotd" request — re-read live per request
// thanks to enginepatches/patch-motd-live.py — so an edit shows to the very
// next connect, no restart or map change needed.
//
// Fail-open by design: if rs_api_motd_url is empty or the API is unreachable,
// sv_MOTDString simply keeps its current value (the server.cfg default before
// the first successful fetch, the last fetched text after) — a network blip
// must never blank the MOTD. No reseed-on-script-reload dance is needed here
// (contrast blockedmaps.as): the fetched state lives in an engine cvar, which
// survives map changes and gametype reloads on its own.

Cvar rsApiMotdUrl( "rs_api_motd_url", "", 0 );
Cvar rsMotdString( "sv_MOTDString", "", 0 );

const uint API_MOTD_REFRESH_MS = 60 * 1000;
// 0 = no fetch yet this map, so the first think frame fires one immediately;
// then one per refresh interval (same levelTime idiom as apiBlockedLastFetch).
uint apiMotdLastFetch = 0;

// Poll for a freshly-fetched MOTD and refresh on the periodic interval. Called
// from GT_ThinkRules; a no-op when rs_api_motd_url is unset.
void RACE_ApiMotdThink()
{
    if ( rsApiMotdUrl.string.length() == 0 )
        return;

    if ( RS_ApiPollMotd() == 1 )
    {
        // Empty is a real state (admin cleared it): the engine then sends no
        // MOTD popup at all. The native already stripped the RSMOTD header
        // and sanitized quotes/control characters.
        rsMotdString.set( RS_MotdText() );
    }

    if ( apiMotdLastFetch == 0 || levelTime - apiMotdLastFetch >= API_MOTD_REFRESH_MS )
    {
        apiMotdLastFetch = levelTime == 0 ? 1 : levelTime;
        // empty token: the endpoint is public (same as blocked-maps), so the
        // ingest write-credential has no business riding along on this request.
        RS_ApiFetchMotd( rsApiMotdUrl.string, "" );
    }
}
