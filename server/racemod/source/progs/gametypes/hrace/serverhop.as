// In-game server hopping — let players jump between the other Racesow servers of
// their OWN game (Warsow players see Warsow servers, Warfork players see Warfork
// ones) without leaving the game to use the console browser.
//
//   /servers        list the other same-game servers + their live map/players
//   /hop <# | name> jump to one (also /servers <# | name>)
//
// The server list is STATIC config (the mesh carries maps + tags but not game
// connect addresses, and fs_game is "racemod" for both games), set per box:
//   rs_hop_servers  "tag;Display Name;game;host:port|tag;Display Name;game;host:port|..."
//   rs_hop_game     "warsow" | "warfork"   (this box's game, for filtering)
// The SAME rs_hop_servers list can be shipped to every box; each one filters to
// its own game and drops its own tag. Live map/player counts are pulled from the
// mesh peer registry (RS_MirrorPeer*) by matching tag, so an empty peer still
// shows its map. Joining stuffs a client "connect <addr>" and ALSO prints the
// address, so it works whether or not the client honours a server-issued connect.

Cvar rsHopServers( "rs_hop_servers", "", 0 );
Cvar rsHopGame( "rs_hop_game", "", 0 );

// Parsed rs_hop_servers, cached against the cvar string so a re-parse only
// happens when the config actually changes.
String[] hopTag;
String[] hopName;
String[] hopGame;
String[] hopAddr;
String hopParsedFrom = "";
bool hopEverParsed = false; // forces the first parse even when rs_hop_servers is ""

// Split `s` on the single-string delimiter `sep` into its fields. AngelScript's
// String.getToken only splits on whitespace (and hop display names contain
// spaces), so this does an explicit locate/substr walk. A not-found locate
// returns >= length, which ends the walk with the trailing field.
String[] RACE_HopSplit( const String &in s, const String &in sep )
{
    String[] out;
    uint n = s.length();
    uint start = 0;
    while ( true )
    {
        // Reached the end exactly (empty string, or a trailing separator): emit the
        // final empty field and stop WITHOUT calling locate() at start == length.
        if ( start >= n )
        {
            out.insertLast( "" );
            break;
        }
        uint p = s.locate( sep, start );
        if ( p >= n )
        {
            out.insertLast( s.substr( start, n - start ) );
            break;
        }
        out.insertLast( s.substr( start, p - start ) );
        start = p + sep.length();
    }
    return out;
}

// (Re)parse rs_hop_servers into the hop* arrays when the cvar has changed.
void RACE_HopParse()
{
    if ( hopEverParsed && hopParsedFrom == rsHopServers.string )
        return;
    hopEverParsed = true;
    hopParsedFrom = rsHopServers.string;
    hopTag.resize( 0 ); hopName.resize( 0 ); hopGame.resize( 0 ); hopAddr.resize( 0 );

    String[] entries = RACE_HopSplit( rsHopServers.string, "|" );
    for ( uint i = 0; i < entries.length(); i++ )
    {
        String[] f = RACE_HopSplit( entries[i], ";" );
        if ( f.length() < 4 )
            continue; // malformed entry — skip
        String tag = f[0].trim();
        String name = f[1].trim();
        String game = f[2].trim();
        String addr = f[3].trim();
        if ( tag.length() == 0 || addr.length() == 0 )
            continue;
        hopTag.insertLast( tag );
        hopName.insertLast( name );
        hopGame.insertLast( game );
        hopAddr.insertLast( addr );
    }
}

// Indices into the hop* arrays for the servers this player can hop to: same game
// as this box (rs_hop_game), and not this box itself (its own tag).
int[] RACE_HopTargets()
{
    int[] idx;
    String myGame = rsHopGame.string.removeColorTokens().tolower();
    String myTag = rsMirrorTag.string.removeColorTokens().tolower();
    for ( uint i = 0; i < hopTag.length(); i++ )
    {
        if ( myGame.length() > 0 && hopGame[i].tolower() != myGame )
            continue;
        if ( hopTag[i].removeColorTokens().tolower() == myTag && myTag.length() > 0 )
            continue;
        idx.insertLast( int( i ) );
    }
    return idx;
}

