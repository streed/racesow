enum Keys {
    Key_Forward = 1,
    Key_Backward = 2,
    Key_Left = 4,
    Key_Right = 8,
    Key_Attack = 16,
    Key_Jump = 32,
    Key_Crouch = 64,
    Key_Special = 128,
};

// Geometric centre of an entity's bounding box (used by the entity finder).
Vec3 Centre( Entity@ ent )
{
    Vec3 mins, maxs;
    ent.getSize( mins, maxs );
    return ent.origin + 0.5 * mins + 0.5 * maxs;
}

enum Wildcard {
    Wildcard_No,
    Wildcard_Yes,
};

bool PatternMatch( String str, String pattern, Wildcard wildcard = Wildcard_No )
{
    if ( wildcard == Wildcard_Yes && ( pattern == "*" || pattern == "" ) ) return true;
    return str.locate( pattern, 0 ) < str.length();
}

// Find `token` at or after byte offset `start`; returns str.length() when it
// is absent (locate's own not-found convention). String.locate's second
// argument is a count of MATCHES TO SKIP from the start of the string, not a
// start offset (engine addon_string.cpp, objectString_Locate) — passing a
// byte offset there jumps to the wrong match, or "not found" once the offset
// exceeds the matches remaining, silently merging the rest of the payload
// into one token. Every offset-walking parser must go through this instead.
uint RACE_LocateFrom( const String &in str, const String &in token, uint start )
{
    if ( start >= str.length() )
        return str.length();
    return start + str.substr( start ).locate( token, 0 );
}

String[] GetMapsByPattern( String@ pattern, String@ ignore = null )
{
    String[] maps;

    const String@ map;
    pattern = pattern.removeColorTokens().tolower();
    if ( pattern == "*" )
        pattern = "";
    
    uint i = 0;
    while( true )
    {
        @map = ML_GetMapByNum( i++ );
        if ( @map == null )
            break;
        String clean_map = map.removeColorTokens().tolower();
        if ( @ignore != null && map == ignore )
            continue;
        // Drop maps a moderator has blocked in the web admin (fetched live by
        // blockedmaps.as). Fail-open: unfetched/unconfigured => nothing blocked.
        // This filters every selection path that funnels through here: randmap,
        // meshvote wildcards, prerandmap and the /maps listing.
        if ( RACE_IsMapBlocked( clean_map ) )
            continue;
        if ( PatternMatch( clean_map, pattern, Wildcard_Yes ) )
        {
            maps.insertLast( map );
        }
    }

    return maps;
}

// Map selection for the vote paths (randmap / prerandmap / meshvote). If <arg>
// is a weapon/strafe filter (strafe, or weapon codes/names like rl / rocket /
// "rl pg", no wildcard) it returns the installed maps that satisfy it, per the
// scanned map_weapon table (mapweapons.as); otherwise it is a classic name
// pattern and this delegates to GetMapsByPattern with identical behaviour. Both
// paths drop moderator-blocked maps and the <ignore> map (the current one).
String[] GetMapsByFilter( String@ arg, String@ ignore = null )
{
    // Not a weapon/strafe filter? Keep the original name-pattern behaviour.
    // (RACE_IsWeaponFilter also populates the scratch filter used below.)
    if ( !RACE_IsWeaponFilter( arg ) )
        return GetMapsByPattern( arg, ignore );

    String[] maps;
    uint i = 0;
    while ( true )
    {
        const String@ map = ML_GetMapByNum( i++ );
        if ( @map == null )
            break;
        if ( @ignore != null && map == ignore )
            continue;
        String clean_map = map.removeColorTokens().tolower();
        if ( RACE_IsMapBlocked( clean_map ) )
            continue;
        if ( RACE_MapMatchesFilter( clean_map ) )
            maps.insertLast( map );
    }

    return maps;
}

