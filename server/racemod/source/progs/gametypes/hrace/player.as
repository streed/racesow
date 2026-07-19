const int MAX_POSITIONS = 400;
const int POSITION_INTERVAL = 500;
const float POSITION_HEIGHT = 24;

// Replay ghost capture: a high-rate trajectory recorded for the whole run and,
// on a new world record, uploaded to the web (hrace/demos.as) for the browser
// viewer + the in-game WR ghost racer (hrace/ghostbot.as). Separate from the
// 2 Hz recall buffer above, which skips airborne/solid-ground samples and is
// far too coarse for smooth playback.
const int MAX_GHOST_FRAMES = 9000; // ~3 min at 50 Hz
const int GHOST_INTERVAL = 20;     // ms of RACE time between samples (~50 Hz, smoother playback)

const int RECALL_ACTION_TIME = 200;
const int RECALL_ACTION_JUMP = 5;
// Frames a recalled player stays frozen (MOVETYPE_NONE) after respawning into a
// recalled position before movement unfreezes — keeps walljump/dash starts
// timing-consistent ("/position recall delay").
const int RECALL_HOLD = 20;

// Noclip point-pull ("grapple"): in practice-mode noclip, holding Attack+Special
// eases the player toward whatever surface they are aiming at. POINT_PULL is the
// per-ms pull fraction; PULL_MARGIN keeps it from snapping onto a point-blank
// wall. Ported from hettoo/wsw-race (uses a linear frame-time approximation of
// upstream's pow()-based factor, since pow() isn't registered in this engine).
const float POINT_DISTANCE = 65536.0f;
const float POINT_PULL = 0.004f;
const float PULL_MARGIN = 16.0f;

