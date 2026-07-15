const int MAX_RECORDS = 50;
const int DISPLAY_RECORDS = 20;
const int HUD_RECORDS = 3;

RecordTime[] levelRecords( MAX_RECORDS );

Table raceReport( S_COLOR_ORANGE + "l " + S_COLOR_WHITE + "r " + S_COLOR_ORANGE + "/ l r " + S_COLOR_ORANGE + "/ l r " + S_COLOR_ORANGE + "/ l " + S_COLOR_WHITE + "r" + S_COLOR_ORANGE + "l " + S_COLOR_WHITE + "r" );
Table practiceReport( S_COLOR_CYAN + "l " + S_COLOR_WHITE + "r " + S_COLOR_CYAN + "/ l r " + S_COLOR_CYAN + "/ l r " + S_COLOR_CYAN + "/ l " + S_COLOR_WHITE + "r" + S_COLOR_CYAN + "l " + S_COLOR_WHITE + "r" );

enum RecordTimeType {
    RecordTimeType_Unfinished,
    RecordTimeType_Finished,
};

class RecordTimeIdent
{
    String playerName;
    String cleanName;
    String login;

    RecordTimeIdent()
    {
        this.playerName = "";
        this.cleanName = "";
        this.login = "";
    }

    RecordTimeIdent( String playerName, String login )
    {
        this.playerName = playerName;
        this.cleanName = playerName.removeColorTokens().tolower();
        this.login = login;
    }

    bool equals( RecordTimeIdent &other, bool identical )
    {
        if ( identical && this.login != other.login )
            return false;
        return this.cleanName == other.cleanName;
    }

    bool hasPriority( RecordTimeIdent & other )
    {
        return this.login != "" && ( this.cleanName == other.cleanName || this.login == other.login );
    }
}

class RecordTime
{
    RecordTimeType type;
    RecordTimeIdent ident;
    Checkpoint[] checkpoints;
    uint[] checkpoint_order;
    bool arraysSetUp;

    void setupArrays( uint size )
    {
        this.checkpoints.resize( size );
        this.checkpoint_order.resize( size );
        this.clearCheckpoints();
        this.arraysSetUp = true;
    }

    RecordTime()
    {
        this.type = RecordTimeType_Unfinished;
        this.arraysSetUp = false;
    }

    ~RecordTime() {}

    void clearCheckpoints()
    {
        for ( uint i = 0; i < this.checkpoints.length(); i++ )
        {
            this.checkpoints[ i ].clear();
            this.checkpoint_order[ i ] = UINT_MAX;
        }
    }

    void clear()
    {
        this.type = RecordTimeType_Unfinished;
        this.ident = RecordTimeIdent();
        this.clearCheckpoints();
    }

    uint getFinishTime() {
        return this.checkpoints[ this.checkpoints.length() - 1 ].time;
    }

    void report( Player@ player )
    {
        Table@ table = player.practicing ? @practiceReport : @raceReport;
        uint num = 1;
        for ( uint i = 0; i < this.checkpoints.length(); i++ ) {
            uint index = this.checkpoint_order[ i ];
            if ( index == UINT_MAX )
                break;
            if ( this.checkpoints[ index ].addToTable( table, player, index, num ) )
                num++;
        }
        uint rows = table.numRows();
        for ( uint i = 0; i < rows; i++ )
            G_PrintMsg( player.client.getEnt(), table.getRow( i ) + "\n" );

        table.reset();
    }

    bool isFinished() {
        return this.type != RecordTimeType_Unfinished;
    }

    void deduceCheckpointOrder() {
        uint num = 0;
        uint min_time = 0;
        for ( uint i = 0; i < this.checkpoint_order.length(); i++ )
        {
            uint id = UINT_MAX;
            uint max_time = UINT_MAX;
            for ( uint j = 0; j < this.checkpoints.length(); j++ )
            {
                if ( this.checkpoints[ j ].type == CheckpointType_Unused )
                    continue;
                uint cp_time = this.checkpoints[ j ].time;
                if ( min_time < cp_time && cp_time < max_time )
                {
                    max_time = this.checkpoints[ j ].time;
                    id = j;
                }
            }
            if ( id == UINT_MAX )
                break;
            min_time = this.checkpoints[ id ].time;
            this.checkpoint_order[ num++ ] = id;
        }
    }
}

