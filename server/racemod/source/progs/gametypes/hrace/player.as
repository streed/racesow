const int MAX_POSITIONS = 400;
const int POSITION_INTERVAL = 500;
const float POSITION_HEIGHT = 24;

const int RECALL_ACTION_TIME = 200;
const int RECALL_ACTION_JUMP = 5;

Player[] players( maxClients );

class Player
{
    Client@ client;
    bool arraysSetUp;

    RecordTime best_recordTime;
    int pos;
    RecordTime current_recordTime;
    uint currentCheckpoint;

    uint startTime;
    uint maxSpeed;
    int bestMaxSpeed;

    bool inRace;
    bool postRace;

    bool noclipSpawn;
    bool practicing;
    bool recalled;

    // pm
    uint[] messageTimes;
    uint messageLock;
    bool firstMessage;

    // hettoo : practicemode
    int noclipWeapon;
    Position practicePosition;
    Position preRacePosition;
    uint practiceFinish;
    Position noclipBackup;
    uint lastNoclipAction;
    Position lerpFrom;
    Position lerpTo;

    Position[] runPositions;
    int runPositionCount;
    uint nextRunPositionTime;
    int positionCycle;

    Position[] bestRunPositions;
    int bestRunPositionCount;

    void setupArrays( int size )
    {
        this.messageTimes.resize( MAX_FLOOD_MESSAGES );
        this.current_recordTime.setupArrays( size );
        this.best_recordTime.setupArrays( size );
        this.runPositions.resize( MAX_POSITIONS );
        this.bestRunPositions.resize( MAX_POSITIONS );
        this.arraysSetUp = true;
        this.clear();
    }

    void clear()
    {
        @this.client = null;

        this.currentCheckpoint = 0;

        this.inRace = false;
        this.postRace = false;
        this.practicing = false;
        this.recalled = false;
        this.practiceFinish = 0;
        this.startTime = 0;
        this.maxSpeed = 0;
        this.bestMaxSpeed = 0;
        this.runPositionCount = 0;
        this.nextRunPositionTime = 0;
        this.bestRunPositionCount = 0;
        this.positionCycle = 0;
        this.pos = -1;
        this.noclipSpawn = false;

        this.practicePosition.clear();
        this.preRacePosition.clear();
        this.noclipBackup.clear();
        this.lastNoclipAction = 0;
        this.lerpFrom.saved = false;
        this.lerpTo.saved = false;

        if ( !this.arraysSetUp )
            return;

        this.firstMessage = true;
        this.messageLock = 0;
        for ( int i = 0; i < MAX_FLOOD_MESSAGES; i++ )
            this.messageTimes[i] = 0;

        this.current_recordTime.clear();
        this.best_recordTime.clear();
    }

    Player()
    {
        this.arraysSetUp = false;
        this.clear();
    }

    ~Player() {}

    void setName()
    {
        this.current_recordTime.ident = RecordTimeIdent( client.name, client.getMMLogin() );
        this.best_recordTime.ident = this.current_recordTime.ident;
    }

    void setBestTime( uint time, int maxSpeed )
    {
        this.bestMaxSpeed = maxSpeed;
        this.updateScore();
    }

    void takeHistory( Player@ other )
    {
        this.runPositionCount = other.runPositionCount;
        this.positionCycle = 0;
        for ( int i = 0; i < this.runPositionCount; i++ )
            this.runPositions[i] = other.runPositions[i];
    }

    void updatePos()
    {
        this.pos = -1;
        // if ( this.best_recordTime.getFinishTime() == 0 )
        //     return;
        if ( !this.best_recordTime.isFinished() )
            return;

        String cleanName = this.client.name.removeColorTokens().tolower();
        for ( int i = 0; i < MAX_RECORDS; i++ )
        {
            if ( !levelRecords[ i ].isFinished() )
                break;

            if ( this.best_recordTime.getFinishTime() == levelRecords[ i ].getFinishTime() && cleanName == levelRecords[ i ].ident.cleanName )
            {
                this.pos = i + 1;
                break;
            }
        }
    }

    void updateScore()
    {
        this.client.stats.setScore( this.best_recordTime.getFinishTime() / 10 );
    }