// Live "map  N playing" for a hop target, matched by tag against the mesh peer
// registry (which includes empty peers via their keepalive map). "(offline?)"
// when we're not currently hearing that server on the mesh.
String RACE_HopStatus( const String &in tag )
{
    String want = tag.removeColorTokens().tolower();
    int pc = RS_MirrorPeerCount();
    for ( int i = 0; i < pc; i++ )
    {
        String ptag = RS_MirrorPeerTag( i );
        if ( ptag.removeColorTokens().tolower() != want )
            continue;
        int players = 0;
        for ( uint j = 0; j < mirrorPlayers.length(); j++ )
        {
            if ( mirrorPlayers[j].server == ptag && !mirrorPlayers[j].spectator )
                players++;
        }
        String cnt;
        if ( players > 0 )
            cnt = "" + players + " playing";
        else
            cnt = "empty";
        String pmap = RS_MirrorPeerMap( i );
        if ( pmap.length() > 0 )
            return S_COLOR_GREEN + pmap + S_COLOR_WHITE + "  " + cnt;
        return S_COLOR_WHITE + cnt;
    }
    return S_COLOR_WHITE + "(offline?)";
}

// /servers (list) and /hop <target> (join). With no argument both list the other
// same-game servers; with an argument (a 1-based list number, or a tag/name
// substring) both jump to the matching server.
bool Cmd_Servers( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    RACE_HopParse();
    int[] idx = RACE_HopTargets();
    String arg = argsString.getToken( 0 );

    if ( arg.length() == 0 )
    {
        if ( idx.length() == 0 )
        {
            client.printMessage( "No other servers are configured for this game.\n" );
            return true;
        }
        RS_MirrorRefresh();
        String gameLabel = rsHopGame.string.removeColorTokens();
        String heading = "Other Racesow ";
        if ( gameLabel.length() > 0 )
            heading += gameLabel + " ";
        client.printMessage( S_COLOR_ORANGE + heading + "servers:\n" );
        for ( uint k = 0; k < idx.length(); k++ )
        {
            int i = idx[k];
            client.printMessage( "  " + S_COLOR_YELLOW + ( k + 1 ) + "." + S_COLOR_WHITE
                    + " [" + hopTag[i] + S_COLOR_WHITE + "] " + hopName[i]
                    + S_COLOR_WHITE + "  " + RACE_HopStatus( hopTag[i] ) + "\n" );
        }
        client.printMessage( S_COLOR_WHITE + "Type " + S_COLOR_YELLOW + "/hop <#>"
                + S_COLOR_WHITE + " (or part of a name) to jump to one.\n" );
        return true;
    }

    // Resolve the argument to one hop target: a 1-based list number first, then a
    // tag/name substring.
    int pick = -1;
    if ( arg.isNumeric() )
    {
        int n = arg.toInt();
        if ( n >= 1 && n <= int( idx.length() ) )
            pick = idx[n - 1];
    }
    if ( pick < 0 )
    {
        String want = arg.removeColorTokens().tolower();
        for ( uint k = 0; k < idx.length(); k++ )
        {
            int i = idx[k];
            String cleanTag = hopTag[i].removeColorTokens().tolower();
            String cleanName = hopName[i].removeColorTokens().tolower();
            if ( cleanTag.locate( want, 0 ) < cleanTag.length()
                    || cleanName.locate( want, 0 ) < cleanName.length() )
            {
                pick = i;
                break;
            }
        }
    }
    if ( pick < 0 )
    {
        client.printMessage( "No matching server. Type " + S_COLOR_YELLOW + "/servers"
                + S_COLOR_WHITE + " to see the list.\n" );
        return true;
    }

    // Ask the client to connect, and print the address too — a server-issued
    // connect may be ignored by some clients, so the printed address is the
    // always-works fallback.
    client.printMessage( S_COLOR_GREEN + "Joining " + hopName[pick] + S_COLOR_GREEN
            + " ... if your client doesn't switch, type: " + S_COLOR_YELLOW + "connect "
            + hopAddr[pick] + "\n" );
    client.execGameCommand( "connect " + hopAddr[pick] );
    return true;
}
