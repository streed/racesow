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

The generator only promises what a player can do WITHOUT strafe-jumping:
every gap is clearable from a standing 320 ups run-up. Strafing makes a map
faster, never possible — that is what keeps a generated map raceable by
everyone, and it means this module does not have to model air acceleration.
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
