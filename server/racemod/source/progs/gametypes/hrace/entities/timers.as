void target_checkpoint_use( Entity@ self, Entity@ other, Entity@ activator )
{
    if ( @activator.client == null )
        return;

    Player@ player = RACE_GetPlayer( activator.client );

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

// doesn't need to do anything at all, just sit there, waiting
void target_starttimer( Entity@ ent )
{
    @ent.use = target_starttimer_use;
    ent.wait = 0;
}

void target_startTimer( Entity@ ent )
{
    target_starttimer( ent );
}
