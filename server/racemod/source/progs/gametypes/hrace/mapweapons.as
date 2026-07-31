// Per-map weapon inventory for randmap-by-weapon voting.
//
// Each installed map's .bsp is scanned (web/scan-map-weapons.js) for its
// weapon_* spawn entities and the result stored in the web map_weapon table,
// served at GET /api/game/map-weapons as plain text, one line per map:
//   <mapname> <code> <code> ...
// where <code> is a 2-char weapon code (rl pg gl rg lg eb mg ig gb). A map with
// no weapons is a bare name (a strafe map). Every player spawns holding a
// gunblade, so a map whose only weapon is gb is still a strafe map.
//
// The gametype pulls this live (every API_MAPWEAPONS_REFRESH_MS via
// RS_ApiFetchMapWeapons; the table only moves when the maps are re-scanned, so
// this is rare) and GetMapsByFilter (utils.as) consults it so a player can
//   callvote randmap strafe      -> a no-weapon map (or a map named *strafe*)
//   callvote randmap rl          -> a map with a Rocket Launcher
//   callvote randmap rl pg       -> a map with BOTH a RL and a PG
// Full weapon names and a few aliases work too (rocket, rocketlauncher, ...).
// Anything the classifier doesn't recognise (or any wildcard) falls through to
// the classic name-pattern randmap, so existing votes are unchanged.
//
// Fail-closed on the filter only: an unfetched/unreachable table makes weapon
// votes report "No matching maps" (a network blip must never mis-switch), while
// `strafe` still matches map names and plain name-pattern votes are unaffected.
// Keep the weapon codes/aliases in sync with web/weapons.js.

Cvar rsApiMapWeaponsUrl( "rs_api_mapweapons_url", "", 0 );

// The table is essentially static (only changes on a re-scan), so refresh rarely.
const uint API_MAPWEAPONS_REFRESH_MS = 10 * 60 * 1000;
uint apiMapWeaponsLastFetch = 0;

// Parsed table, kept sorted by name (the endpoint emits ORDER BY name COLLATE
// "C", i.e. byte order, so RACE_MwIndex can binary search with a byte compare).
// raceMwCodes[i] is the space-delimited codes for raceMwNames[i], padded with a
// leading+trailing space so a whole-token match is a plain locate.
String[] raceMwNames;
String[] raceMwCodes;
// Last payload we parsed, so an identical refresh isn't re-parsed.
String raceMwParsedText = "";

// Scratch outputs of the most recent RACE_ClassifyFilter (script thread only,
// so no reentrancy): the strafe flag and the required weapon codes.
bool raceMwFilterStrafe = false;
String[] raceMwFilterCodes;

// A typed token -> its 2-char weapon code, or "" if it isn't a weapon. Accepts
// the code, the full name, and a few aliases. Mirrors web/weapons.js.
String RACE_WeaponCode( const String &in tokenIn )
{
    String t = tokenIn.tolower();
    if ( t == "gb" || t == "gunblade" ) return "gb";
    if ( t == "mg" || t == "machinegun" ) return "mg";
    if ( t == "rg" || t == "riotgun" || t == "shotgun" ) return "rg";
    if ( t == "gl" || t == "grenadelauncher" || t == "grenade" ) return "gl";
    if ( t == "rl" || t == "rocketlauncher" || t == "rocket" ) return "rl";
    if ( t == "pg" || t == "plasmagun" || t == "plasma" ) return "pg";
    if ( t == "lg" || t == "lasergun" || t == "laser" ) return "lg";
    if ( t == "eb" || t == "electrobolt" || t == "electro" || t == "bolt" ) return "eb";
    if ( t == "ig" || t == "instagun" || t == "insta" ) return "ig";
    return "";
}

// Byte-order less-than (String has no opCmp), matching the endpoint's COLLATE C.
bool RACE_MwLess( const String &in a, const String &in b )
{
    uint n = a.length() < b.length() ? a.length() : b.length();
    for ( uint i = 0; i < n; i++ )
    {
        uint8 ca = a[i];
        uint8 cb = b[i];
        if ( ca != cb )
            return ca < cb;
    }
    return a.length() < b.length();
}

// Classify a randmap argument. Returns true (and fills raceMwFilterStrafe /
// raceMwFilterCodes) when EVERY whitespace token is "strafe" or a known weapon
// and none contains a wildcard — otherwise false, meaning "treat as a classic
// name pattern" (so `q3dm*`, `*rl*`, or an unknown word still name-match).
bool RACE_ClassifyFilter( const String &in arg )
{
    raceMwFilterStrafe = false;
    raceMwFilterCodes.resize( 0 );
    String a = arg.removeColorTokens();
    int count = 0;
    for ( int i = 0; i < 16; i++ )
    {
        String tok = a.getToken( i );
        if ( tok.length() == 0 )
            break;
        count++;
        // A wildcard means the user wants name-pattern matching, not a filter.
        if ( tok.locate( "*", 0 ) < tok.length() || tok.locate( "?", 0 ) < tok.length() )
            return false;
        String low = tok.tolower();
        if ( low == "strafe" )
        {
            raceMwFilterStrafe = true;
            continue;
        }
        String code = RACE_WeaponCode( low );
        if ( code.length() == 0 )
            return false; // an unrecognised token -> whole arg is a name pattern
        raceMwFilterCodes.insertLast( code );
    }
    return count > 0;
}