    String@ scoreboardEntry()
    {
        Entity@ ent = this.client.getEnt();
        int playerID = ( ent.isGhosting() && ( match.getState() == MATCH_STATE_PLAYTIME ) ) ? -( ent.playerNum + 1 ) : ent.playerNum;
        String racing;
        String pos = "\u00A0";
        String speed;

        if ( this.practicing && this.recalled && ent.health > 0 && ent.moveType == MOVETYPE_PLAYER )
            racing = S_COLOR_CYAN + "Yes";
        else if ( this.practicing )
            racing = S_COLOR_CYAN + "No";
        else if ( this.inRace )
            racing = S_COLOR_GREEN + "Yes";
        else
            racing = S_COLOR_RED + "No";

        String diff;
        if ( this.best_recordTime.isFinished() && levelRecords[ 0 ].isFinished() && this.best_recordTime.getFinishTime() >= levelRecords[ 0 ].getFinishTime() )
        {
            uint change = this.best_recordTime.getFinishTime() - levelRecords[ 0 ].getFinishTime();
            if ( change == 0 )
                diff = S_COLOR_GREEN + "0";
            else if ( change >= 6000000 )
                diff = S_COLOR_RED + "+";
            else if ( change >= 100000 )
                diff = S_COLOR_RED + ( change / 60000 ) + "m";
            else if ( change >= 1000 && change < 10000 )
                diff = S_COLOR_ORANGE + ( change / 1000 ) + "." + ( ( change % 1000 ) / 100 ) + "s";
            else if ( change >= 1000 )
                diff = S_COLOR_ORANGE + ( change / 1000 ) + "s";
            else
                diff = S_COLOR_YELLOW + change;
            if ( this.pos != -1 )
                pos = this.pos;
        }
        else
        {
            diff = "\u00A0";
        }

        if ( this.best_recordTime.isFinished() )
            speed = this.bestMaxSpeed + "";
        else
            speed = "\u00A0";

        return "&p " + playerID + " " + ent.client.clanName + " " + pos + " " + this.best_recordTime.getFinishTime() + " " + diff + " " + speed + " " + ent.client.ping + " " + racing + " ";
    }

    bool preRace()
    {
        return !this.inRace && !this.practicing && !this.postRace && this.client.team != TEAM_SPECTATOR;
    }

    void setQuickMenu()
    {
        String s = '';
        Position@ position = this.savedPosition();

        s += menuItems[MI_RESTART_RACE];
        if ( this.practicing )
        {
            s += menuItems[MI_LEAVE_PRACTICE];
            if ( this.client.team != TEAM_SPECTATOR )
            {
                if ( this.client.getEnt().moveType == MOVETYPE_NOCLIP )
                    s += menuItems[MI_NOCLIP_OFF];
                else
                    s += menuItems[MI_NOCLIP_ON];
            }
            else
            {
                s += menuItems[MI_EMPTY];
            }
            s += menuItems[MI_SAVE_POSITION];
            if ( position.saved )
                s += menuItems[MI_LOAD_POSITION] +
                     menuItems[MI_CLEAR_POSITION];
        }
        else
        {
            s += menuItems[MI_ENTER_PRACTICE] +
                 menuItems[MI_EMPTY] +
                 menuItems[MI_SAVE_POSITION];
            if ( position.saved && ( this.preRace() || this.client.team == TEAM_SPECTATOR ) )
                s += menuItems[MI_LOAD_POSITION] +
                     menuItems[MI_CLEAR_POSITION];
        }

        GENERIC_SetQuickMenu( this.client, s );
    }