String RACE_TimeToString( uint time )
{
    // convert times to printable form
    String minsString, secsString, millString;
    uint min, sec, milli;

    milli = time;
    min = milli / 60000;
    milli -= min * 60000;
    sec = milli / 1000;
    milli -= sec * 1000;

    if ( min == 0 )
        minsString = "00";
    else if ( min < 10 )
        minsString = "0" + min;
    else
        minsString = min;

    if ( sec == 0 )
        secsString = "00";
    else if ( sec < 10 )
        secsString = "0" + sec;
    else
        secsString = sec;

    if ( milli == 0 )
        millString = "000";
    else if ( milli < 10 )
        millString = "00" + milli;
    else if ( milli < 100 )
        millString = "0" + milli;
    else
        millString = milli;

    return minsString + ":" + secsString + "." + millString;
}

String RACE_TimeDiffString( uint time, uint reference, bool clean )
{
    if ( reference == 0 && clean )
        return "";
    else if ( reference == 0 )
        return S_COLOR_WHITE + "--:--.---";
    else if ( time == reference )
        return S_COLOR_YELLOW + "+-" + RACE_TimeToString( 0 );
    else if ( time < reference )
        return S_COLOR_GREEN + "-" + RACE_TimeToString( reference - time );
    else
        return S_COLOR_RED + "+" + RACE_TimeToString( time - reference );
}

// --- moved here so the base gametype owns them -------------------------------
// The three below used to live in racesow.org-specific modules, which meant the
// base race rules had to call INTO the optional layer to answer questions that
// are entirely about base behaviour. Moving them deletes those seams outright
// rather than papering over them with a hook, and none of them needs a native.

// Reverse mode (see /reverse in commands.as): a run raced backwards through the
// course is a wholly separate record set, never distinguished by a flag —
// instead every map-scoped identity uses this suffixed name. The suffix is
// deliberately regex-safe (no spaces) so it survives the read endpoints and the
// top-board map-name filter unchanged.
const String REVERSE_SUFFIX = "-reversed";

// The effective map name for a run: "<map>-reversed" for a reversed run, else
// the plain lowercased BSP name.
//
// This is BASE, not reporting, however much it looks like reporting: it names
// the topscores FILE the gametype reads and writes (recordtime.as). Left in the
// optional layer and stubbed, a base build and a racesow.org build would keep
// two different leaderboards for the same reversed map.
String RACE_EffectiveMapName( bool reversed )
{
    Cvar mapNameVar( "mapname", "", 0 );
    String mapName = mapNameVar.string.tolower();
    return reversed ? mapName + REVERSE_SUFFIX : mapName;
}

// Strip a string down to something safe to publish in a serverinfo value:
// colour tokens out, then ASCII printables only, minus the characters that
// terminate or confuse an infostring ( \ " ; : , ). Truncates to maxLen.
//
// Named for what it does rather than for the mesh, which was its first caller.
String RACE_CleanForServerInfo( const String &in raw, uint maxLen )
{
    String s = raw.removeColorTokens();
    String clean = "";
    for ( uint i = 0; i < s.length() && clean.length() < maxLen; i++ )
    {
        uint8 c = s[i];
        if ( c < uint8(0x20) || c > uint8(0x7E) )       // control / non-ASCII
            continue;
        if ( c == uint8(0x5C) || c == uint8(0x22) || c == uint8(0x3B)   // \ " ;
                || c == uint8(0x3A) || c == uint8(0x2C) )                // : ,
            continue;
        clean += s.substr( i, 1 );
    }
    return clean;
}

// Real (non-puppet) players on the team, for the autorecord toggle in hrace.as
// so neither the WR ghost nor mesh bots keep a match recording forever.
//
// This one MUST be base and must not be stubbed: a no-op returning 0 reads as
// "the server is empty", and match autorecord would then never start for
// anybody.
int RACE_RealPlayerCount()
{
    int n = 0;
    Team@ team = G_GetTeam( TEAM_PLAYERS );
    for ( int i = 0; @team.ent( i ) != null; i++ )
    {
        if ( !RACE_IsPuppetNum( team.ent( i ).client.playerNum ) )
            n++;
    }
    return n;
}