// "/position find <type> info" only dumps per-entity detail for lists smaller
// than this (a big list would spam the console).
const uint BIG_LIST = 15;

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

    // Reverse mode (/reverse): race the course backwards — start by crossing the
    // map's finish line, run the checkpoints in reverse, end at the start line.
    // `reversed` is the active state; records go to the "<map>-reversed" level
    // and its own board. Enabling it teleports the player to the reverse start
    // and drops them into a fine-tune noclip (`reverseSetup`); leaving that
    // noclip saves their final spawn and arms them. reverseSetup is NOT
    // practicemode, so the run still records.
    bool reversed;
    bool reverseSetup;
    // The normal prerace spawn, stashed while reversed (reverse mode overwrites
    // the prerace slot with the reverse start) and restored on /reverse off.
    Position preReverseMain;
    bool preReverseMainSaved;

    // /showtriggers: per-player beacon entities marking the start/finish trigger
    // planes, visible only to this client (like /mark). Freed on toggle-off and
    // in clear().
    bool showingTriggers;
    Entity@[] triggerMarkers;

    // "/position find" cursor: last searched entity type + which match to cycle to
    String lastFind;
    uint findIndex;

    // "/mark": a client-only dummy model dropped at the player's position as a
    // visual route reference (null when none placed).
    Entity@ marker;

    // "/prerandmap": last previewed random map + the pattern it matched.
    String randmap;
    String randmapPattern;
    uint randmapMatches;

    // pm
    uint[] messageTimes;
    uint messageLock;
    bool firstMessage;

    // hettoo : practicemode
    int noclipWeapon;
    PositionStore preRacePositionStore;
    PositionStore practicePositionStore;
    uint practiceFinish;
    Position noclipBackup;
    uint lastNoclipAction;
    Position lerpFrom;
    Position lerpTo;

    Position[] runPositions;
    int runPositionCount;
    uint nextRunPositionTime;
    int positionCycle;

    // Recall tuning: sample interval (ms), auto-recall extend state, and the
    // post-respawn freeze counter ("recall delay").
    int positionInterval;
    bool autoRecall;
    int autoRecallStart;
    int recallHold;
    uint release;

    Position[] bestRunPositions;
    int bestRunPositionCount;

    // 25 Hz replay ghost buffers (current run + the best/WR run).
    Vec3[] ghostOrigin;
    Vec3[] ghostAngle;
    Vec3[] ghostVel;
    int[] ghostKeys;      // Warsow pressedKeys bitmask per frame (for the viewer)
    int ghostCount;
    int[] ghostCp;        // ghost-frame index at each checkpoint crossing
    int ghostCpCount;
    Vec3[] bestGhostOrigin;
    Vec3[] bestGhostAngle;
    Vec3[] bestGhostVel;
    int[] bestGhostKeys;
    int bestGhostCount;
    int[] bestGhostCp;
    int bestGhostCpCount;

    void setupArrays( int size )
    {
        this.messageTimes.resize( MAX_FLOOD_MESSAGES );
        this.current_recordTime.setupArrays( size );
        this.best_recordTime.setupArrays( size );
        this.runPositions.resize( MAX_POSITIONS );
        this.bestRunPositions.resize( MAX_POSITIONS );
        this.ghostOrigin.resize( MAX_GHOST_FRAMES );
        this.ghostAngle.resize( MAX_GHOST_FRAMES );
        this.ghostVel.resize( MAX_GHOST_FRAMES );
        this.ghostKeys.resize( MAX_GHOST_FRAMES );
        this.bestGhostOrigin.resize( MAX_GHOST_FRAMES );
        this.bestGhostAngle.resize( MAX_GHOST_FRAMES );
        this.bestGhostVel.resize( MAX_GHOST_FRAMES );
        this.bestGhostKeys.resize( MAX_GHOST_FRAMES );
        this.ghostCp.resize( size );
        this.bestGhostCp.resize( size );
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
        this.reversed = false;
        this.reverseSetup = false;
        this.preReverseMainSaved = false;
        this.preReverseMain.clear();
        this.showingTriggers = false;
        this.freeTriggerMarkers();
        this.lastFind = "";
        this.findIndex = 0;
        // Free (not just drop) any marker dummy: clear() runs on enterGame when a
        // slot is (re)used mid-map, and merely nulling the handle would orphan the
        // edict until map change — visible to the slot's next occupant via
        // SVF_ONLYOWNER/ownerNum, and a slow edict leak on busy servers. The
        // handle is always same-map valid: the script VM is rebuilt per map
        // (GT_asLoadScript runs unconditionally in G_Gametype_Init each level).
        if ( @this.marker != null )
        {
            this.marker.unlinkEntity();
            this.marker.freeEntity();
            @this.marker = null;
        }
        this.randmap = "";
        this.randmapPattern = "";
        this.randmapMatches = 0;
        this.practiceFinish = 0;
        this.startTime = 0;
        this.maxSpeed = 0;
        this.bestMaxSpeed = 0;
        this.runPositionCount = 0;
        this.nextRunPositionTime = 0;
        this.bestRunPositionCount = 0;
        this.positionCycle = 0;
        this.positionInterval = POSITION_INTERVAL;
        this.autoRecall = false;
        this.autoRecallStart = -1;
        this.recallHold = RECALL_HOLD;
        this.release = 0;
        this.ghostCount = 0;
        this.ghostCpCount = 0;
        this.bestGhostCount = 0;
        this.bestGhostCpCount = 0;
        this.pos = -1;
        this.noclipSpawn = false;

        this.practicePositionStore.clear();
        this.preRacePositionStore.clear();
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

        RecordTime[]@ levelRecords = RACE_Records( this.reversed );
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
        RecordTime[]@ levelRecords = RACE_Records( this.reversed );
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

        if ( pending_endmatch || match.getState() >= MATCH_STATE_POSTMATCH )
        {
            G_PrintMsg( ent, "Can't use noclip in overtime.\n" );
            return false;
        }

        // In reverse mode, /noclip is the fine-tune noclip (never practicemode, so
        // the run still records): leaving it locks in your reverse start
        // (finalizeReverse), and toggling back in lets you re-adjust it.
        if ( this.reversed )
        {
            if ( this.reverseSetup )
                return this.finalizeReverse();
            if ( ent.health <= 0 || this.client.team == TEAM_SPECTATOR )
            {
                G_PrintMsg( ent, "Not available right now.\n" );
                return false;
            }
            this.reverseSetup = true;
            ent.moveType = MOVETYPE_NOCLIP;
            ent.set_velocity( Vec3() );
            this.noclipWeapon = ent.weapon;
            G_CenterPrintMsg( ent, S_COLOR_CYAN + "Adjust your reverse start,\nthen /noclip to lock it in" );
            this.setQuickMenu();
            return true;
        }

        // From spectator or while dead: join (if needed), enter practicemode,
        // and respawn IN PLACE in noclip. enterPracticeMode() does not respawn,
        // so this is safe to call before the respawn; the GT_PlayerRespawn
        // noclipSpawn block then puts the fresh body into noclip.
        if ( this.client.team == TEAM_SPECTATOR || ent.health <= 0 )
        {
            Vec3 origin = ent.origin;
            Vec3 angles = ent.angles;
            if ( this.client.team == TEAM_SPECTATOR )
            {
                this.client.team = TEAM_PLAYERS;
                G_PrintMsg( null, this.client.name + S_COLOR_WHITE + " joined the " + G_GetTeam( this.client.team ).name + S_COLOR_WHITE + " team.\n" );
            }
            if ( !this.practicing )
                this.enterPracticeMode();
            this.noclipSpawn = true;
            this.client.respawn( false );
            ent.origin = origin;
            ent.angles = angles;
            return true;
        }

        // Auto-enter practicemode rather than refusing.
        if ( !this.practicing )
            this.enterPracticeMode();

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
            this.release = 0; // manually leaving the freeze cancels the recall-hold
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
                this.autoRecallStart = this.positionCycle;
            }
            this.noclipBackup.saved = false;
            msg = "Noclip mode disabled.";
        }

        G_PrintMsg( ent, msg + "\n" );

        this.setQuickMenu();

        return true;
    }

    // /reverse ON: enable reverse mode, TELEPORT the player to a spot just
    // outside the map's FINISH line (their reverse start), and drop them into a
    // fine-tune noclip so they can adjust it. A tentative spawn is saved now;
    // leaving the noclip (/noclip or /reverse -> finalizeReverse) saves the final
    // spawn and arms them. That spawn is the prerace slot, so /kill, /racerestart
    // and the post-finish respawn all return here. Deliberately NOT practicemode,
    // so the run records to "<map>-reversed".
    bool enableReverse()
    {
        Entity@ ent = this.client.getEnt();

        if ( pending_endmatch || match.getState() >= MATCH_STATE_POSTMATCH )
        {
            G_PrintMsg( ent, "Can't use reverse mode in overtime.\n" );
            return false;
        }

        // Reversing only makes sense if the map has both a start and a finish
        // line to swap (checkpoints are optional).
        if ( entityFinder.starts.length() == 0 || entityFinder.finishes.length() == 0 )
        {
            G_PrintMsg( ent, S_COLOR_RED + "This map has no start/finish line to reverse.\n" );
            return false;
        }

        // Never carry practicemode/recall into a reverse run — it must record.
        if ( this.practicing )
            this.leavePracticeMode();
        this.cancelRace();

        this.reversed = true;
        this.resetBestForMode(); // point best_recordTime at the reverse board

        // A live body is required to teleport + save a prerace spawn.
        if ( this.client.team == TEAM_SPECTATOR || ent.health <= 0 )
        {
            if ( this.client.team == TEAM_SPECTATOR )
            {
                this.client.team = TEAM_PLAYERS;
                G_PrintMsg( null, this.client.name + S_COLOR_WHITE + " joined the " + G_GetTeam( this.client.team ).name + S_COLOR_WHITE + " team.\n" );
            }
            this.client.respawn( false );
            @ent = this.client.getEnt();
        }

        // Stash any normal prerace spawn so /reverse off can restore it.
        Position@ main = this.preRacePositionStore.get( "" );
        this.preReverseMainSaved = ( @main != null && main.saved );
        if ( this.preReverseMainSaved )
            this.preReverseMain.copy( main );

        // Teleport to the reverse start and save it as a TENTATIVE spawn (so a
        // death during setup returns here); the final spawn is committed when the
        // player leaves the fine-tune noclip below.
        Vec3 origin, angles;
        if ( this.computeReverseStart( origin, angles ) )
        {
            ent.origin = origin;
            ent.angles = angles;
            ent.set_velocity( Vec3() );
            ent.teleported = true;
            this.storeReverseSpawn();
        }

        // Fine-tune noclip: fly to the exact start, then /noclip (or /reverse) to
        // lock it in. reverseSetup is set AFTER the join-respawn above so
        // GT_PlayerRespawn's reverseSetup reset can't race it.
        this.reverseSetup = true;
        ent.moveType = MOVETYPE_NOCLIP;
        ent.set_velocity( Vec3() );
        this.noclipWeapon = ent.weapon;

        G_CenterPrintMsg( ent, S_COLOR_CYAN + "Reverse: fine-tune your start in noclip,\nthen /noclip to lock it in" );
        this.setQuickMenu();
        return true;
    }

    // Write the player's current position into the prerace spawn slot (slot 0),
    // so every respawn returns here. Written directly (not via savePosition) to
    // skip its user-facing "not on solid ground" messages.
    void storeReverseSpawn()
    {
        Position@ p = this.currentPosition();
        p.saved = true;
        p.recalled = false;
        p.velocity = Vec3();
        p.skipWeapons = false;
        this.preRacePositionStore.set( "", p );
    }

    // Leave the reverse fine-tune noclip: drop to normal movement where the
    // player is now, SAVE that as the reverse spawn (so /kill and restarts return
    // here), and arm the run — crossing the finish line then starts the timer.
    bool finalizeReverse()
    {
        Entity@ ent = this.client.getEnt();
        this.reverseSetup = false;
        if ( ent.moveType == MOVETYPE_NOCLIP || ent.moveType == MOVETYPE_NONE )
        {
            ent.moveType = MOVETYPE_PLAYER;
            this.client.selectWeapon( this.noclipWeapon );
        }
        ent.set_velocity( Vec3() );
        this.release = 0;
        this.storeReverseSpawn();
        G_CenterPrintMsg( ent, S_COLOR_CYAN + "Reverse start saved —\ncross the FINISH line to start" );
        this.setQuickMenu();
        return true;
    }

    // Compute a reverse-start spot just OUTSIDE the finish trigger, on solid
    // ground, facing the finish — so the player runs through the finish plane to
    // start (mirroring a normal start line). The outward direction is away from
    // the course: opposite the last checkpoint (nearest the finish), or the
    // start line if the map has no checkpoints. Falls back to the finish centre
    // when no standable spot is found (the player can /position save to fix it).
    bool computeReverseStart( Vec3 &out origin, Vec3 &out angles )
    {
        EntityList@ finishes = entityFinder.allEntities( "finish" );
        if ( finishes.isEmpty() )
            return false;
        Entity@ fin = finishes.getEnt( 0 );
        if ( @fin == null )
            return false;
        Vec3 fmins, fmaxs;
        fin.getSize( fmins, fmaxs );
        Vec3 center = fin.origin + 0.5f * ( fmins + fmaxs );

        Vec3 courtside = center;
        bool haveRef = false;
        EntityList@ cps = entityFinder.allEntities( "cp" );
        uint bestCount = 0;
        for ( uint i = 0; i < cps.length(); i++ )
        {
            Entity@ cp = cps.getEnt( i );
            if ( @cp == null )
                continue;
            if ( !haveRef || uint( cp.count ) >= bestCount )
            {
                bestCount = uint( cp.count );
                courtside = cps.getPosition( i );
                haveRef = true;
            }
        }
        if ( !haveRef )
        {
            EntityList@ starts = entityFinder.allEntities( "start" );
            if ( !starts.isEmpty() )
            {
                courtside = starts.getPosition( 0 );
                haveRef = true;
            }
        }

        Vec3 dir = center - courtside;
        dir.z = 0;
        if ( dir.length() < 1 )
            dir = Vec3( 1, 0, 0 );
        dir.normalize();

        float spanX = fmaxs.x - fmins.x;
        float spanY = fmaxs.y - fmins.y;
        float halfSpan = 0.5f * ( spanX > spanY ? spanX : spanY );
        Vec3 spot = center + dir * ( halfSpan + 48.0f );
        spot.z = center.z + 16;

        Entity@ ent = this.client.getEnt();
        int ignore = ent.entNum;

        // Drop to the floor.
        Vec3 down = spot;
        down.z -= 4096;
        Trace tr;
        if ( tr.doTrace( spot, playerMins, playerMaxs, down, ignore, MASK_DEADSOLID ) && !tr.startSolid )
        {
            spot = tr.endPos;
            spot.z -= playerMins.z;
        }

        // Reject a spot where a standing hitbox does not fit; fall back to centre.
        Trace fit;
        if ( fit.doTrace( spot, playerMins, playerMaxs, spot, ignore, MASK_DEADSOLID ) )
            spot = center;

        Vec3 face = center - spot;
        face.z = 0;
        angles = face.toAngles();
        origin = spot;
        return true;
    }

    // /reverse OFF: drop reverse mode, restore the stashed normal prerace spawn
    // (or clear the slot), and respawn as a normal racer.
    bool disableReverse()
    {
        this.cancelRace();
        this.reversed = false;
        this.reverseSetup = false;
        this.resetBestForMode(); // point best_recordTime back at the standard board

        if ( this.preReverseMainSaved )
            this.preRacePositionStore.set( "", this.preReverseMain );
        else
            this.preRacePositionStore.remove( "" );
        this.preReverseMainSaved = false;

        Entity@ ent = this.client.getEnt();
        if ( ent.moveType == MOVETYPE_NOCLIP || ent.moveType == MOVETYPE_NONE )
            ent.moveType = MOVETYPE_PLAYER;
        this.release = 0;
        if ( this.client.team != TEAM_SPECTATOR )
            this.client.respawn( false );
        G_CenterPrintMsg( this.client.getEnt(), S_COLOR_CYAN + "Reverse mode off" );
        this.setQuickMenu();
        return true;
    }

    // /showtriggers: toggle per-player beacons marking the start & finish trigger
    // planes. Uses the /mark per-client pattern (SVF_ONLYOWNER) so only this
    // player sees them; a translucent ghost effect marks them as guides.
    bool toggleTriggerMarkers()
    {
        if ( this.showingTriggers )
        {
            this.freeTriggerMarkers();
            this.showingTriggers = false;
            G_PrintMsg( this.client.getEnt(), "Trigger markers off.\n" );
            return true;
        }

        this.freeTriggerMarkers(); // belt-and-suspenders before repopulating
        this.spawnTriggerMarkers( entityFinder.allEntities( "start" ) );
        this.spawnTriggerMarkers( entityFinder.allEntities( "finish" ) );
        this.showingTriggers = true;
        G_PrintMsg( this.client.getEnt(), "Trigger markers on: " + S_COLOR_GREEN + "start" + S_COLOR_WHITE + " and " + S_COLOR_RED + "finish" + S_COLOR_WHITE + " planes marked.\n" );
        return true;
    }

    void spawnTriggerMarkers( EntityList@ list )
    {
        Entity@ owner = this.client.getEnt();
        uint n = list.length();
        for ( uint i = 0; i < n; i++ )
        {
            Entity@ beacon = G_SpawnEntity( "dummy" );
            beacon.modelindex = G_ModelIndex( "models/players/bigvic/tris.iqm" );
            beacon.svflags |= SVF_ONLYOWNER;   // this client only
            beacon.svflags &= ~SVF_NOCLIENT;   // ...and actually transmit it
            beacon.effects |= EF_RACEGHOST_FLAG; // translucent -> reads as a guide
            beacon.ownerNum = owner.entNum;
            beacon.origin = list.getPosition( i );
            beacon.linkEntity();
            this.triggerMarkers.push_back( beacon );
        }
    }

    void freeTriggerMarkers()
    {
        for ( uint i = 0; i < this.triggerMarkers.length(); i++ )
        {
            if ( @this.triggerMarkers[i] != null )
            {
                this.triggerMarkers[i].unlinkEntity();
                this.triggerMarkers[i].freeEntity();
            }
        }
        this.triggerMarkers.resize( 0 );
    }

    // best_recordTime is a single per-player value, so switching between the
    // standard and reverse variant must re-point it at the current mode's board.
    // Otherwise a reverse run would be judged a "personal best" against a
    // STANDARD time — mis-awarding records and, worse, gating the reverse ghost/
    // demo upload (completeRace's newPersonalBest) on the wrong baseline. Clears
    // the previous mode's best + replay buffers, then re-seeds from this mode's
    // board by clean name (logins are empty since the auth servers are gone).
    void resetBestForMode()
    {
        this.best_recordTime.clear();
        this.bestMaxSpeed = 0;
        this.bestRunPositionCount = 0;
        this.bestGhostCount = 0;
        this.bestGhostCpCount = 0;

        RecordTime[]@ board = RACE_Records( this.reversed );
        String cleanName = this.client.name.removeColorTokens().tolower();
        for ( int i = 0; i < MAX_RECORDS; i++ )
        {
            if ( !board[ i ].isFinished() )
                break;
            if ( board[ i ].ident.cleanName == cleanName )
            {
                this.best_recordTime = board[ i ];
                break;
            }
        }
        this.updateScore();
        this.updatePos();
    }

    PositionStore@ positionStore()
    {
        if ( this.preRace() )
            return this.preRacePositionStore;
        else
            return this.practicePositionStore;
    }

    Position@ savedPosition()
    {
        return this.positionStore().positions[0];
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

    // "/position find <type> [info]": teleport to (and cycle through) notable map
    // entities indexed by the entity finder — start/finish lines, weapons, pushers,
    // doors, buttons, checkpoints, teleporter destinations, slick surfaces. "info"
    // dumps entity detail instead of teleporting. Ported from hettoo/wsw-race.
    bool findPosition( String entity, String parameter )
    {
        Entity@ ent = this.client.getEnt();

        if ( entity == "" )
        {
            this.showMapStats();
            G_PrintMsg( ent, "Usage: /position find <start|finish|rl|gl|pg|push|door|button|cp|tele|slick> [info]\n" );
            return false;
        }

        if ( parameter == "info" )
        {
            EntityList@ list = entityFinder.allEntities( entity );
            if ( list.isEmpty() )
            {
                G_PrintMsg( ent, "No matching entity found.\n" );
                return false;
            }
            uint len = list.length();
            bool small = len < BIG_LIST;
            bool single = len == 1;
            if ( !small )
                G_PrintMsg( ent, "Omitting target info as this is a big list\n" );
            while ( !list.isEmpty() )
            {
                Entity@ current = list.getEnt( 0 );
                if ( @current == null ) // e.g. slick surfaces have no backing entity
                {
                    G_PrintMsg( ent, "entity (surface) @ " + list.getPosition( 0 ).x + " " + list.getPosition( 0 ).y + " " + list.getPosition( 0 ).z + "\n" );
                    @list = list.drop( 1 );
                    continue;
                }
                G_PrintMsg( ent, "entity " + current.entNum + ": " + current.classname + " @ " + current.origin.x + " " + current.origin.y + " " + current.origin.z + "\n" );
                if ( small )
                {
                    if ( single )
                    {
                        Vec3 mins, maxs;
                        current.getSize( mins, maxs );
                        G_PrintMsg( ent, "    mins: " + mins.x + " " + mins.y + " " + mins.z + "\n" );
                        G_PrintMsg( ent, "    maxs: " + maxs.x + " " + maxs.y + " " + maxs.z + "\n" );
                        G_PrintMsg( ent, "    solid: " + current.solid + "  svflags: " + current.svflags + "  spawnFlags: " + current.spawnFlags + "\n" );
                        G_PrintMsg( ent, "    count: " + current.count + "  wait: " + current.wait + "\n" );
                    }
                    array<Entity@>@ targeting = current.findTargeting();
                    for ( uint i = 0; i < targeting.length; i++ )
                        G_PrintMsg( ent, "    targetted by " + targeting[i].entNum + ": " + targeting[i].classname + "\n" );
                    array<Entity@>@ targets = current.findTargets();
                    for ( uint i = 0; i < targets.length; i++ )
                        G_PrintMsg( ent, "    target " + targets[i].entNum + ": " + targets[i].classname + "\n" );
                }
                @list = list.drop( 1 );
            }
            return true;
        }

        if ( !this.practicing && this.client.team != TEAM_SPECTATOR )
        {
            G_PrintMsg( ent, "Position loading is not available during a race.\n" );
            return false;
        }

        EntityList@ list = entityFinder.allEntities( entity );
        if ( list.isEmpty() )
        {
            G_PrintMsg( ent, "No matching entity found.\n" );
            return false;
        }

        if ( entity == this.lastFind )
            this.findIndex++;
        else
            this.findIndex = 0;
        this.lastFind = entity;

        ent.origin = list.getPosition( this.findIndex );
        ent.teleported = true;

        return true;
    }

    // Resolve a name pattern to exactly one connected player, or null (printing
    // "no match" / "multiple matched"). Ported from hettoo/wsw-race.
    Player@ oneMatchingPlayer( String pattern )
    {
        Player@[] matches = RACE_MatchPlayers( pattern );
        Entity@ ent = this.client.getEnt();

        if ( matches.length() == 0 )
        {
            G_PrintMsg( ent, "No players matched.\n" );
            return null;
        }
        else if ( matches.length() > 1 )
        {
            G_PrintMsg( ent, "Multiple players matched:\n" );
            for ( uint i = 0; i < matches.length(); i++ )
                G_PrintMsg( ent, matches[i].client.name + S_COLOR_WHITE + "\n" );
            return null;
        }
        else
            return matches[0];
    }

    // "/position join <player>": teleport to a live player's current position
    // (practice/spectator only). Ported from hettoo/wsw-race.
    bool joinPosition( String pattern )
    {
        Entity@ ent = this.client.getEnt();

        if ( !this.practicing && this.client.team != TEAM_SPECTATOR )
        {
            G_PrintMsg( ent, "Position loading is not available during a race.\n" );
            return false;
        }

        Player@ match = this.oneMatchingPlayer( pattern );
        if ( @match == null )
            return false;

        this.applyPosition( match.currentPosition() );
        this.currentCheckpoint = 0; // observe-teleport must not inherit their CP index
        ent.set_velocity( Vec3() );

        return true;
    }

    // One-line summary of a map's notable entities (weapons, pushers, doors,
    // buttons, checkpoints, teleporters, slick, missing start/finish). Shown by
    // "/position find" with no type. Ported from hettoo/wsw-race.
    void showMapStats()
    {
        String msg = "";
        uint numRLs = entityFinder.rls.length();
        uint numGLs = entityFinder.gls.length();
        uint numPGs = entityFinder.pgs.length();
        if ( numRLs + numGLs + numPGs == 0 )
            msg = "strafe";
        else
        {
            if ( numRLs > 0 )
            {
                msg += "rl(" + numRLs + ")";
                if ( numGLs + numPGs > 0 )
                    msg += ", ";
            }
            if ( numGLs > 0 )
            {
                msg += "gl(" + numGLs + ")";
                if ( numPGs > 0 )
                    msg += ", ";
            }
            if ( numPGs > 0 )
                msg += "pg(" + numPGs + ")";
        }
        if ( entityFinder.slicks.length() > 0 )
            msg += ", slick";
        if ( numCheckpoints > 0 )
            msg += ", cps(" + numCheckpoints + ")";
        uint numPushes = entityFinder.pushes.length();
        uint numDoors = entityFinder.doors.length();
        uint numButtons = entityFinder.buttons.length();
        uint numTeles = entityFinder.teles.length();
        if ( numPushes > 0 )
            msg += ", push(" + numPushes + ")";
        if ( numDoors > 0 )
            msg += ", doors(" + numDoors + ")";
        if ( numButtons > 0 )
            msg += ", buttons(" + numButtons + ")";
        if ( numTeles > 0 )
            msg += ", teles(" + numTeles + ")";
        if ( entityFinder.starts.length() == 0 )
            msg += ", " + S_COLOR_RED + "no start" + S_COLOR_WHITE;
        if ( entityFinder.finishes.length() == 0 )
            msg += ", " + S_COLOR_RED + "no finish" + S_COLOR_WHITE;
        G_PrintMsg( this.client.getEnt(), S_COLOR_GREEN + "Map stats: " + S_COLOR_WHITE + msg + "\n" );
    }

    // Pick a random map matching a pattern (excluding the current map). With
    // pre=true, remembers the pick + pattern so "/prerandmap" can preview it.
    // Ported from hettoo/wsw-race.
    String randomMap( String pattern, bool pre )
    {
        pattern = pattern.removeColorTokens().tolower();
        if ( pattern == "*" )
            pattern = "";

        if ( !pre && this.randmap != "" && this.randmapPattern == pattern )
            return this.randmap;

        Cvar mapname( "mapname", "", 0 );
        String current = mapname.string;

        String[] maps = GetMapsByPattern( pattern, current );

        if ( maps.length() == 0 )
        {
            this.client.printMessage( "No matching maps\n" );
            return "";
        }

        uint matches = maps.length();
        String result = maps[ randrange( matches ) ];
        if ( pre )
        {
            this.randmap = result;
            this.randmapPattern = pattern;
        }
        else
        {
            this.randmap = "";
        }
        this.randmapMatches = matches;
        return result;
    }

    // "/mark [player]": drop a client-only dummy model at your position (or copy
    // another player's marker) as a visual route reference. Ported from
    // hettoo/wsw-race.
    bool setMarker( String copy )
    {
        Entity@ ent = this.client.getEnt();
        Entity@ ref = ent;

        if ( copy != "" )
        {
            Player@ match = this.oneMatchingPlayer( copy );
            if ( @match == null )
            {
                if ( @this.marker != null )
                {
                    this.marker.unlinkEntity();
                    this.marker.freeEntity();
                    @this.marker = null;
                }
                return false;
            }
            @ref = match.marker;
            if ( @ref == null )
            {
                this.client.printMessage( "Player does not have a marker set.\n" );
                return false;
            }
        }

        Entity@ dummy = G_SpawnEntity( "dummy" );
        dummy.modelindex = G_ModelIndex( "models/players/bigvic/tris.iqm" );
        dummy.svflags |= SVF_ONLYOWNER;
        dummy.svflags &= ~SVF_NOCLIENT;
        dummy.ownerNum = ent.entNum;
        dummy.origin = ref.origin;
        dummy.angles = Vec3( 0, ref.angles.y, 0 );

        if ( @this.marker != null )
        {
            this.marker.unlinkEntity();
            this.marker.freeEntity();
        }

        dummy.linkEntity();

        @this.marker = dummy;

        return true;
    }

    bool loadPosition( String name, Verbosity verbosity )
    {
        Entity@ ent = this.client.getEnt();
        if ( !this.practicing && this.client.team != TEAM_SPECTATOR && !this.preRace() )
        {
            if ( verbosity == Verbosity_Verbose )
                G_PrintMsg( ent, "Position loading is not available during a race.\n" );
            return false;
        }

        this.noclipBackup.saved = false;

        Position@ position = this.positionStore().get( name );

        if ( @position == null || !position.saved )
        {
            if ( verbosity == Verbosity_Verbose )
                G_PrintMsg( ent, "No position has been saved yet.\n" );
            return false;
        }

        this.applyPosition( position );

        // Loading a named slot also copies it into the main slot.
        if ( name != "" )
            this.positionStore().set( "", position );

        if ( this.preRace() )
        {
            ent.velocity = Vec3();
        }
        else if ( this.practicing && position.recalled )
        {
            this.cancelRace();
            this.recalled = true;
            this.startTime = this.timeStamp() - position.currentTime;
            this.nextRunPositionTime = this.timeStamp() + this.positionInterval;
            this.autoRecallStart = this.positionCycle; // auto-recall extends from here
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

    bool savePosition( String name )
    {
        Client@ ref = this.client;
        if ( this.client.team == TEAM_SPECTATOR && this.client.chaseActive && this.client.chaseTarget != 0 )
            @ref = G_GetEntity( this.client.chaseTarget ).client;
        Entity@ ent = ref.getEnt();

        if ( ent.health <= 0 )
        {
            G_PrintMsg( this.client.getEnt(), "You can only save your position while alive.\n" );
            return false;
        }

        if ( this.preRace() )
        {
            Vec3 mins, maxs;
            ent.getSize( mins, maxs );
            Vec3 down = ent.origin;
            down.z -= 1;
            Trace tr;
            if ( !tr.doTrace( ent.origin, mins, maxs, down, ent.entNum, MASK_DEADSOLID ) )
            {
                G_PrintMsg( this.client.getEnt(), "You can only save your prerace position on solid ground.\n" );
                return false;
            }

            // Refuse where a standing hitbox does not fit (replaces the old
            // crouch-height check) so a saved prerace spot is always stand-able.
            // MASK_DEADSOLID (world + playerclip, no bodies): another racer
            // overlapping you must not block the save.
            if ( tr.doTrace( ent.origin, playerMins, playerMaxs, ent.origin, ent.entNum, MASK_DEADSOLID ) )
            {
                G_PrintMsg( this.client.getEnt(), "You can't save your prerace position where you cannot stand up.\n" );
                return false;
            }
        }

        PositionStore@ store = this.positionStore();
        Position@ position = store.get( name );
        if ( @position == null )
            @position = Position();

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

        if ( !store.set( name, position ) )
        {
            G_PrintMsg( this.client.getEnt(), "No free position slot available.\n" );
            return false;
        }

        this.setQuickMenu();

        return true;
    }

    void listPositions()
    {
        Entity@ ent = this.client.getEnt();
        PositionStore@ store = this.positionStore();
        for ( uint i = 0; i < store.positions.length; i++ )
        {
            if ( store.positions[i].saved )
            {
                if ( store.names[i] == "" )
                    G_PrintMsg( ent, "Main position saved\n" );
                else
                    G_PrintMsg( ent, "Additional position: '" + store.names[i] + "'\n" );
            }
        }
    }

    bool clearPosition( String name )
    {
        if ( !this.practicing && this.client.team != TEAM_SPECTATOR && !this.preRace() )
        {
            G_PrintMsg( this.client.getEnt(), "Position clearing is not available during a race.\n" );
            return false;
        }

        this.positionStore().remove( name );
        this.setQuickMenu();

        return true;
    }

    uint timeStamp()
    {
        return this.client.uCmdTimeStamp;
    }

    bool startRace()
    {
        // Mirror bots (and any fake client) are puppets driven by the mesh
        // stream, not real input — they must never enter a race, so they can
        // never count an attempt or set a record on this server.
        if ( RACE_MirrorIsFakeClient( this.client ) )
            return false;

        // Auto-recall: starting a practice run from a recalled position starts
        // the timer (extending the recalled run) instead of a fresh race.
        if ( this.practicing && this.autoRecall && !this.recalled )
        {
            this.runPositionCount = 0;
            // Our split model keeps per-CP data on current_recordTime; hettoo's
            // run.clear() reset it too. Clear it (and currentCheckpoint, which we
            // use as a checkpoint_order[] index) so this extend-run's /cps starts
            // fresh and contiguous from index 0.
            this.current_recordTime.clearCheckpoints();
            this.currentCheckpoint = 0;
            this.startTime = this.timeStamp();
            this.recalled = true;
            this.positionCycle = 0;
            this.nextRunPositionTime = this.timeStamp() + this.positionInterval;
            this.autoRecallStart = -1;
            return true;
        }

        if ( !this.preRace() )
            return false;

        this.currentCheckpoint = 0;
        this.inRace = true;
        RACE_AttemptStarted( this ); // every genuine start counts (racelog.as)
        this.startTime = this.timeStamp();
        this.runPositionCount = 0;
        this.positionCycle = 0;
        this.nextRunPositionTime = this.timeStamp() + this.positionInterval;
        this.ghostCount = 0;
        this.ghostCpCount = 0;

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

        // The per-client demo now starts at SPAWN (GT_PlayerRespawn), not here,
        // so the saved run includes the run-up from the spawn point. This run
        // simply keeps recording into the already-open demo; completeRace() keeps
        // it on a personal best and the engine renames it with the finish time.

        this.client.newRaceRun( numCheckpoints );

        this.setQuickMenu();

        return true;
    }

    void saveRunPosition()
    {
        if ( this.runPositionCount == MAX_POSITIONS || this.timeStamp() < this.nextRunPositionTime )
            return;

        Entity@ ent = this.client.getEnt();

        // Sample during a race, or (with auto-recall on) while extending a
        // recalled practice run by moving forward on foot.
        if ( !this.inRace && ( this.client.team == TEAM_SPECTATOR || !this.practicing || !this.recalled || !this.autoRecall || ent.moveType != MOVETYPE_PLAYER ) )
            return;

        // Never snapshot a dead-still frame.
        if ( ent.velocity.length() == 0 )
            return;

        // Walljump/dash workaround: skip frames where the player is grounded
        // while winding up a jump/crouch/special with non-positive vertical
        // velocity, so replays don't capture a frame that breaks those timers.
        // (Slick surfaces are still allowed so slide starts sample.)
        uint keys = this.client.pressedKeys;
        if ( ent.velocity.z <= 0 && keys & ( Key_Jump | Key_Crouch | Key_Special ) != 0 )
        {
            Vec3 mins, maxs;
            ent.getSize( mins, maxs );
            Vec3 down = ent.origin;
            down.z -= POSITION_HEIGHT;
            Trace tr;
            if ( tr.doTrace( ent.origin, mins, maxs, down, ent.entNum, MASK_DEADSOLID ) && tr.surfFlags & SURF_SLICK == 0 )
                return;
        }

        // Auto-recall re-extend: truncate the buffer back to where the recall
        // started before appending fresh samples.
        if ( !this.inRace && this.autoRecall && this.autoRecallStart >= 0 )
        {
            if ( this.autoRecallStart < this.runPositionCount )
                this.runPositionCount = this.autoRecallStart + 1;
            this.autoRecallStart = -1;
        }

        this.runPositions[ this.runPositionCount++ ] = this.currentPosition();
        this.nextRunPositionTime = this.timeStamp() + this.positionInterval;
    }

    // Record one replay-ghost frame at a fixed ~25 Hz cadence in RACE time, so
    // frame i lands at ~i*GHOST_INTERVAL ms (the web/viewer treat timing as
    // implicit from the index). Unlike saveRunPosition this samples every
    // frame including airborne — that is exactly what a smooth strafe path
    // needs. Called from GT_ThinkRules for every racing client.
    void saveGhostFrame()
    {
        if ( !this.inRace || this.ghostCount >= MAX_GHOST_FRAMES )
            return;
        if ( this.raceTime() < uint( this.ghostCount ) * uint( GHOST_INTERVAL ) )
            return;
        Entity@ ent = this.client.getEnt();
        this.ghostOrigin[ this.ghostCount ] = ent.origin;
        this.ghostAngle[ this.ghostCount ] = ent.angles;
        this.ghostVel[ this.ghostCount ] = ent.get_velocity();
        this.ghostKeys[ this.ghostCount ] = int( this.client.pressedKeys );
        this.ghostCount++;
    }

    uint getSpeed()
    {
        return uint( HorizontalSpeed( this.client.getEnt().velocity ) );
    }

    void checkNoclipAction()
    {
        Entity@ ent = this.client.getEnt();

        if ( !this.practicing || this.client.team == TEAM_SPECTATOR || ( ent.moveType != MOVETYPE_NOCLIP && ent.moveType != MOVETYPE_NONE ) || ent.health <= 0 || this.release > 0 )
            return;

        uint keys = this.client.pressedKeys;

        // Point-pull: Attack+Special in noclip eases the player toward the
        // surface they are aiming at. Handled first and returns, so it never
        // collides with the Attack-alone position recall handled below.
        if ( keys & Key_Attack != 0 && keys & Key_Special != 0 && ent.moveType == MOVETYPE_NOCLIP )
        {
            Vec3 mins( 0 );
            Vec3 maxs( 0 );
            Vec3 origin = ent.origin;
            Vec3 a, b, c;
            ent.angles.angleVectors( a, b, c );
            a.normalize();
            Trace tr;
            float pull = POINT_PULL * float( frameTime );
            if ( pull > 1.0f )
                pull = 1.0f;
            if ( tr.doTrace( origin, mins, maxs, origin + a * POINT_DISTANCE, ent.entNum, MASK_PLAYERSOLID | MASK_WATER ) && tr.fraction * POINT_DISTANCE > PULL_MARGIN )
                ent.origin = origin * ( 1.0f - pull ) + tr.endPos * pull;
            return;
        }

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

        // The demo is NOT discarded here: it started at spawn (GT_PlayerRespawn)
        // and must survive a run-restart, which cancels the race but keeps the
        // same life. A respawn resets the demo in GT_PlayerRespawn; completeRace()
        // keeps it (personal best) or discards it at the run's end.

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
        // Belt-and-suspenders: a fake client should never be inRace (startRace
        // refuses them), but never log a finish, report to the API, or write a
        // top score for one even if some other path gets here.
        if ( RACE_MirrorIsFakeClient( this.client ) )
            return;

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

            bool newPersonalBest = !this.best_recordTime.isFinished() || finishTime < this.best_recordTime.getFinishTime();
            if ( newPersonalBest )
            {
                // this.client.addAward( S_COLOR_YELLOW + "Personal record!" );
                // copy all the sectors into the new personal record backup
                this.setBestTime( finishTime, this.maxSpeed );

                this.bestRunPositionCount = this.runPositionCount;
                for ( int i = 0; i < this.runPositionCount; i++ )
                    this.bestRunPositions[ i ] = this.runPositions[ i ];

                // Snapshot the 25 Hz ghost of this personal-best run too.
                this.bestGhostCount = this.ghostCount;
                for ( int i = 0; i < this.ghostCount; i++ )
                {
                    this.bestGhostOrigin[ i ] = this.ghostOrigin[ i ];
                    this.bestGhostAngle[ i ] = this.ghostAngle[ i ];
                    this.bestGhostVel[ i ] = this.ghostVel[ i ];
                    this.bestGhostKeys[ i ] = this.ghostKeys[ i ];
                }
                this.bestGhostCpCount = this.ghostCpCount;
                for ( int i = 0; i < this.ghostCpCount; i++ )
                    this.bestGhostCp[ i ] = this.ghostCp[ i ];

                this.best_recordTime = this.current_recordTime;
            }

            uint pos = RACE_AddTopScore( this.best_recordTime, this.reversed );

            // Close this run's per-client demo. Keep only PERSONAL-BEST demos
            // (one per player per map, the download the site links) and cancel
            // the rest, so the game host isn't buried in every-attempt
            // recordings. demoStop renames the kept file with the finish time.
            // NOTE: the engine still caps how many demos it retains per map, so a
            // downloadable demo for EVERY rank (not just the fastest few) needs
            // the per-player retention work in docs/per-player-replays-design.md;
            // browser-replay ghosts are unaffected (they live on the web).
            if ( rsRecordDemos.boolean )
            {
                if ( newPersonalBest )
                    this.client.demoStop( RACE_DemoName( this.client ), finishTime );
                else
                    this.client.demoCancel();
            }

            // Announce actual WORLD RECORDS only. #1 in the LOCAL top scores can
            // be stale (or empty at map start), so a mere personal best would
            // false-announce — apitop.as verifies against a fresh API pull first.
            if ( pos == 0 )
                RACE_QueueRecordAnnounce( this.client.name, finishTime, this.reversed );

            // Upload the demo pointer + ghost trajectory for every PERSONAL BEST
            // (one per player per map). The web keeps a per-(player, map) row
            // with a faster-only guard, so a stale/duplicate report is harmless.
            // (Runs on the local PB check, not the announce's WR check, so every
            // player's best gets a replay — not just the map record.)
            if ( newPersonalBest )
            {
                if ( rsRecordDemos.boolean )
                    RACE_ReportWrDemo( this, finishTime );
                RACE_UploadWrGhost( this, finishTime );
            }


            RACE_WriteTopScores( this.reversed );
            // HUD record lines are a shared singleton -> standard board only.
            if ( !this.reversed )
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

        if ( this.client.getEnt().moveType == MOVETYPE_NONE ) // frozen: don't bank a CP
            return false;

        this.updateMaxSpeed();

        uint time = this.raceTime();
        this.current_recordTime.checkpoints[ id ] = Checkpoint( time, this.getSpeed(), this.maxSpeed, CheckpointType_Normal );
        // currentCheckpoint indexes checkpoint_order[]; a recalled/loaded Position
        // can seed it, so bound it (belt-and-suspenders — deduceCheckpointOrder()
        // before report() is the real order-correctness fix).
        if ( this.currentCheckpoint < this.current_recordTime.checkpoint_order.length() )
            this.current_recordTime.checkpoint_order[ this.currentCheckpoint++ ] = id;

        // mark which ghost frame this checkpoint fell on (viewer cp markers)
        if ( this.inRace && this.ghostCpCount < int( numCheckpoints ) )
            this.ghostCp[ this.ghostCpCount++ ] = this.ghostCount;

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
        this.release = 0; // never leave practice with a frozen recall-hold
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
        if ( this.reversed )
            this.client.printMessage("Leave reverse mode first (/reverse).\n");
        else if ( pending_endmatch )
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

    // "/position recall current <player>": copy another player's IN-PROGRESS recall
    // run and enter recall on it (complements recallBest, which copies their best
    // run). Ported from hettoo/wsw-race.
    bool recallCurrent( String pattern )
    {
        if ( this.inRace )
        {
            G_PrintMsg( this.client.getEnt(), "Not possible during a race.\n" );
            return false;
        }

        Player@ match = this.oneMatchingPlayer( pattern );
        if ( @match == null )
            return false;

        if ( match.runPositionCount == 0 )
        {
            G_PrintMsg( this.client.getEnt(), "No run recorded.\n" );
            return false;
        }

        this.runPositionCount = match.runPositionCount;
        for ( int i = 0; i < this.runPositionCount; i++ )
            this.runPositions[i] = match.runPositions[i];
        this.positionCycle = 0;

        if ( this.practicing && this.client.team != TEAM_SPECTATOR )
            return this.recallPosition( 0 );
        else
            return true;
    }

    // "/position recall fake [time]": mark the saved main position as a recalled-run
    // start with the given ms timestamp, so starting from a hand-saved spot starts
    // the timer. Practicemode only. Ported from hettoo/wsw-race.
    bool recallFake( uint time )
    {
        if ( !this.practicing )
        {
            G_PrintMsg( this.client.getEnt(), "Only available in practicemode.\n" );
            return false;
        }

        Position@ position = this.savedPosition();

        if ( !position.saved )
        {
            G_PrintMsg( this.client.getEnt(), "No position saved.\n" );
            return false;
        }
        position.recalled = true;
        position.currentTime = time;

        return true;
    }

    // "/position recall interval [n|auto]": ms between recall-buffer samples.
    // "auto" fits a full best run into the 400-slot buffer. Ported from hettoo.
    bool recallInterval( String value )
    {
        Entity@ ent = this.client.getEnt();
        if ( value == "auto" )
        {
            if ( !this.best_recordTime.isFinished() )
            {
                G_PrintMsg( ent, "You haven't finished yet.\n" );
                return false;
            }
            this.positionInterval = this.best_recordTime.getFinishTime() / MAX_POSITIONS;
            G_PrintMsg( ent, "Setting the interval to " + this.positionInterval + "\n" );
        }
        else
        {
            int number = -1;
            if ( value != "" )
                number = value.toInt();
            if ( number < 0 )
                G_PrintMsg( ent, this.positionInterval + "\n" );
            else
                this.positionInterval = number;
        }
        return true;
    }

    // "/position recall delay [n]": frames frozen after respawning into a
    // recalled position (min 2). Ported from hettoo.
    bool recallDelay( String value )
    {
        Entity@ ent = this.client.getEnt();
        int number = -1;
        if ( value != "" )
            number = value.toInt();
        if ( number < 0 )
            G_PrintMsg( ent, this.recallHold + "\n" );
        else
        {
            if ( number < 2 )
                number = 2;
            this.recallHold = number;
        }
        return true;
    }

    // "/position recall extend [on|off]": toggle auto-recall. Ported from hettoo.
    bool recallExtend( String option )
    {
        if ( option == "on" )
            this.autoRecall = true;
        else if ( option == "off" )
            this.autoRecall = false;
        else
            this.autoRecall = !this.autoRecall;
        Entity@ ent = this.client.getEnt();
        if ( this.autoRecall )
            G_PrintMsg( ent, "Auto recall extend ON.\n" );
        else
            G_PrintMsg( ent, "Auto recall extend OFF.\n" );
        return true;
    }

    // Per-frame: count down the post-recall freeze, then unfreeze + reload the
    // recalled position so the run resumes. Called from GT_ThinkRules.
    void checkRelease()
    {
        // Never act on a spectator (or non-racer): a stale freeze counting down
        // would otherwise force-move the free-fly/chase camera to a saved race
        // position. Just drop the freeze.
        if ( this.client.team == TEAM_SPECTATOR )
        {
            this.release = 0;
            return;
        }
        if ( this.release > 1 )
            this.release -= 1;
        else if ( this.release == 1 )
        {
            this.client.getEnt().moveType = MOVETYPE_PLAYER;
            this.loadPosition( "", Verbosity_Silent );
            this.release = 0;
        }
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

    bool positionSpeed( String speedStr, String name )
    {
        // Always targets the PRACTICE store (prerace spawn speed is unaffected).
        Position@ position = this.practicePositionStore.get( name );
        if ( @position == null )
        {
            G_PrintMsg( this.client.getEnt(), "No such position set.\n" );
            return false;
        }
        if ( !position.saved )
        {
            position.copy( this.currentPosition() );
            position.saved = true;
        }
        float speed = 0;
        bool doAdd = speedStr.locate( "+", 0 ) == 0;
        bool doSubtract = speedStr.locate( "-", 0 ) == 0;
        if ( doAdd || doSubtract )
        {
            speed = HorizontalSpeed( position.velocity );
            float diff = speedStr.substr( 1 ).toFloat();
            if ( doAdd )
                speed += diff;
            else
                speed -= diff;
        }
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