    bool toggleNoclip()
    {
        Entity@ ent = this.client.getEnt();
        if ( !this.practicing )
        {
            G_PrintMsg( ent, "Noclip mode is only available in practice mode.\n" );
            return false;
        }
        if ( this.client.team == TEAM_SPECTATOR )
        {
            G_PrintMsg( ent, "Noclip mode is not available for spectators.\n" );
            return false;
        }

        String msg;
        if ( ent.moveType == MOVETYPE_PLAYER ) // player is practicing, not noclip
        {
            this.cancelRace();
            ent.moveType = MOVETYPE_NOCLIP;
            this.noclipWeapon = ent.weapon;
            msg = "Noclip mode enabled.";
        }
        else // could be flying or recalling, going back into player mode?
        {
            uint moveType = ent.moveType;
            ent.moveType = MOVETYPE_PLAYER;
            this.client.selectWeapon( this.noclipWeapon );
            if ( this.recalled && moveType == MOVETYPE_NONE )
            {
                // think this should be same as position load
                this.startTime = this.timeStamp() - this.savedPosition().currentTime;
                if ( this.lerpTo.saved )
                {
                    this.applyPosition( this.lerpTo );
                    this.lerpFrom.saved = false;
                    this.lerpTo.saved = false;
                }
                else
                {
                    this.applyPosition( this.savedPosition() );
                }
            }
            this.noclipBackup.saved = false;
            msg = "Noclip mode disabled.";
        }

        G_PrintMsg( ent, msg + "\n" );

        this.setQuickMenu();

        return true;
    }

    Position@ savedPosition()
    {
        if ( this.preRace() )
            return preRacePosition;
        else
            return practicePosition;
    }

    void applyPosition( Position@ position )
    {
        Entity@ ent = this.client.getEnt();

        ent.origin = position.location;
        ent.angles = position.angles;
        ent.health = position.health;
        this.client.armor = position.armor;
        if ( ent.moveType != MOVETYPE_NOCLIP )
            ent.set_velocity( position.velocity );
        this.currentCheckpoint = position.currentCheckpoint;

        if ( !position.skipWeapons )
        {
            this.client.inventoryClear();
            for ( int i = WEAP_NONE + 1; i < WEAP_TOTAL; i++ )
            {
                if ( position.weapons[i] )
                    this.client.inventoryGiveItem( i );
                Item@ item = G_GetItem( i );
                this.client.inventorySetCount( item.ammoTag, position.ammos[i] );
            }
            for ( int i = POWERUP_QUAD; i < POWERUP_TOTAL; i++ )
                this.client.inventorySetCount( i, position.powerups[i - POWERUP_QUAD] );
            this.client.selectWeapon( position.weapon );
        }

        ent.teleported = true;
    }

    bool loadPosition( Verbosity verbosity )
    {
        Entity@ ent = this.client.getEnt();
        if ( !this.practicing && this.client.team != TEAM_SPECTATOR && !this.preRace() )
        {
            if ( verbosity == Verbosity_Verbose )
                G_PrintMsg( ent, "Position loading is not available during a race.\n" );
            return false;
        }

        this.noclipBackup.saved = false;

        Position@ position = this.savedPosition();

        if ( !position.saved )
        {
            if ( verbosity == Verbosity_Verbose )
                G_PrintMsg( ent, "No position has been saved yet.\n" );
            return false;
        }

        this.applyPosition( position );

        if ( this.preRace() )
        {
            ent.velocity = Vec3();
        }
        else if ( this.practicing && position.recalled )
        {
            this.cancelRace();
            this.recalled = true;
            this.startTime = this.timeStamp() - position.currentTime;
        }
        else if ( this.practicing )
        {
            this.recalled = false;
        }

        return true;
    }

    bool recallPosition( int offset )
    {
        Entity@ ent = this.client.getEnt();
        if ( !this.practicing || this.client.team == TEAM_SPECTATOR )
        {
            G_PrintMsg( ent, "Position recall is only available in practice mode.\n" );
            return false;
        }

        if ( this.runPositionCount == 0 )
        {
            G_PrintMsg( ent, "No position found.\n" );
            return false;
        }

        if ( !this.noclipBackup.saved )
        {
            this.noclipBackup.copy( this.currentPosition() );
            this.noclipBackup.saved = true;
            ent.moveType = MOVETYPE_NONE;
            G_CenterPrintMsg( ent, S_COLOR_CYAN + "Entered recall mode" );
        }

        this.positionCycle += offset;
        if ( this.positionCycle < 0 )
            this.positionCycle = ( this.runPositionCount - ( -this.positionCycle % this.runPositionCount ) ) % this.runPositionCount;
        else
            this.positionCycle %= this.runPositionCount;
        Position@ position = this.runPositions[this.positionCycle];

        this.applyPosition( position );
        Position@ saved = this.savedPosition();
        saved.copy( position );
        saved.saved = true;
        saved.recalled = true;
        this.recalled = true;
        saved.skipWeapons = false;

        this.startTime = this.timeStamp() - position.currentTime;

        this.setQuickMenu();

        return true;
    }

