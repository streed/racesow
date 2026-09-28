#!/usr/bin/env python3
"""
Warfork port: in race, a trigger_once / trigger_multiple with wait <= 0 must
NOT delete itself after its first touch, and a target_speaker must pass the
activation on to its own targets.

THE BUG THIS FIXES. Upstream warfork-qfusion's multi_trigger (g_trigger.cpp)
has stock Quake semantics for a non-repeating trigger:

    G_UseTargets( ent, ent->activator );

    if( ent->wait <= 0 )
    {
        ent->touch = NULL;
        ent->nextThink = level.time + 1;
        ent->think = G_FreeEdict;
    }

SP_trigger_once sets wait = -1 and a mapper can set wait -1 on a
trigger_multiple, and that is exactly how most defrag/race maps build their
checkpoint and finish volumes. So on Warfork the FIRST player to touch one
fires it once and the edict is freed for everyone -- that player's next run
included -- until the next map load. (Mesh mirror bots and the WR ghost are
PM_FREEZE fake clients that never run pmove, so they do not touch triggers.)

  * checkpoints: every CP was consumed by the first run through it after the
    map loaded, so nobody's CP registered after that;
  * finish: once the first run crossed it, the line was gone -- in race AND
    practice, since both go through target_stoptimer. "Sometimes" because it
    depends on whether that map's finish is a trigger_once and whether anyone
    has crossed it since the map loaded.

Race does not need the single-use semantics at all: G_TriggerWait already has a
GS_RaceGametype() branch that debounces PER CLIENT (other->trigger_timeout), and
the gametype scripts guard their own repeats (touchCheckPoint ignores a CP
already passed; completeRace needs inRace/practicing).

Warsow does not have this bug because DenMSC/racemod_2.1 (the Warsow game
module source) carries this exact fix:

    if( ent->wait <= 0 && !GS_RaceGametype() ) // racesow

That is change (1) below, verbatim.

Change (2) is the same tree's target_speaker fix. Some race maps chain
trigger -> target_speaker -> target_checkpoint/target_stoptimer (the speaker
plays the CP "bip" and relays on). Stock Use_Target_Speaker plays the sound and
stops, so the chain never reaches the checkpoint. racemod_2.1 records the
activator and calls G_UseTargets at the end; we do the same. A speaker with no
"target" is unaffected (G_UseTargets has nothing to fire).

Reproduced on a local build (coldrun, a fake client driven through start ->
CPs -> finish twice with every race trigger forced to wait -1): stock code
frees all four triggers on the first run and the second run cannot start,
bank a CP or finish; with this patch both runs complete.

Run from source/ (cwd = warfork-qfusion/source). Fails loudly if any anchor is
not found exactly once.
"""
import sys

TRIGGER = "game/g_trigger.cpp"
TARGET = "game/g_target.cpp"

EDITS = [
	(
		TRIGGER,
		"trigger wait<=0 no longer self-deletes in race",
		"\tG_UseTargets( ent, ent->activator );\n"
		"\n"
		"\tif( ent->wait <= 0 )\n"
		"\t{\n",
		"\tG_UseTargets( ent, ent->activator );\n"
		"\n"
		"\t// racesow: a trigger_once / wait -1 trigger must stay alive in race. It\n"
		"\t// is how maps build CP and finish volumes, and freeing it here let the\n"
		"\t// first player through consume it for everyone until the next map.\n"
		"\t// G_TriggerWait already debounces per client in race. Same as racemod_2.1.\n"
		"\tif( ent->wait <= 0 && !GS_RaceGametype() )\n"
		"\t{\n",
	),
	(
		TARGET,
		"target_speaker records its activator",
		"static void Use_Target_Speaker( edict_t *ent, edict_t *other, edict_t *activator )\n"
		"{\n"
		"\tif( ent->spawnflags & 3 )\n",
		"static void Use_Target_Speaker( edict_t *ent, edict_t *other, edict_t *activator )\n"
		"{\n"
		"\tent->activator = activator; // racesow\n"
		"\n"
		"\tif( ent->spawnflags & 3 )\n",
	),
	(
		TARGET,
		"target_speaker relays to its targets",
		"\t\telse\n"
		"\t\t\tG_PositionedSound( ent->s.origin, CHAN_VOICE, ent->noise_index, ent->attenuation );\n"
		"\t}\n"
		"}\n",
		"\t\telse\n"
		"\t\t\tG_PositionedSound( ent->s.origin, CHAN_VOICE, ent->noise_index, ent->attenuation );\n"
		"\t}\n"
		"\t// racesow: relay on, so trigger -> speaker -> checkpoint/stoptimer chains\n"
		"\t// reach the checkpoint. Same as racemod_2.1.\n"
		"\tG_UseTargets( ent, ent->activator );\n"
		"}\n",
	),
]


def main():
	files = {}
	for path, what, old, new in EDITS:
		if path not in files:
			with open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
				files[path] = f.read()
		n = files[path].count(old)
		if n != 1:
			sys.exit("FATAL: %s anchor found %d times (expected 1) in %s" % (what, n, path))
		files[path] = files[path].replace(old, new)
		print("patched %s: %s" % (path, what))
	for path, src in files.items():
		with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
			f.write(src)


if __name__ == "__main__":
	main()
