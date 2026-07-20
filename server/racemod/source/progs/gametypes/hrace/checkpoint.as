enum CheckpointType {
    CheckpointType_Unused,
    CheckpointType_Normal,
    CheckpointType_Finish,
};

class Checkpoint
{
    CheckpointType type;

    uint time;
    uint speed;
    uint maxSpeed;

    Checkpoint()
    {
        this.clear();
    }

    Checkpoint( uint time, CheckpointType type )
    {
        this.clear();
        this.type = type;
        this.time = time;
    }

    Checkpoint( uint time, uint speed, uint maxSpeed, CheckpointType type )
    {
        this.clear();
        this.type = type;
        this.time = time;
        this.speed = speed;
        this.maxSpeed = maxSpeed;
    }

    void clear() {
        this.type = CheckpointType_Unused;
        this.time = 0;
        this.speed = 0;
        this.maxSpeed = 0;
    }

    bool addToTable( Table@ table, Player@ player, uint checkpoint_id, uint num )
    {
        if ( this.type == CheckpointType_Unused )
            return false;

        // Compare against the board matching the player's mode (reverse runs
        // have their own separate top board).
        RecordTime[]@ levelRecords = RACE_Records( player.reversed );

        if( this.type == CheckpointType_Finish )
            table.addCell( "Finish:" );
        else
            table.addCell( "CP" + num + ":" );
        table.addCell( RACE_TimeToString( this.time ) );
        table.addCell( "Personal:" );
        table.addCell( RACE_TimeDiffString( this.time, player.best_recordTime.checkpoints[ checkpoint_id ].time, false ) );
        table.addCell( "Server:" );
        table.addCell( RACE_TimeDiffString( this.time, levelRecords[ 0 ].checkpoints[ checkpoint_id ].time, false ) );
        table.addCell( "Speed:" );
        table.addCell( String( this.speed ) );
        table.addCell( ", max" );
        table.addCell( String( this.maxSpeed ) );

        return true;
    }

    void specPrint( Client@ client, Player@ player, uint checkpoint_id ) {
        Player@ spec_player = @RACE_GetPlayer( client );
        RecordTime[]@ levelRecords = RACE_Records( player.reversed );
        String line1 = "";
        String line2 = "";

        if ( player.best_recordTime.isFinished() && this.time != 0 )
        {
            line1 += "\u00A0   Current: " + RACE_TimeToString( this.time ) + "   \u00A0";
            line2 += "\u00A0           " + RACE_TimeDiffString( this.time, player.best_recordTime.checkpoints[ checkpoint_id ].time, true) + "           \u00A0";
        }
        else
        {
            line1 += "\u00A0   Current: " + RACE_TimeToString( this.time ) + "   \u00A0";
            line2 += "\u00A0           " + "                    " + "           \u00A0";
        }

        if ( spec_player.best_recordTime.isFinished() && spec_player.best_recordTime.checkpoints[ checkpoint_id ].type == CheckpointType_Unused )
        {
            line1 = "\u00A0  Personal:    " + "          " + line1;
            line2 = RACE_TimeDiffString( this.time, spec_player.best_recordTime.checkpoints[ checkpoint_id ].time, true ) + "          " + line2;
        }
        else if ( levelRecords[ 0 ].getFinishTime() != 0 )
        {
            line1 = "\u00A0                                " + line1;
            line2 = "\u00A0                                " + line2;
        }

        if ( !levelRecords[ 0 ].isFinished() && levelRecords[ 0 ].checkpoints[ checkpoint_id ].type == CheckpointType_Unused )
        {
            line1 += "\u00A0          " + "Server:     \u00A0";
            line2 += "\u00A0      " + RACE_TimeDiffString( this.time, levelRecords[ 0 ].checkpoints[ checkpoint_id ].time, true ) + "\u00A0";
        }

        G_CenterPrintMsg( client.getEnt(), line1 + "\n" + line2 );
    }

    void print( Player@ player, uint checkpoint_id ) {
        RecordTime[]@ levelRecords = RACE_Records( player.reversed );
        String str = player.practicing ? S_COLOR_CYAN : S_COLOR_WHITE;
        str += "Current: " + RACE_TimeToString( this.time );

        for ( int i = 0; i < MAX_RECORDS; i++ )
        {
            if ( this.time < levelRecords[ i ].checkpoints[ checkpoint_id ].time )
            {
                str += " (" + S_COLOR_GREEN + "#" + ( i + 1 ) + S_COLOR_WHITE + ")"; // extra id when on server record beating time
                break;
            }
        }
        str += "\n";
        str += RACE_TimeDiffString( this.time, player.best_recordTime.checkpoints[ checkpoint_id ].time, true );

        G_CenterPrintMsg( player.client.getEnt(), str );

        if( !player.practicing && player.best_recordTime.isFinished() )
        {
            // if beating the level record on this sector give an award
            if ( this.time < levelRecords[ 0 ].checkpoints[ checkpoint_id ].time )
            {
                if( this.type == CheckpointType_Finish )
                    player.client.addAward( S_COLOR_GREEN + "Server record!" );
                else
                    player.client.addAward( "Server record on CP" + ( player.currentCheckpoint + 1 ) + "!" );
            }
            // if beating his own record on this sector give an award
            else if ( this.time < player.best_recordTime.checkpoints[ checkpoint_id ].time )
            {
                if( this.type == CheckpointType_Finish )
                    player.client.addAward( S_COLOR_YELLOW + "Personal record!" );
                else
                    player.client.addAward( "Personal record on CP" + ( player.currentCheckpoint + 1 ) + "!" );
            }
        }

        Client@[] specs = RACE_GetSpectators( player.client );
        for ( uint i = 0; i < specs.length(); i++ )
        {
            this.specPrint( specs[ i ], player, checkpoint_id );
        }
    }
}