    Position@ currentPosition()
    {
        Position@ result = Position();
        result.saved = false;
        result.recalled = false;
        Client@ ref = this.client;
        if ( this.client.team == TEAM_SPECTATOR && this.client.chaseActive && this.client.chaseTarget != 0 )
            @ref = G_GetEntity( this.client.chaseTarget ).client;
        Entity@ ent = ref.getEnt();
        result.location = ent.origin;
        result.angles = ent.angles;
        result.velocity = ent.get_velocity();
        result.health = ent.health;
        result.armor = ref.armor;
        result.skipWeapons = false;
        result.currentCheckpoint = this.currentCheckpoint;
        result.currentTime = this.raceTime();
        for ( int i = WEAP_NONE + 1; i < WEAP_TOTAL; i++ )
        {
            result.weapons[i] = ref.canSelectWeapon( i );
            Item@ item = G_GetItem( i );
            result.ammos[i] = ref.inventoryCount( item.ammoTag );
        }
        for ( int i = POWERUP_QUAD; i < POWERUP_TOTAL; i++ )
            result.powerups[i - POWERUP_QUAD] = ref.inventoryCount( i );
        result.weapon = ( ent.moveType == MOVETYPE_NOCLIP || ent.moveType == MOVETYPE_NONE ) ? this.noclipWeapon : ref.pendingWeapon;
        return result;
    }

    bool savePosition()
    {
        Client@ ref = this.client;
        if ( this.client.team == TEAM_SPECTATOR && this.client.chaseActive && this.client.chaseTarget != 0 )
            @ref = G_GetEntity( this.client.chaseTarget ).client;
        Entity@ ent = ref.getEnt();

        if ( this.preRace() )
        {
            Vec3 mins, maxs;
            ent.getSize( mins, maxs );
            Vec3 down = ent.origin;
            down.z -= 1;
            Trace tr;
            if ( !tr.doTrace( ent.origin, mins, maxs, down, ent.entNum, MASK_PLAYERSOLID ) )
            {
                G_PrintMsg( this.client.getEnt(), "You can only save your prerace position on solid ground.\n" );
                return false;
            }

            if ( maxs.z < 40 )
            {
                G_PrintMsg( this.client.getEnt(), "You can't save your prerace position while crouched.\n" );
                return false;
            }
        }

        Position@ position = this.savedPosition();

        position.velocity = HorizontalVelocity( position.velocity );
        float speed;
        if ( position.saved && !position.recalled )
            speed = position.velocity.length();
        else
            speed = 0;

        position.copy( this.currentPosition() );
        position.saved = true;
        position.recalled = false;

        Vec3 a, b, c;
        position.angles.angleVectors( a, b, c );
        a = HorizontalVelocity( a );
        a.normalize();
        position.velocity = a * speed;

        position.skipWeapons = ref.team == TEAM_SPECTATOR;

        this.setQuickMenu();

        return true;
    }

    bool clearPosition()
    {
        if ( !this.practicing && this.client.team != TEAM_SPECTATOR && !this.preRace() )
        {
            G_PrintMsg( this.client.getEnt(), "Position clearing is not available during a race.\n" );
            return false;
        }

        this.savedPosition().clear();
        this.setQuickMenu();

        return true;
    }

    uint timeStamp()
    {
        return this.client.uCmdTimeStamp;
    }

    bool startRace()
    {
        if ( !this.preRace() )
            return false;

        this.currentCheckpoint = 0;
        this.inRace = true;
        RACE_AttemptStarted( this ); // every genuine start counts (racelog.as)
        this.startTime = this.timeStamp();
        this.runPositionCount = 0;
        this.positionCycle = 0;
        this.nextRunPositionTime = this.timeStamp() + POSITION_INTERVAL;

        if ( RS_QueryPjState( this.client.playerNum )  )
        {
          this.client.addAward( S_COLOR_RED + "Prejumped!" );

            // for accuracy, reset scores.
            target_score_init( this.client );

          this.client.respawn( false );
          RS_ResetPjState( this.client.playerNum );
          return false;
        }

        // for ( int i = 0; i < numCheckpoints; i++ )
        //     this.sectorTimes[i] = 0;
        this.current_recordTime.clearCheckpoints();

        // this.report.reset();

        this.client.newRaceRun( numCheckpoints );

        this.setQuickMenu();

        return true;
    }