void RACE_LoadTopScores()
{
    String topScores;
    Cvar mapNameVar( "mapname", "", 0 );
    String mapName = mapNameVar.string.tolower();

    topScores = G_LoadFile( "topscores/race/" + mapName + ".txt" );

    if ( topScores.length() > 0 )
    {
        String timeToken, loginToken, nameToken, sectorToken;
        int count = 0;
        uint sep;

        for ( int i = 0; i < MAX_RECORDS; i++ )
        {
            timeToken = topScores.getToken( count++ );
            if ( timeToken.length() == 0 )
                break;

            sep = timeToken.locate( "|", 0 );
            if ( sep == timeToken.length() )
            {
                loginToken = "";
            }
            else
            {
                loginToken = timeToken.substr( sep + 1 );
                timeToken = timeToken.substr( 0, sep );
            }

            nameToken = topScores.getToken( count++ );
            if ( nameToken.length() == 0 )
                break;

            sectorToken = topScores.getToken( count++ );
            if ( sectorToken.length() == 0 )
                break;

            uint numSectors = uint( sectorToken.toInt() );
            // TODO: should probably check if numSectors == numCheckpoints

            // store this one
            RecordTime record;
            record.setupArrays( numSectors + 1 );
            for ( uint j = 0; j < numSectors; j++ )
            {
                sectorToken = topScores.getToken( count++ );
                if ( sectorToken.length() == 0 )
                    break;

                uint sectorTime = uint( sectorToken.toInt() );
                if( sectorTime != 0 )
                    record.checkpoints[ j ] = Checkpoint( sectorTime, CheckpointType_Normal );
            }

            record.ident = RecordTimeIdent( nameToken, loginToken );
            record.type = RecordTimeType_Finished;

            uint finishTime = uint( timeToken.toInt() );
            record.checkpoints[ numSectors ] = Checkpoint( finishTime, CheckpointType_Finish );
            record.deduceCheckpointOrder();

            RACE_AddTopScore( record, false );
        }

        RACE_UpdateHUDTopScores();
    }
}

void RACE_UpdateHUDTopScores()
{
    for ( int i = 0; i < HUD_RECORDS; i++ )
    {
        G_ConfigString( CS_GENERAL + i, "" ); // somehow it is not shown the first time if it isn't initialized like this
        if ( levelRecords[ i ].isFinished() && levelRecords[ i ].ident.playerName.length() > 0 )
            G_ConfigString( CS_GENERAL + i, "#" + ( i + 1 ) + " - " + levelRecords[ i ].ident.playerName + " - " + RACE_TimeToString( levelRecords[ i ].getFinishTime() ) );
    }
}

void RACE_WriteTopScores()
{
    String topScores;
    Cvar mapNameVar( "mapname", "", 0 );
    String mapName = mapNameVar.string.tolower();

    topScores = "//" + mapName + " top scores\n\n";

    for ( int i = 0; i < MAX_RECORDS; i++ )
    {
        if ( levelRecords[ i ].isFinished() && levelRecords[ i ].ident.playerName.length() > 0 )
        {
            topScores += "\"" + int( levelRecords[ i ].getFinishTime() );
            if ( levelRecords[ i ].ident.login != "" )
                topScores += "|" + levelRecords[ i ].ident.login; // optionally storing it in a token with another value provides backwards compatibility
            topScores += "\" \"" + levelRecords[ i ].ident.playerName + "\" ";

            // add the sectors
            topScores += "\"" + numCheckpoints+ "\" ";

            for ( uint j = 0; j < numCheckpoints; j++ )
                topScores += "\"" + int( levelRecords[ i ].checkpoints[ j ].time ) + "\" ";

            topScores += "\n";
        }
    }

    G_WriteFile( "topscores/race/" + mapName + ".txt", topScores );
}

uint RACE_AddTopScore( RecordTime record, bool take_priority = true )
{
    uint id;
    for ( uint top = 0; top < MAX_RECORDS; top++ )
    {
        // add at the end of list
        if ( !levelRecords[ top ].isFinished() )
        {
            levelRecords[ top ] = record;
            return top;
        }

        // check for same ident
        if ( record.ident.equals( levelRecords[ top ].ident, !take_priority ) )
        {
            // check if old time was better OR EQUAL: an equal-time re-add of
            // the same ident must be a no-op, or reloading the topscores file
            // over a populated list (the live API refresh in apitop.as does
            // this every interval) duplicates every record — the insert scan
            // below is strictly-less so the copy lands after this row, where
            // the forward-only duplicate sweep never sees it.
            if ( record.getFinishTime() >= levelRecords[ top ].getFinishTime() )
                return UINT_MAX;
        }
        // insert into correct spot
        if ( ( take_priority && record.ident.hasPriority( levelRecords[ top ].ident ) ) || record.getFinishTime() < levelRecords[ top ].getFinishTime() )
        {
            id = top;
            break;
        }
    }

    bool found = false;
    uint end = MAX_RECORDS - 1;
    // if there is a duplicate, remove it and move other records up.
    // Match on identity (same as the insert-scan check above) rather than
    // hasPriority(): hasPriority() requires a non-empty login, but the auth
    // servers are gone so logins are always empty — using it here meant a
    // player's older, slower entry was never removed and the same nick piled
    // up multiple rows in the top scores.
    for ( uint i = id; i < MAX_RECORDS - 1; i++ )
    {
        if ( !levelRecords[ i ].isFinished() )
        {
            end = i;
            break;
        }
        if ( record.ident.equals( levelRecords[ i ].ident, !take_priority ) )
            found = true;
        if ( found )
            levelRecords[ i ] = levelRecords[ i + 1 ];
    }
    // otherwise, move other records down
    if ( !found )
    {
        for ( uint i = end; i > id; i-- )
            levelRecords[ i ] = levelRecords[ i - 1 ];
    }
    levelRecords[ id ] = record;
    return id;
}
