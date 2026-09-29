"""Movement limits a generated course is designed against.

Every number here is copied from the engine the servers actually run
(DenMSC/racemod_2.1, branch race-demos — the tree server/Dockerfile builds),
not from memory of how Quake feels:

  GRAVITY            gameshared/gs_public.h:65   #define GRAVITY 850
  JUMP_SPEED         gameshared/gs_public.h:73   #define DEFAULT_JUMPSPEED 280.0f
  RUN_SPEED          gameshared/gs_public.h:72   #define DEFAULT_PLAYERSPEED_RACE 320.0f
  STEP_SIZE          gameshared/gs_public.h:272  #define STEPSIZE 18
  PLAYER_MINS/MAXS   gameshared/gs_pmove.c:31-32 playerbox_stand_{mins,maxs}
  MIN_WALK_NORMAL    gameshared/gs_public.h:223  ISWALKABLEPLANE: normal[2] >= 0.7
  DASH_SPEED         gameshared/gs_public.h:74   #define DEFAULT_DASHSPEED 451.0f
  DASH_UP            gameshared/gs_pmove.c:110   pm_dashupspeed = 174 * GRAVITY_COMPENSATE
  WJ_UP              gameshared/gs_pmove.c:117   pm_wjupspeed = 330 * GRAVITY_COMPENSATE
  WJ_BOUNCE          gameshared/gs_pmove.c:119   pm_wjbouncefactor 0.3
  GRAVITY_COMPENSATE gameshared/gs_public.h:64-66 GRAVITY / BASEGRAVITY = 850 / 800

The generator only promises what a player can do WITHOUT strafe-jumping:
every gap is clearable from a standing 320 ups run-up. Strafing makes a map
faster, never possible — that is what keeps a generated map raceable by
everyone, and it means this module does not have to model air acceleration.
The two special moves are the exception, and only as far as they are
modelled below (wall_jump_*, dash_*). Wall climbs and wall-kick gaps end on a
ledge higher than any jump reaches: strafing adds speed, never height, so
they need the wall jump from everyone. A dash drop is longer than a perfect
run-speed jump: it needs the dash at run speed, but strafe speed can jump it.

The day we want gaps that need strafe speed, this is the wrong tool and the
headless pmove validator (docs/map-generation-design.md, phase 2) is the
right one.
"""

import math

GRAVITY = 850.0
JUMP_SPEED = 280.0
RUN_SPEED = 320.0
STEP_SIZE = 18.0
PLAYER_MINS = (-16.0, -16.0, -24.0)
PLAYER_MAXS = (16.0, 16.0, 40.0)
PLAYER_HEIGHT = PLAYER_MAXS[2] - PLAYER_MINS[2]  # 64
MIN_WALK_NORMAL = 0.7

# Safety factor on every jump distance. A player's takeoff is rarely at the
# exact lip, and 320 ups is only the *ceiling* of plain running.
JUMP_MARGIN = 0.8

# Distance a player needs on the floor before a gap to be at full run speed.
# Ground acceleration reaches 320 ups in well under a quarter second; 192
# units is ~0.6 s of running, comfortably more.
MIN_RUNUP = 192.0


def jump_apex():
    """Height gained by a standing jump: v^2 / 2g (~46 units)."""
    return JUMP_SPEED * JUMP_SPEED / (2.0 * GRAVITY)


def air_time(drop):
    """Seconds from takeoff until the feet are `drop` units below takeoff.

    Solves drop = -(v t - g t^2 / 2) for the positive root. drop < 0 means
    landing HIGHER than takeoff, only possible up to the apex.
    """
    disc = JUMP_SPEED * JUMP_SPEED + 2.0 * GRAVITY * drop
    if disc < 0:
        return None
    return (JUMP_SPEED + math.sqrt(disc)) / GRAVITY


def max_gap(drop, speed=RUN_SPEED):
    """Longest gap (lip to lip) a run-up jump reliably clears, with margin."""
    t = air_time(drop)
    if t is None:
        return 0.0
    return JUMP_MARGIN * speed * t


def max_rise():
    """Tallest ledge a standing jump reliably gets the feet onto."""
    return JUMP_MARGIN * jump_apex()