    void saveRunPosition()
    {
        if ( !this.inRace || this.timeStamp() < this.nextRunPositionTime || this.runPositionCount == MAX_POSITIONS )
            return;

        Entity@ ent = this.client.getEnt();
        Vec3 mins, maxs;
        ent.getSize( mins, maxs );
        Vec3 down = ent.origin;
        down.z -= POSITION_HEIGHT;
        Trace tr;
        if ( tr.doTrace( ent.origin, mins, maxs, down, ent.entNum, MASK_PLAYERSOLID ) && tr.surfFlags & SURF_SLICK == 0 )
            return;

        this.runPositions[ this.runPositionCount++ ] = this.currentPosition();
        this.nextRunPositionTime = this.timeStamp() + POSITION_INTERVAL;
    }

    uint getSpeed()
    {
        return uint( HorizontalSpeed( this.client.getEnt().velocity ) );
    }

    void checkNoclipAction()
    {
        Entity@ ent = this.client.getEnt();

        if ( !this.practicing || this.client.team == TEAM_SPECTATOR || ( ent.moveType != MOVETYPE_NOCLIP && ent.moveType != MOVETYPE_NONE ) || ent.health <= 0 )
            return;

        uint keys = this.client.pressedKeys;

        if ( this.runPositionCount == 0 )
        {
            if ( keys & Key_Attack != 0 )
                G_CenterPrintMsg( ent, "No positions saved" );
            return;
        }

        uint passed = levelTime - this.lastNoclipAction;
        if ( passed < RECALL_ACTION_TIME )
        {
            if ( this.lerpTo.saved )
            {
                float lerp = float( passed ) / float( RECALL_ACTION_TIME );
                this.applyPosition( Lerp( this.lerpFrom, lerp, this.lerpTo ) );
            }
            return;
        }

        if ( this.lerpTo.saved )
        {
            this.applyPosition( this.lerpTo );
            this.lerpFrom.saved = false;
            this.lerpTo.saved = false;
        }

        this.lastNoclipAction = levelTime;

        if ( keys & Key_Attack != 0 )
        {
            if ( this.noclipBackup.saved )
            {
                ent.moveType = MOVETYPE_NOCLIP;
                this.applyPosition( this.noclipBackup );
                ent.set_velocity( Vec3() );
                this.noclipBackup.saved = false;
                this.recalled = false;
                G_CenterPrintMsg( ent, S_COLOR_CYAN + "Left recall mode" );
            }
            else
            {
                this.recallPosition( 0 );
            }
        }
        else if ( keys & Key_Backward != 0 && this.noclipBackup.saved )
        {
            if ( this.positionCycle == 0 )
            {
                this.recallPosition( -1 );
            }
            else
            {
                this.lerpFrom.copy( this.savedPosition() );
                this.recallPosition( -1 );
                this.lerpTo.copy( this.savedPosition() );
                this.applyPosition( lerpFrom );
            }
        }
        else if ( keys & Key_Left != 0 && this.noclipBackup.saved )
        {
            if ( this.positionCycle < RECALL_ACTION_JUMP )
            {
                this.recallPosition( -this.positionCycle - 1 );
            }
            else
            {
                this.lerpFrom.copy( this.savedPosition() );
                this.recallPosition( -RECALL_ACTION_JUMP );
                this.lerpTo.copy( this.savedPosition() );
                this.applyPosition( lerpFrom );
            }
        }
        else if ( keys & Key_Forward != 0 && this.noclipBackup.saved )
        {
            this.lerpFrom.copy( this.savedPosition() );
            this.recallPosition( 1 );
            if ( this.positionCycle == 0 )
            {
                this.lerpFrom.saved = false;
            }
            else
            {
                this.lerpTo.copy( this.savedPosition() );
                this.applyPosition( this.lerpFrom );
            }
        }
        else if ( keys & Key_Right != 0 && this.noclipBackup.saved )
        {
            this.lerpFrom.copy( this.savedPosition() );
            this.recallPosition( RECALL_ACTION_JUMP );
            if ( this.positionCycle < RECALL_ACTION_JUMP )
            {
                this.lerpFrom.saved = false;
                this.recallPosition( -this.positionCycle );
            }
            else
            {
                this.lerpTo.copy( this.savedPosition() );
                this.applyPosition( this.lerpFrom );
            }
        }
        else
        {
            this.lastNoclipAction = 0;
        }
    }

