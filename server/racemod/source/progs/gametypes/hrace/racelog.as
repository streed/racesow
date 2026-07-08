// Race event log for external stats collection.
//
// Appends one machine-readable line per finished (non-practice) race to
// racelog/events.log inside the mod's write directory. A sidecar service
// (see collector/ in the deployment repo) tails this file and ships the
// results to the central stats database.
//
// Line format (tab-separated; the player name goes last because it is the
// only field that may contain arbitrary characters):
//
//   R1 <map> <finishTimeMs> <login> <cp1,cp2,...,cpN> <playerName>
//
// Checkpoint times are absolute milliseconds in spatial order, one entry per
// map checkpoint (the finish time is not repeated in the list); 0 means the
// checkpoint was not passed. <login> is the matchmaker login and is usually
// empty now that the auth servers are gone.

const String RACELOG_FILE = "racelog/events.log";

void RACE_LogFinish( Player @player )
{
    if ( !player.current_recordTime.isFinished() )
        return;

    Cvar mapNameVar( "mapname", "", 0 );
    String mapName = mapNameVar.string.tolower();

    String cps = "";
    for ( uint i = 0; i < numCheckpoints; i++ )
    {
        if ( i > 0 )
            cps += ",";
        cps += int( player.current_recordTime.checkpoints[ i ].time );
    }

    bool ok = G_AppendToFile( RACELOG_FILE, "R1\t" + mapName
            + "\t" + int( player.current_recordTime.getFinishTime() )
            + "\t" + player.current_recordTime.ident.login
            + "\t" + cps
            + "\t" + player.current_recordTime.ident.playerName
            + "\n" );

    // Surface the failure loudly instead of silently dropping the finish — the
    // usual cause is the racelog dir/file not being writable by the server
    // user (see server/entrypoint.sh, which pre-creates it).
    if ( !ok )
        G_Print( "^1racelog: FAILED to append to " + RACELOG_FILE
                + " — race finish not recorded (check racelog dir permissions)\n" );
}
