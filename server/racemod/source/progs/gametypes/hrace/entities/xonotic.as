/*
 * Xonotic-style race checkpoint entity.
 *
 * Ported from hettoo/wsw-race@racemod (entities/xonotic.as) so that race maps
 * converted from Xonotic work out of the box. Those maps drive timing with a
 * single trigger_race_checkpoint brush entity instead of the Warsow
 * trigger_multiple -> target_starttimer / target_checkpoint / target_stoptimer
 * chain.
 *
 * The "cnt" spawn key carries the checkpoint order; cnt == 0 is the start line.
 * The FINISH spawnflag marks the stop-timer (finish) trigger. As with the
 * native target_checkpoint, the sector index stored on the entity is the spawn
 * order (numCheckpoints), and it is counted here during map entity spawning so
 * GT_SpawnGametype sizes the per-player arrays to numCheckpoints + 1 correctly.
 *
 */

const int NOTOUCH       = 1;
const int STRICTTRIGGER = 2;
const int CRUSH         = 4;
const int FINISH        = 8;

void trigger_race_checkpoint( Entity@ self )
{
    int cnt = int( G_SpawnTempValue( "cnt" ) );

    self.count = numCheckpoints;
    self.solid = SOLID_TRIGGER;
    self.moveType = MOVETYPE_NONE;
    self.setupModel( self.model );
    self.svflags &= ~SVF_NOCLIENT;
    self.wait = 0;
    self.linkEntity();

    @self.touch = trigger_race_checkpoint_touch;

    if ( ( self.spawnFlags & FINISH ) != 0 )
    {
        @self.use = target_stoptimer_use;
        return;
    }
    if ( cnt == 0 )
    {
        @self.use = target_starttimer_use;
        return;
    }

    @self.use = target_checkpoint_use;
    numCheckpoints++;
    entityFinder.add( "cp", self, self.origin );
}

void trigger_race_checkpoint_touch( Entity@ ent, Entity@ other, const Vec3 planeNormal, int surfFlags )
{
    ent.use( ent, other, other );
}