    void updateMaxSpeed()
    {
        if ( !this.inRace )
            return;

        uint current = this.getSpeed();
        if ( current > this.maxSpeed )
            this.maxSpeed = current;
    }

    uint raceTime()
    {
        return this.timeStamp() - this.startTime;
    }

    bool validTime()
    {
        return this.raceTime() >= 0; // TODO: should this be 1 ?
    }

    void cancelRace()
    {
        Entity@ ent = this.client.getEnt();

        if ( this.inRace && this.currentCheckpoint > 0 )
        {
            this.current_recordTime.report( this );
            G_PrintMsg( ent, S_COLOR_ORANGE + "Race cancelled, max speed " + S_COLOR_WHITE + this.maxSpeed + "\n" );
        }

        Position@ position = this.savedPosition();
        if ( this.practicing && this.recalled )
        {
            if ( this.currentCheckpoint > position.currentCheckpoint && ent.moveType == MOVETYPE_PLAYER )
            {
                this.current_recordTime.report( this );
                G_PrintMsg( ent, S_COLOR_CYAN + "Practice run cancelled\n" );
            }
            else if ( ent.moveType == MOVETYPE_NONE && this.lerpTo.saved )
            {
                this.applyPosition( this.lerpTo );
                this.lerpFrom.saved = false;
                this.lerpTo.saved = false;
            }
        }
        this.recalled = false;

        this.current_recordTime.clearCheckpoints();

        this.inRace = false;
        this.postRace = false;
        this.maxSpeed = 0;
    }

    void completeRace()
    {
        if ( this.practicing && !this.recalled )
        {
            if ( this.practiceFinish == 0 || this.timeStamp() > this.practiceFinish + 5000 )
            {
                this.client.addAward( S_COLOR_CYAN + "Finished in practicemode!" );
                this.practiceFinish = this.timeStamp();
            }
            return;
        }

        if ( !this.validTime() ) // something is very wrong here
            return;

        if ( this.practicing )
            this.client.addAward( S_COLOR_CYAN + "Practice Run Finished!" );
        else
            this.client.addAward( S_COLOR_CYAN + "Race Finished!" );

        this.practiceFinish = this.timeStamp(); // TODO: what is this

        this.recalled = false;

        uint finishTime = this.raceTime();
        this.updateMaxSpeed();
        this.inRace = false;
        if ( !this.practicing )
            this.postRace = true;

        // send the final time to MM
        if ( !this.practicing )
            this.client.setRaceTime( -1, finishTime );

        this.current_recordTime.checkpoints[ numCheckpoints ] = Checkpoint( finishTime, this.getSpeed(), this.maxSpeed, CheckpointType_Finish );
        this.current_recordTime.checkpoint_order[ this.currentCheckpoint ] = numCheckpoints;
        this.current_recordTime.type = RecordTimeType_Finished;

        this.current_recordTime.checkpoints[ numCheckpoints ].print( this, numCheckpoints );

        this.current_recordTime.report( this );

        if ( !this.practicing )
        {
            RACE_LogFinish( this );

            if ( !this.best_recordTime.isFinished() || finishTime < this.best_recordTime.getFinishTime() )
            {
                // this.client.addAward( S_COLOR_YELLOW + "Personal record!" );
                // copy all the sectors into the new personal record backup
                this.setBestTime( finishTime, this.maxSpeed );

                this.bestRunPositionCount = this.runPositionCount;
                for ( int i = 0; i < this.runPositionCount; i++ )
                    this.bestRunPositions[ i ] = this.runPositions[ i ];

                this.best_recordTime = this.current_recordTime;
            }

            uint pos = RACE_AddTopScore( this.best_recordTime );
            if ( pos == 0 )
            {
                String str = this.client.name + S_COLOR_YELLOW + " set a new " + SERVER_NAME + S_COLOR_YELLOW + " record: " + S_COLOR_GREEN + RACE_TimeToString( finishTime );
                if ( levelRecords[ 1 ].isFinished() )
                    str += " " + S_COLOR_YELLOW + "[-" + RACE_TimeToString( levelRecords[ 1 ].getFinishTime() - finishTime ) + "]";
                G_PrintMsg( null, str + "\n" );
            }
            

            RACE_WriteTopScores();
            RACE_UpdateHUDTopScores();
            RACE_UpdatePosValues();

            // set up for respawning the player with a delay
            Entity@ respawner = G_SpawnEntity( "race_respawner" );
            respawner.nextThink = levelTime + 5000;
            @respawner.think = race_respawner_think;
            respawner.count = this.client.playerNum;
        }
    }

