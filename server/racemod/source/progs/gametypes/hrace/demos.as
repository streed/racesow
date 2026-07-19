// Per-client WR demo capture + ghost trajectory upload (replay feature).
//
// The engine's race-demos subsystem records a self-contained .wd of each run
// (Client::demoStart / demoStop / demoCancel, wired in player.as). On a new
// world record we:
//   1. tell the web where the .wd lives so it can offer a download, and
//   2. upload the 25 Hz trajectory captured in player.as so the site's browser
//      viewer and the in-game WR ghost racer (hrace/ghostbot.as) can replay it.
//
// Both reports go out through the RS_* natives in the patched game module
// (server/enginepatches/g_rs_api.cpp) on a background thread, so the game frame
// never blocks. Everything no-ops when its URL cvar is empty.

Cvar rsRecordDemos( "rs_record_demos", "1", 0 );
// POST target for ghost uploads (INGEST_URL/api/ingest/ghost); set by
// entrypoint.sh. Empty = ghost upload disabled.
Cvar rsApiGhostUrl( "rs_api_ghost_url", "", 0 );

// Must match player.as's GHOST_INTERVAL capture cadence — the web treats frame
// timing as implicit (frame i at i/hz seconds), so hz has to be the real rate.
const int GHOST_HZ = 1000 / GHOST_INTERVAL;

// The colour-stripped raw player name.
String RACE_DemoRawName( Client@ client )
{
    return client.name.removeColorTokens();
}

// Reduce a name to a URL-safe, engine-STABLE filename fragment: keep only
// [A-Za-z0-9_-], map any other printable ASCII to '_', drop control/non-ASCII.
// Because every output char is one the engine's SV_CleanDemoName keeps
// verbatim (none are junk/control), running the engine cleaner over THIS
// output is the identity — so when we hand this string to demoStart/demoStop
// the file the engine writes has exactly this fragment, and the path we report
// to the web matches byte-for-byte. This is stricter than the engine (which
// keeps { } # % etc.) on purpose: those break URLs and the web path check.
String RACE_DemoCleanName( const String &in raw )
{
    // NB: 'out' is an AngelScript keyword (&out params), so the accumulator is
    // named 'clean'. No character literals here either — compare byte values.
    String clean = "";
    for ( uint i = 0; i < raw.length(); i++ )
    {
        uint8 c = raw[i];
        // 0-9 = 0x30-0x39, A-Z = 0x41-0x5A, a-z = 0x61-0x7A, '_' = 0x5F, '-' = 0x2D.
        if ( ( c >= uint8( 0x30 ) && c <= uint8( 0x39 ) )
                || ( c >= uint8( 0x41 ) && c <= uint8( 0x5A ) )
                || ( c >= uint8( 0x61 ) && c <= uint8( 0x7A ) )
                || c == uint8( 0x5F ) || c == uint8( 0x2D ) )
            clean += raw.substr( i, 1 );
        else if ( c >= uint8( 0x20 ) && c < uint8( 0x7F ) )
            clean += "_"; // any other printable ASCII -> safe underscore
        // control / DEL / non-ASCII (>=0x80): dropped
    }
    if ( clean.length() == 0 )
        clean = "player";
    return clean;
}

// The name we actually hand to demoStart/demoStop — the cleaned form, so the
// engine's re-clean is a no-op and the on-disk name equals RACE_DemoRelPath's.
String RACE_DemoName( Client@ client )
{
    return RACE_DemoCleanName( RACE_DemoRawName( client ) );
}

String RACE_DemoPad( uint v, uint width )
{
    String s = "" + v;
    while ( s.length() < width )
        s = "0" + s;
    return s;
}

// SV_UintToTimeString: "MM-SS-mmm".
String RACE_DemoTimeString( uint millis )
{
    uint mins = millis / 60000;
    millis -= mins * 60000;
    uint secs = millis / 1000;
    millis -= secs * 1000;
    return RACE_DemoPad( mins, 2 ) + "-" + RACE_DemoPad( secs, 2 ) + "-" + RACE_DemoPad( millis, 3 );
}

// The demo path RELATIVE TO the served demos/ dir. The engine writes to
// demos/server/<map>/<map>_<clean>_<MM-SS-mmm>.wdz20; entrypoint.sh exports
// demos/server/* to the pak-mirror's demos/ root, so the web-visible path is
// "<map>/<map>_<clean>_<MM-SS-mmm>.wdz20" (two segments — matches the web's
// validDemoPath check).
String RACE_DemoRelPath( const String &in map, Client@ client, uint timeMs )
{
    return map + "/" + map + "_" + RACE_DemoName( client ) + "_" + RACE_DemoTimeString( timeMs ) + ".wdz20";
}

// Tell the web a new WR on this map has a downloadable demo (source "wr_demo").
void RACE_ReportWrDemo( Player@ player, uint finishTime )
{
    if ( rsApiUrl.string.length() == 0 )
        return;
    // Report under the variant name so a reversed PB's demo attaches to the
    // "<map>-reversed" level on the site. The on-disk demo path still uses the
    // physical BSP name (the engine writes demos/server/<bsp>/...), so build the
    // relative path from the real map name but report the effective one.
    Cvar mapNameVar( "mapname", "", 0 );
    String diskMap = mapNameVar.string.tolower();
    String map = RACE_EffectiveMapName( player.reversed );
    String relPath = RACE_DemoRelPath( diskMap, player.client, finishTime );
    RS_ApiReportWrDemo( rsApiUrl.string, rsApiToken.string, rsApiVersion.string,
            map, player.client.name, player.client.getMMLogin(),
            int( finishTime ), relPath );
}

// Upload the WR run's 25 Hz ghost trajectory. Streamed frame-by-frame into the
// native (RS_GhostBegin/Frame/End) so AngelScript never does an O(n^2) concat
// over thousands of frames. Positions/angles/velocities are truncated to ints
// (a ghost path needs no sub-unit precision).
void RACE_UploadWrGhost( Player@ player, uint finishTime )
{
    if ( rsApiGhostUrl.string.length() == 0 || player.bestGhostCount < 2 )
        return;

    RS_GhostBegin();
    for ( int i = 0; i < player.bestGhostCount; i++ )
    {
        Vec3 o = player.bestGhostOrigin[i];
        Vec3 a = player.bestGhostAngle[i];
        Vec3 v = player.bestGhostVel[i];
        RS_GhostFrame( int( o.x ), int( o.y ), int( o.z ),
                int( a.x ), int( a.y ), int( a.z ),
                int( v.x ), int( v.y ), int( v.z ),
                player.bestGhostKeys[i] );
    }

    String cps = "";
    for ( int i = 0; i < player.bestGhostCpCount; i++ )
    {
        if ( i > 0 )
            cps += ",";
        cps += player.bestGhostCp[i];
    }

    RS_GhostEnd( rsApiGhostUrl.string, rsApiToken.string, rsApiVersion.string,
            RACE_EffectiveMapName( player.reversed ), player.client.name, player.client.getMMLogin(),
            int( finishTime ), GHOST_HZ, cps );
}