// Public predicate (used by meshvote to pick its resolve branch). Leaves the
// scratch filter populated, which the following GetMapsByFilter refreshes anyway.
bool RACE_IsWeaponFilter( const String &in arg )
{
    return RACE_ClassifyFilter( arg );
}

// Rebuild raceMwNames / raceMwCodes from a fetched payload.
void RACE_ParseMapWeapons( const String &in text )
{
    raceMwNames.resize( 0 );
    raceMwCodes.resize( 0 );

    uint total = text.length();
    uint pos = 0;
    while ( pos < total )
    {
        // RACE_LocateFrom returns the string length when not found (same idiom
        // as the ranks/topscores parsers), so the final unterminated line is
        // still read.
        uint nl = RACE_LocateFrom( text, "\n", pos );
        if ( nl > total )
            nl = total;
        String line = text.substr( pos, nl - pos );
        pos = nl + 1;

        uint llen = line.length();
        if ( llen == 0 )
            continue;

        // "<name> code code ..." — split on the first space; a bare name (no
        // space) is a strafe map with an empty code list.
        uint sp = line.locate( " ", 0 );
        String name;
        String codes;
        if ( sp >= llen )
        {
            name = line;
            codes = "";
        }
        else
        {
            name = line.substr( 0, sp );
            codes = line.substr( sp + 1 );
        }
        name = name.tolower();
        if ( name.length() == 0 )
            continue;
        raceMwNames.insertLast( name );
        raceMwCodes.insertLast( " " + codes.tolower() + " " );
    }
}

// Index of <name> in raceMwNames, or -1. Binary search over the byte-sorted list.
int RACE_MwIndex( const String &in nameIn )
{
    String name = nameIn.removeColorTokens().tolower();
    int lo = 0;
    int hi = int( raceMwNames.length() ) - 1;
    while ( lo <= hi )
    {
        int mid = ( lo + hi ) / 2;
        if ( raceMwNames[ uint( mid ) ] == name )
            return mid;
        if ( RACE_MwLess( raceMwNames[ uint( mid ) ], name ) )
            lo = mid + 1;
        else
            hi = mid - 1;
    }
    return -1;
}

// True if <name> carries weapon <code> per the scanned table.
bool RACE_MapHasWeapon( const String &in name, const String &in code )
{
    int idx = RACE_MwIndex( name );
    if ( idx < 0 )
        return false;
    String pad = raceMwCodes[ uint( idx ) ];
    return pad.locate( " " + code + " ", 0 ) < pad.length();
}

// True if the scanned table says <name> has no weapon other than the gunblade.
// (Unscanned maps return false here; the name-based "strafe" check in
// RACE_MapMatchesFilter still catches maps literally named *strafe*.)
bool RACE_MapIsStrafeScan( const String &in name )
{
    int idx = RACE_MwIndex( name );
    if ( idx < 0 )
        return false;
    // raceMwCodes[idx] is " code code " (or "  "); any token that isn't gb is a
    // real weapon, so this is not a strafe map.
    String pad = raceMwCodes[ uint( idx ) ];
    for ( int i = 0; i < 16; i++ )
    {
        String tok = pad.getToken( i );
        if ( tok.length() == 0 )
            break;
        if ( tok != "gb" )
            return false;
    }
    return true;
}

// Does <name> (clean, lowercased) satisfy the scratch filter last set by
// RACE_ClassifyFilter? strafe = scanned no-weapon map OR a "strafe" map name;
// weapon codes are ANDed (a map must carry all of them).
bool RACE_MapMatchesFilter( const String &in name )
{
    if ( raceMwFilterStrafe )
    {
        if ( !( RACE_MapIsStrafeScan( name ) || name.locate( "strafe", 0 ) < name.length() ) )
            return false;
    }
    for ( uint i = 0; i < raceMwFilterCodes.length(); i++ )
    {
        if ( !RACE_MapHasWeapon( name, raceMwFilterCodes[ i ] ) )
            return false;
    }
    return true;
}

// Poll for a freshly-fetched table and refresh on the periodic interval. Called
// from GT_ThinkRules; a no-op when rs_api_mapweapons_url is unset.
void RACE_ApiMapWeaponsThink()
{
    if ( rsApiMapWeaponsUrl.string.length() == 0 )
        return;

    if ( apiMapWeaponsLastFetch == 0 )
    {
        // First think after the per-map script reload (which resets the arrays):
        // seed from the game module's persisted copy so a weapon vote right after
        // a map change still works before the fresh fetch round-trips. Empty
        // (never fetched) => arrays stay empty and weapon votes fail-closed.
        String seed = RS_MapWeaponsText();
        if ( seed != raceMwParsedText )
        {
            raceMwParsedText = seed;
            RACE_ParseMapWeapons( seed );
        }
    }

    if ( RS_ApiPollMapWeapons() == 1 )
    {
        String payload = RS_MapWeaponsText();
        raceMwParsedText = payload;
        RACE_ParseMapWeapons( payload );
    }

    if ( apiMapWeaponsLastFetch == 0 || levelTime - apiMapWeaponsLastFetch >= API_MAPWEAPONS_REFRESH_MS )
    {
        apiMapWeaponsLastFetch = levelTime == 0 ? 1 : levelTime;
        // empty token: the endpoint is public (same as blocked-maps/topscores).
        RS_ApiFetchMapWeapons( rsApiMapWeaponsUrl.string, "" );
    }
}