    bool touchCheckPoint( uint id )
    {
        if ( id < 0 || id >= numCheckpoints )
            return false;

        if ( !this.inRace && ( !this.practicing || !this.recalled ) )
            return false;

        if( this.current_recordTime.checkpoints[ id ].type != CheckpointType_Unused ) // already passed this checkPoint
            return false;

        if ( !this.validTime() ) // something is very wrong here
            return false;

        this.updateMaxSpeed();

        uint time = this.raceTime();
        this.current_recordTime.checkpoints[ id ] = Checkpoint( time, this.getSpeed(), this.maxSpeed, CheckpointType_Normal );
        this.current_recordTime.checkpoint_order[ this.currentCheckpoint++ ] = id;

        // print some output and give awards if earned
        this.current_recordTime.checkpoints[ id ].print( this, id );

        // send this checkpoint to MM
        if ( !this.practicing )
            this.client.setRaceTime( id, time );

        G_AnnouncerSound( this.client, G_SoundIndex( "sounds/misc/timer_bip_bip" ), GS_MAX_TEAMS, false, null );

        return true;
    }

    void enterPracticeMode()
    {
        if ( this.practicing )
            return;

        this.practicing = true;
        this.recalled = false;
        G_CenterPrintMsg( this.client.getEnt(), S_COLOR_CYAN + "Entered practice mode" );

        this.cancelRace();
        this.setQuickMenu();

        // msc: practicemode message
        client.setHelpMessage( practiceModeMsg );

        Client@[] specs = RACE_GetSpectators( this.client );
        for ( uint i = 0; i < specs.length; i++ )
            specs[i].setHelpMessage( practiceModeMsg );
    }

    void leavePracticeMode()
    {
        if ( !this.practicing )
            return;

        // for accuracy, reset scores.
        target_score_init( this.client );

        this.cancelRace();
        this.practicing = false;
        G_CenterPrintMsg( this.client.getEnt(), S_COLOR_CYAN + "Left practice mode" );
        if ( this.client.team != TEAM_SPECTATOR )
            this.client.respawn( false );
        this.setQuickMenu();

        // msc: practicemode message
        client.setHelpMessage(defaultMsg);

        Client@[] specs = RACE_GetSpectators( this.client );
        for ( uint i = 0; i < specs.length; i++ )
            specs[i].setHelpMessage(defaultMsg);
    }

    void togglePracticeMode()
    {
        if ( pending_endmatch )
            this.client.printMessage("Can't join practicemode in overtime.\n");
        else if ( this.practicing )
            this.leavePracticeMode();
        else
            this.enterPracticeMode();
    }

    bool recallExit()
    {
        if ( this.client.team == TEAM_SPECTATOR || !this.practicing )
        {
            G_PrintMsg( this.client.getEnt(), "Not available.\n" );
            return false;
        }

        if ( !this.noclipBackup.saved )
            return true;

        Entity@ ent = this.client.getEnt();
        ent.moveType = MOVETYPE_NOCLIP;
        this.applyPosition( this.noclipBackup );
        ent.set_velocity( Vec3() );
        this.noclipBackup.saved = false;
        this.recalled = false;
        G_CenterPrintMsg( ent, S_COLOR_CYAN + "Left recall mode" );
        return true;
    }

    bool recallSteal()
    {
        if ( this.client.team == TEAM_SPECTATOR && this.client.chaseActive && this.client.chaseTarget != 0 )
        {
            this.takeHistory( RACE_GetPlayer( G_GetEntity( this.client.chaseTarget ).client ) );
        }
        else
        {
            G_PrintMsg( this.client.getEnt(), "Not available.\n" );
            return false;
        }
        return true;
    }

