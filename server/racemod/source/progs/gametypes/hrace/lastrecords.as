/*
 * Rolling cross-map feed of the most recent server records ("/lastrecs"):
 * which map, who beat whom, by how much, and the previous holder. Persisted to
 * lastrecs.txt so it survives map changes.
 *
 * Ported from hettoo/wsw-race@racemod (lastrecords.as), adapted to OUR record
 * model: hettoo's flat RecordTime.finishTime/playerName become our
 * RecordTime.getFinishTime()/ident.playerName, and race_servername -> SERVER_NAME.
 */

const int LAST_RECORDS = 20;

LastRecords lastRecords = LastRecords( "lastrecs.txt" );

class LastRecords
{
    String fileName;
    uint count;
    LastRecord[] recs;
    uint lastRec;
    String lastRecPlayer;

    LastRecords( String fileName )
    {
        this.fileName = fileName;
        this.recs.resize( LAST_RECORDS );
        this.lastRec = 0;
        this.lastRecPlayer = "";
        this.count = 0;
    }

    ~LastRecords() {}

    void fromFile()
    {
        // getFinishTime() below indexes checkpoints[length-1]; levelRecords are
        // only sized in GT_SpawnGametype, so bail if that hasn't happened
        // (defensive — fromFile is called right after the sizing loop).
        if ( levelRecords[0].checkpoints.length() == 0 )
            return;

        String input = G_LoadFile( this.fileName );

        String mapToken, playerToken, timeToken, refToken, refPlayerToken;
        this.count = 0;
        int tokens = 0;
        while ( this.count < LAST_RECORDS )
        {
            timeToken = input.getToken( tokens++ );
            if ( timeToken.length() == 0 )
                break;
            refToken = input.getToken( tokens++ );
            mapToken = input.getToken( tokens++ );
            playerToken = input.getToken( tokens++ );
            refPlayerToken = input.getToken( tokens++ );

            this.recs[this.count++] = LastRecord( uint( timeToken.toInt() ), uint( refToken.toInt() ), mapToken, playerToken, refPlayerToken );
        }
        this.lastRec = levelRecords[0].getFinishTime();
        this.lastRecPlayer = levelRecords[0].ident.playerName;
        if ( this.lastRecPlayer == "" )
            this.lastRecPlayer = ";";
    }

    void toFile()
    {
        // Guard the unsized case first (GT_Shutdown after a failed map spawn):
        // getFinishTime() on a never-sized RecordTime indexes checkpoints[-1].
        if ( levelRecords[0].checkpoints.length() == 0 )
            return;
        if ( levelRecords[0].getFinishTime() == 0 || ( this.lastRec > 0 && levelRecords[0].getFinishTime() >= this.lastRec ) )
            return;

        Cvar mapNameVar( "mapname", "", 0 );
        LastRecord newRecord = LastRecord( levelRecords[0].getFinishTime(), this.lastRec, mapNameVar.string.tolower(), levelRecords[0].ident.playerName, this.lastRecPlayer );
        String result = newRecord.format();
        uint bound = this.count;
        if ( LAST_RECORDS - 1 < bound )
            bound = LAST_RECORDS - 1;
        for ( uint i = 0; i < bound; i++ )
            result += this.recs[i].format();

        G_WriteFile( this.fileName, result );
    }

    bool show( Entity@ ent )
    {
        if ( this.count == 0 )
        {
            G_PrintMsg( ent, "No recent records found.\n" );
            return false;
        }

        uint bound = this.count;
        uint add = 1;
        Table table( S_COLOR_ORANGE + "r " + S_COLOR_WHITE + "r" + S_COLOR_YELLOW + " [r] " + S_COLOR_ORANGE + "l " + S_COLOR_WHITE + "l " + S_COLOR_ORANGE + "l " + S_COLOR_WHITE + "ll" );

        if ( levelRecords[0].getFinishTime() != 0 && ( this.lastRec == 0 || levelRecords[0].getFinishTime() < this.lastRec ) )
        {
            table.addCell( add + "." );
            table.addCell( RACE_TimeToString( levelRecords[0].getFinishTime() ) );
            table.addCell( RACE_TimeDiffString( levelRecords[0].getFinishTime(), this.lastRec, false ).removeColorTokens() );
            table.addCell( "by" );
            table.addCell( levelRecords[0].ident.playerName );
            table.addCell( "on" );
            Cvar mapNameVar( "mapname", "", 0 );
            table.addCell( mapNameVar.string.tolower() );
            if ( this.lastRecPlayer == ";" )
                table.addCell( "" );
            else
                table.addCell( S_COLOR_ORANGE + " (previously " + S_COLOR_WHITE + this.lastRecPlayer + S_COLOR_ORANGE + ")" );
            add++;
            if ( LAST_RECORDS - 1 < bound )
                bound = LAST_RECORDS - 1;
        }

        for ( uint i = 0; i < bound; i++ )
        {
            table.addCell( ( i + add ) + "." );
            table.addCell( RACE_TimeToString( this.recs[i].time ) );
            table.addCell( RACE_TimeDiffString( this.recs[i].time, this.recs[i].ref, false ).removeColorTokens() );
            table.addCell( "by" );
            table.addCell( this.recs[i].player );
            table.addCell( "on" );
            table.addCell( this.recs[i].map );
            if ( this.recs[i].refPlayer == ";" )
                table.addCell( "" );
            else
                table.addCell( S_COLOR_ORANGE + " (previously " + S_COLOR_WHITE + this.recs[i].refPlayer + S_COLOR_ORANGE + ")" );
        }

        G_PrintMsg( ent, S_COLOR_ORANGE + "Most recent " + SERVER_NAME + S_COLOR_ORANGE + " records:\n" );
        uint rows = table.numRows();
        for ( uint i = 0; i < rows; i++ )
            G_PrintMsg( ent, table.getRow( i ) + "\n" );

        return true;
    }
}

class LastRecord
{
    uint time;
    uint ref;
    String map;
    String player;
    String refPlayer;

    LastRecord( uint time, uint ref, String map, String player, String refPlayer )
    {
        this.time = time;
        this.ref = ref;
        this.map = map;
        this.player = player;
        this.refPlayer = refPlayer;
    }

    ~LastRecord() {}

    String format()
    {
        return "\"" + this.time + "\" \"" + this.ref + "\" \"" + this.map + "\" \"" + this.player + "\" \"" + this.refPlayer + "\"\n";
    }
}
