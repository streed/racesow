// /flag - report the current map to the central moderators.
//
// SITE MODULE. This is the only reason base commands.as ever touched an engine
// native (RS_ApiFlag), and the only reason it needed the rs_api_* credential
// cvars. Lifting it out means the base command table compiles against a stock
// engine with nothing stripped.
//
// Players type "/flag <reason>" (reason optional: broken/offensive/wrong_name/
// duplicate). The reporter's name and MM login come from their client rather
// than from the argument string, so a report always carries who sent it.
// Delivered by the RS_ApiFlag native (server/enginepatches/g_rs_api.cpp).

Cvar rsApiFlagUrl( "rs_api_flag_url", "", 0 );
uint[] lastFlagTime( maxClients );
const uint FLAG_COOLDOWN_MS = 30000;

bool Cmd_Flag( Client@ client, const String &cmdString, const String &argsString, int argc )
{
    if ( rsApiFlagUrl.string.length() == 0 )
    {
        client.printMessage( S_COLOR_RED + "Flagging is not available on this server.\n" );
        return false;
    }

    int pn = client.playerNum;
    if ( lastFlagTime[pn] != 0 && levelTime - lastFlagTime[pn] < FLAG_COOLDOWN_MS )
    {
        client.printMessage( S_COLOR_RED + "You just flagged a map - please wait a moment before flagging again.\n" );
        return false;
    }
    lastFlagTime[pn] = levelTime;

    String reason = argsString.getToken( 0 ).tolower();

    Cvar mapNameVar( "mapname", "", 0 );
    String mapName = mapNameVar.string.tolower();

    // Name + login come from the player's client, not from the command args.
    RS_ApiFlag( rsApiFlagUrl.string, rsApiToken.string, mapName, reason, client.name, client.getMMLogin() );

    client.printMessage( S_COLOR_GREEN + "Thanks - you flagged " + S_COLOR_WHITE + mapName
        + ( reason != "" ? S_COLOR_GREEN + " (" + S_COLOR_WHITE + reason + S_COLOR_GREEN + ")" : "" )
        + S_COLOR_GREEN + " for moderator review.\n" );
    return true;
}
