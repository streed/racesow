void target_checkpoint_use( Entity@ self, Entity@ other, Entity@ activator )
{
    if ( @activator.client == null )
        return;

    Player@ player = RACE_GetPlayer( activator.client );

    G_Print( "RSDBG checkpoint-touch: cp=" + self.count + " inRace=" + ( player.inRace ? "1" : "0" )
            + " numCheckpoints=" + numCheckpoints + "\n" );

    if ( player.touchCheckPoint( self.count ) )
        self.useTargets( activator );
}

void target_checkpoint( Entity@ self )
{
    self.count = numCheckpoints;
    @self.use = target_checkpoint_use;
    numCheckpoints++;
    entityFinder.add( "cp", self, self.origin );
}

void target_stoptimer_use( Entity@ self, Entity@ other, Entity@ activator )
{
    if ( @activator.client == null )
        return;

    Player@ player = RACE_GetPlayer( activator.client );

    G_Print( "RSDBG finish-touch: inRace=" + ( player.inRace ? "1" : "0" ) + " practicing=" + ( player.practicing ? "1" : "0" )
            + " reversed=" + ( player.reversed ? "1" : "0" ) + " postRace=" + ( player.postRace ? "1" : "0" )
            + " team=" + activator.client.team + " match=" + match.getState() + "\n" );

    // Reverse mode: the map's FINISH line is the reverse START. Begin the timed
    // run here (same path — and prejump gate — as a normal start).
    if ( player.reversed )
    {
        if ( player.reverseSetup || player.inRace )
            return;

        // Armed while standing INSIDE this finish volume: don't start on the
        // touch firing here — the timer starts when the player LEAVES the volume
        // (Player::checkReverseStart, per frame). Only a genuine cross from
        // OUTSIDE starts on touch.
        if ( player.reverseAwaitFinishExit )
            return;

        if ( player.startRace() )
        {
            self.useTargets( activator );

            int speed = int( HorizontalSpeed( activator.velocity ) );
            activator.client.setHUDStat( STAT_PROGRESS_OTHER, speed );
            activator.client.printMessage( S_COLOR_ORANGE + "Starting speed: " + S_COLOR_WHITE + speed + "\n" );
        }
        return;
    }

    if ( !player.inRace && !player.practicing )
        return;

    player.completeRace();

    self.useTargets( activator );
}

// This sucks: some defrag maps have the entity classname with pseudo camel notation
// and classname->function is case sensitive

void target_stoptimer( Entity@ self )
{
    @self.use = target_stoptimer_use;
}

void target_stopTimer( Entity@ self )
{
    target_stoptimer( self );
}

void target_starttimer_use( Entity@ self, Entity@ other, Entity@ activator )
{
    if ( @activator.client == null )
        return;

    Player@ player = RACE_GetPlayer( activator.client );

    G_Print( "RSDBG start-touch: inRace=" + ( player.inRace ? "1" : "0" ) + " practicing=" + ( player.practicing ? "1" : "0" )
            + " reversed=" + ( player.reversed ? "1" : "0" ) + " postRace=" + ( player.postRace ? "1" : "0" )
            + " team=" + activator.client.team + " match=" + match.getState() + "\n" );

    // Reverse mode: the map's START line is the reverse FINISH. Stop the timer
    // and bank the reversed run here (same path as a normal finish).
    if ( player.reversed )
    {
        if ( player.reverseSetup )
            return;
        if ( !player.inRace && !player.practicing )
            return;

        player.completeRace();
        self.useTargets( activator );
        return;
    }

    if ( player.inRace )
        return;

    if ( player.startRace() )
    {
        self.useTargets( activator );

        if ( @activator.client == null )
          return;

        int speed = int( HorizontalSpeed( activator.velocity ) );
        activator.client.setHUDStat( STAT_PROGRESS_OTHER, speed );
        activator.client.printMessage( S_COLOR_ORANGE + "Starting speed: " + S_COLOR_WHITE + speed + "\n" );
    }
}

// doesn't need to do anything at all, just sit there, waiting.
// NOTE: do NOT set ent.wait here. On the START, `ent` is the trigger_multiple,
// whose wait defaults to 0.2 (SP_trigger_multiple). Warfork's multi_trigger frees
// any trigger with wait <= 0 after its FIRST fire (G_FreeEdict), so `ent.wait = 0`
// deleted the start trigger for the rest of the map — the race could be started
// once and then never again (finish/death/restart could not re-arm it). Warsow's
// engine tolerated wait=0; Warfork does not. Stock race.as never sets it either.
void target_starttimer( Entity@ ent )
{
    @ent.use = target_starttimer_use;
}

void target_startTimer( Entity@ ent )
{
    target_starttimer( ent );
}