def max_ramp_slope():
    """Steepest walkable ramp as rise/run. MIN_WALK_NORMAL 0.7 is ~45.6 deg;
    we stay at 30 deg so a ramp never feels like a wall."""
    return math.tan(math.radians(30.0))


# -- special moves (the "special" key: dash on the ground, wall jump in the air)
#
# Dash (PM_CheckDash, gs_pmove.c:1100): only on the ground, at most once per
# PM_DASHJUMP_TIMEDELAY (1000 ms). Horizontal speed becomes max(current,
# 451) in the direction pressed; vertical becomes 174 * 850/800 = 184.9 (an
# apex of 20 units, well under a jump's 46).
#
# Wall jump (PM_CheckWallJump, gs_pmove.c:1191): only in the air, once until
# the player lands or PM_WALLJUMP_TIMEDELAY (1300 ms) passes, and only with a
# wall within reach: PlayerTouchWall traces from the player's centre out to
# its box edge (16) plus velocity * 0.015, so the player must be hugging it.
# Vertical speed becomes 330 * 850/800 = 350.6 (72 more units of height from
# wherever it happens). Horizontally the velocity is clipped against the wall,
# pushed 0.3 away from it, renormalised and scaled back to the old speed, so a
# player running along a wall keeps going along it at 320 / sqrt(1 + 0.3^2).
#
# Crouching (PM_AdjustBBox, gs_pmove.c:1481) is allowed in the air and lowers
# the head 24 units, but not in the first 400 ms of a dash
# (PM_SPECIAL_CROUCH_INHIBIT). That is why there is no "dash under a low
# ceiling" piece: a crouch-jump fits under any ceiling a dash does.

GRAVITY_COMPENSATE = GRAVITY / 800.0
DASH_SPEED = 451.0
DASH_UP = 174.0 * GRAVITY_COMPENSATE
WJ_UP = 330.0 * GRAVITY_COMPENSATE
WJ_BOUNCE = 0.3

# A dash sets the speed exactly, whatever the run-up, so the only slack it
# needs is the take-off point: a smaller margin than a jump's.
DASH_MARGIN = 0.9


def _flight(vz, drop):
    """Seconds in the air from an upward speed vz until `drop` below the
    start (drop < 0: above it, on the way down). None if never that high."""
    disc = vz * vz + 2.0 * GRAVITY * drop
    if disc < 0:
        return None
    return (vz + math.sqrt(disc)) / GRAVITY


def jump_reach(drop, speed=RUN_SPEED):
    """Lip-to-lip distance of a perfect jump at `speed`: NO margin. A special
    move's piece must be longer than this, so no plain jump makes it."""
    t = _flight(JUMP_SPEED, drop)
    return 0.0 if t is None else speed * t


def dash_reach(drop):
    """Lip-to-lip distance of a dash from the lip, with DASH_MARGIN."""
    t = _flight(DASH_UP, drop)
    return 0.0 if t is None else DASH_MARGIN * DASH_SPEED * t


def wall_jump_speed(speed=RUN_SPEED):
    """Speed along the wall after kicking off it while running along it."""
    return speed / math.sqrt(1.0 + WJ_BOUNCE * WJ_BOUNCE)


def wall_jump_reach(drop, speed=RUN_SPEED):
    """Lip-to-lip distance of a run-speed jump plus one wall jump off a wall
    along the gap, kicked at the best moment, with JUMP_MARGIN."""
    best = 0.0
    apex_t = JUMP_SPEED / GRAVITY
    after = wall_jump_speed(speed)
    for i in range(1, 201):
        t1 = 2.0 * apex_t * i / 200            # kick anywhere in the jump's arc
        z = JUMP_SPEED * t1 - 0.5 * GRAVITY * t1 * t1
        t2 = _flight(WJ_UP, drop + z)
        if t2 is not None:
            best = max(best, speed * t1 + after * t2)
    return JUMP_MARGIN * best


def plain_climb():
    """Highest ledge a jump gets the feet onto: the apex plus a step, since
    the step-up also works in the air. No margin: a wall climb must be
    taller than this."""
    return jump_apex() + STEP_SIZE


def wall_climb():
    """Tallest ledge a jump plus a wall jump at its apex reliably gets the
    feet onto, with JUMP_MARGIN."""
    return JUMP_MARGIN * (jump_apex() + WJ_UP * WJ_UP / (2.0 * GRAVITY))