    bool recallBest( String pattern )
    {
        if ( this.inRace )
        {
            G_PrintMsg( this.client.getEnt(), "Not possible during a race.\n" );
            return false;
        }

        Player@ target = this;

        if ( pattern != "" )
        {
            Player@[] matches = RACE_MatchPlayers( pattern );
            if ( matches.length() == 0 )
            {
                G_PrintMsg( this.client.getEnt(), "No players matched.\n" );
                return false;
            }
            else if ( matches.length() > 1 )
            {
                G_PrintMsg( this.client.getEnt(), "Multiple players matched:\n" );
                for ( uint i = 0; i < matches.length(); i++ )
                    G_PrintMsg( this.client.getEnt(), matches[i].client.name + S_COLOR_WHITE + "\n" );
                return false;
            }
            else
            {
                @target = matches[0];
            }
        }

        if ( target.bestRunPositionCount == 0 )
        {
            G_PrintMsg( this.client.getEnt(), "No best run recorded.\n" );
            return false;
        }

        this.runPositionCount = target.bestRunPositionCount;
        for ( int i = 0; i < this.runPositionCount; i++ )
            this.runPositions[i] = target.bestRunPositions[i];
        this.positionCycle = 0;

        if ( this.practicing && this.client.team != TEAM_SPECTATOR )
            return this.recallPosition( 0 );
        else
            return true;
    }

    bool recallStart()
    {
        return this.recallPosition( -this.positionCycle );
    }

    bool recallEnd()
    {
        return this.recallPosition( -this.positionCycle - 1 );
    }

    bool recallCheckpoint( uint cp )
    {
        int index = -1;
        for ( int i = 0; i < this.runPositionCount; i++ )
        {
            if ( this.runPositions[i].currentCheckpoint == cp )
            {
                index = i;
                break;
            }
        }
        if ( index != -1 )
        {
            return this.recallPosition( index - this.positionCycle );
        }
        else
        {
            G_PrintMsg( this.client.getEnt(), "Not found.\n" );
            return false;
        }
    }

    bool recallWeapon( uint weapon )
    {
        int index = -1;
        for ( int i = 0; i < this.runPositionCount; i++ )
        {
            if ( this.runPositions[i].weapons[weapon] )
            {
                index = i;
                break;
            }
        }
        if ( index != -1 )
        {
            return this.recallPosition( index - this.positionCycle );
        }
        else
        {
            G_PrintMsg( this.client.getEnt(), "Not found.\n" );
            return false;
        }
    }

    bool positionSpeed( String speedStr )
    {
        Position@ position = this.savedPosition();
        float speed = 0;
        if ( speedStr.locate( "+", 0 ) == 0 )
            speed += speedStr.substr( 1 ).toFloat();
        else if ( speedStr.locate( "-", 0 ) == 0 )
            speed -= speedStr.substr( 1 ).toFloat();
        else
            speed = speedStr.toFloat();
        Vec3 a, b, c;
        position.angles.angleVectors( a, b, c );
        a = HorizontalVelocity( a );
        a.normalize();
        position.velocity = a * speed;
        position.recalled = false;
        return true;
    }
}

Player@ RACE_GetPlayer( Client@ client )
{
    if ( @client == null || client.playerNum < 0 )
        return null;

    Player@ player = players[client.playerNum];
    @player.client = @client;

    return player;
}

Player@[] RACE_MatchPlayers( String pattern )
{
    pattern = pattern.removeColorTokens().tolower();

    Player@[] playerList;
    for ( int i = 0; i < maxClients; i++ )
    {
        Client@ client = @G_GetClient(i);
        String clean = client.name.removeColorTokens().tolower();

        if ( PatternMatch( clean, pattern ) )
            playerList.push_back( RACE_GetPlayer( client ) );
    }
    return playerList;
}

void RACE_UpdatePosValues()
{
    Team@ team = G_GetTeam( TEAM_PLAYERS );
    for ( int i = 0; @team.ent( i ) != null; i++ )
        RACE_GetPlayer( team.ent( i ).client ).updatePos();
}
