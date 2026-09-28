#!/usr/bin/env python3
"""
Warfork port: the rest of racemod_2.1's map-entity and item fixes.

Warsow's game module is built from DenMSC/racemod_2.1, whose history starts at
an untouched warsow_21_sdk commit (83319ef) and then layers racesow's fixes on
top. Warfork's module is stock warfork-qfusion, so it has none of them. The
trigger_once / target_speaker ones live in patch-race-triggers.py and the
weapon physics in patch-race-weapons.py; this script ports everything else that
changes how a race MAP behaves. Each hunk is racemod_2.1's code, lifted as-is
unless a note says otherwise, and keeps its "racesow" marker comment.

Doors and buttons (g_func.cpp)
  * door_killed: in race a shootable door (defrag "doorbutton") fires its
    targets and stays shut, instead of opening; and deadflag is reset so the
    door can be shot again.
  * button_wait: a button with wait -1 resets immediately (defrag semantics)
    instead of staying pressed for the rest of the map.
  * SP_func_button: a button without health is touchable even when something
    targets it. Stock only armed the touch when it had no targetname, so a lot
    of defrag buttons could never be pressed.

Items (g_items.cpp, g_awards.cpp)
  * items get a `use` function, so a trigger can hand an item to its activator
    (Use_Item). Racemod dereferences the activator unchecked; we skip a NULL
    one instead of crashing.
  * an item fires its targets on EVERY pickup, not just the first -- defrag
    maps chain item -> target_* per player.
  * a targeted item floats (gravity 0) like a spawnflags-1 item, so it stays
    where the mapper put it.
  * health and weapons never respawn-hide in race; a powerup's pickup timeout
    uses the entity's own count in race.
  * the >197 health guard against trigger spam on some maps.
  * negative / zero item counts are clamped to 1 (defrag "infinite ammo").
  * no item timers, powerup-respawn global sounds or pickup awards in race.
    (Racemod comments the global sound out outright; we gate it on race, which
    is the same thing on a race server.)

Entities (g_trigger.cpp, g_spawn.cpp, g_local.h)
  * target_push: stock maps it to info_notnull (does nothing). Racemod
    implements it: using it sets the activator's velocity toward `angle` or a
    target apex (reusing trigger_push_setup). Jump maps use it.
  * G_CallSpawn: a gametype SCRIPT spawn function wins over a C one of the same
    classname. Today that only changes target_delay, which then runs our
    script version like Warsow does.
  * ISBRUSHMODEL: cap at MAX_MODELS - 50 so maps with very many inline models
    still leave room for non-inline ones.

Spawnpoints and misc (g_utils.cpp, p_client.cpp)
  * G_DropSpawnpointToFloor retries with a 0.01u-tighter hull before declaring
    a spawnpoint "inside solid", and leaves Q3 (IBSP) spawnpoints floating
    where the mapper put them instead of dropping them to the floor.
  * G_SolidMaskForEnt: clients use MASK_PLAYERSOLID.
  * an inactive player moved to spectator is also taken out of the spawn
    queue (free view instead of stuck in the challengers queue).

Already fixed upstream in Warfork, so not repeated here: target_relay random
mode picking from `target` instead of `targetname`.

Run from source/ (cwd = warfork-qfusion/source). Fails loudly if any anchor is
not found exactly once.
"""
import sys

EDITS = []


def edit(path, what, old, new):
	EDITS.append((path, what, old, new))


# --- g_func.cpp: doors ---------------------------------------------------------
edit("game/g_func.cpp", "door_killed: race doorbuttons fire targets",
	"static void door_killed( edict_t *self, edict_t *inflictor, edict_t *attacker, int damage, const vec3_t point )\n"
	"{\n"
	"\tedict_t\t*ent;\n"
	"\n"
	"\tfor( ent = self->teammaster; ent; ent = ent->teamchain )\n"
	"\t{\n"
	"\t\tent->health = ent->max_health;\n",
	"static void door_killed( edict_t *self, edict_t *inflictor, edict_t *attacker, int damage, const vec3_t point )\n"
	"{\n"
	"\tedict_t\t*ent;\n"
	"\n"
	"\t// racesow - defrag support: do not trigger if the door was killed\n"
	"\tif( GS_RaceGametype() )\n"
	"\t{\n"
	"\t\tself->deadflag = DEAD_NO;\n"
	"\t\tG_UseTargets( self, inflictor ); // fix for \"doorbuttons\" trigger targets without opening\n"
	"\t\treturn;\n"
	"\t}\n"
	"\t// !racesow\n"
	"\n"
	"\tfor( ent = self->teammaster; ent; ent = ent->teamchain )\n"
	"\t{\n"
	"\t\tent->health = ent->max_health;\n"
	"\t\tself->deadflag = DEAD_NO; // racesow\n")

# --- g_func.cpp: buttons -------------------------------------------------------
edit("game/g_func.cpp", "button_wait: wait -1 resets immediately",
	"\tG_UseTargets( self, self->activator );\n"
	"\tself->s.frame = 1;\n"
	"\tif( self->moveinfo.wait >= 0 )\n",
	"\tG_UseTargets( self, self->activator );\n"
	"\tself->s.frame = 1;\n"
	"\t// racesow - use -1 to reset immediately\n"
	"\tif( self->moveinfo.wait == -1 )\n"
	"\t{\n"
	"\t\tself->nextThink = level.time + 1;\n"
	"\t\tself->think = button_return;\n"
	"\t}\n"
	"\t// !racesow\n"
	"\tif( self->moveinfo.wait >= 0 )\n")

edit("game/g_func.cpp", "func_button: touchable regardless of targetname",
	"\t\tent->die = button_killed;\n"
	"\t\tent->takedamage = DAMAGE_YES;\n"
	"\t}\n"
	"\telse if( !ent->targetname )\n",
	"\t\tent->die = button_killed;\n"
	"\t\tent->takedamage = DAMAGE_YES;\n"
	"\t}\n"
	"\telse // racesow - all buttons without health should be touchable regardless of targetname\n")

# --- g_items.cpp ---------------------------------------------------------------
edit("game/g_items.cpp", "no powerup-respawn global sound in race",
	"\t// powerups announce their presence with a global sound\n"
	"\tif( ent->item && ( ent->item->type & IT_POWERUP ) )\n",
	"\t// powerups announce their presence with a global sound\n"
	"\tif( ent->item && ( ent->item->type & IT_POWERUP ) && !GS_RaceGametype() ) // racesow\n")

edit("game/g_items.cpp", "powerup timeout uses entity count in race",
	"\t\tif( flags & DROPPED_ITEM )\n"
	"\t\t\ttimeout = count + 1;\n",
	"\t\tif( GS_RaceGametype() || flags & DROPPED_ITEM ) // racesow\n"
	"\t\t\ttimeout = count + 1;\n")

edit("game/g_items.cpp", "health >197 trigger-spam guard",
	"\t// start from at least 0.5, so the player sees his health increase the correct amount\n",
	"\t// racesow : very ugly hack :(\n"
	"\t// avoid trigger spamming on certain maps, other solutions?\n"
	"\tif( other->health > 197 )\n"
	"\t\treturn false;\n"
	"\t// !racesow\n"
	"\n"
	"\t// start from at least 0.5, so the player sees his health increase the correct amount\n")

edit("game/g_items.cpp", "Use_Item",
	"/*\n"
	"* Touch_Item\n"
	"*/\n"
	"void Touch_Item( edict_t *ent, edict_t *other, cplane_t *plane, int surfFlags )\n",
	"/*\n"
	"* Use_Item\n"
	"*/\n"
	"void Touch_Item( edict_t *ent, edict_t *other, cplane_t *plane, int surfFlags );\n"
	"\n"
	"// racesow: a trigger targeting an item hands it to the activator\n"
	"static void Use_Item( edict_t *ent, edict_t *other, edict_t *activator )\n"
	"{\n"
	"\tif( !activator )\n"
	"\t\treturn;\n"
	"\tTouch_Item( ent, activator, NULL, 0 );\n"
	"}\n"
	"\n"
	"/*\n"
	"* Touch_Item\n"
	"*/\n"
	"void Touch_Item( edict_t *ent, edict_t *other, cplane_t *plane, int surfFlags )\n")

edit("game/g_items.cpp", "item targets fire on every pickup",
	"\t\tG_UseTargets( ent, other );\n"
	"\t\tent->spawnflags |= ITEM_TARGETS_USED;\n",
	"\t\tG_UseTargets( ent, other );\n"
	"\t\t// ent->spawnflags |= ITEM_TARGETS_USED; // racesow: fire every time\n")

edit("game/g_items.cpp", "health stays in race",
	"\t\tif( (item->type & IT_WEAPON ) && GS_RaceGametype() )\n",
	"\t\tif( (item->type & IT_WEAPON || item->type & IT_HEALTH ) && GS_RaceGametype() ) // racesow\n")

edit("game/g_items.cpp", "items get a use function; targeted items float",
	"\tent->touch = Touch_Item;\n"
	"\tent->attenuation = 1;\n"
	"\n"
	"\tif( ent->spawnflags & 1 )\n"
	"\t\tent->gravity = 0;\n",
	"\tent->touch = Touch_Item;\n"
	"\tent->use = Use_Item; // racesow\n"
	"\tent->attenuation = 1;\n"
	"\n"
	"\tif( ent->spawnflags & 1 || ent->targetname ) // racesow\n"
	"\t\tent->gravity = 0;\n")

edit("game/g_items.cpp", "no important item timers in race",
	"\t\tif( G_ItemTimerNeeded( ent->item ) )\n",
	"\t\tif( G_ItemTimerNeeded( ent->item ) && !GS_RaceGametype() ) // racesow: no item timers\n")

edit("game/g_items.cpp", "no optional item timers in race",
	"\tif( num_timers < MAX_IMPORTANT_ITEMS_THRESHOLD )\n",
	"\tif( num_timers < MAX_IMPORTANT_ITEMS_THRESHOLD && !GS_RaceGametype() ) // racesow: no item timers\n")

edit("game/g_items.cpp", "clamp non-positive item counts",
	"\tent->s.effects = 0; // default effects are applied client side\n"
	"}\n",
	"\tent->s.effects = 0; // default effects are applied client side\n"
	"\n"
	"\tif ( ent->count < 1 ) // racesow: fix for negative ammo counts in defrag (infinite ammo?)\n"
	"\t{\n"
	"\t\tent->count = 1;\n"
	"\t}\n"
	"}\n")

edit("game/g_awards.cpp", "no pickup awards in race",
	"void G_AwardPlayerPickup( edict_t *self, edict_t *item )\n"
	"{\n"
	"\tif( !item )\n",
	"void G_AwardPlayerPickup( edict_t *self, edict_t *item )\n"
	"{\n"
	"\tif( !item || GS_RaceGametype() ) // racesow no item timing awards\n")

# --- target_push ---------------------------------------------------------------
edit("game/g_spawn.cpp", "target_push spawn function",
	"\t{ \"target_push\", SP_info_notnull },\n",
	"\t{ \"target_push\", SP_target_push }, // racesow\n")

edit("game/g_local.h", "SP_target_push declaration",
	"void SP_trigger_push( edict_t *ent );\n",
	"void SP_trigger_push( edict_t *ent );\n"
	"void SP_target_push( edict_t *ent ); // racesow\n")

edit("game/g_trigger.cpp", "SP_target_push",
	"//==============================================================================\n"
	"//\n"
	"//trigger_hurt\n",
	"// racesow\n"
	"static void Use_target_push( edict_t *self, edict_t *other, edict_t *activator )\n"
	"{\n"
	"\tif( !activator || !activator->r.client || activator->r.client->ps.pmove.pm_type != PM_NORMAL )\n"
	"\t\treturn;\n"
	"\n"
	"\tVectorCopy( self->s.origin2, activator->velocity );\n"
	"}\n"
	"\n"
	"//QUAKED target_push (.5 .5 .5) (-8 -8 -8) (8 8 8) bouncepad\n"
	"//Pushes the activator in the direction of angle, or towards a target apex.\n"
	"//-------- KEYS --------\n"
	"//speed: Default 1000\n"
	"void SP_target_push( edict_t *self )\n"
	"{\n"
	"\tif( !self->speed )\n"
	"\t\tself->speed = 1000;\n"
	"\n"
	"\tG_SetMovedir( self->s.angles, self->s.origin2 );\n"
	"\tVectorScale( self->s.origin2, self->speed, self->s.origin2 );\n"
	"\n"
	"\tif( self->target )\n"
	"\t{\n"
	"\t\tVectorCopy( self->s.origin, self->r.absmin );\n"
	"\t\tVectorCopy( self->s.origin, self->r.absmax );\n"
	"\t\tself->r.svflags |= SVF_TRANSMITORIGIN2;\n"
	"\t\tself->think = trigger_push_setup;\n"
	"\t\tself->nextThink = level.time + 1;\n"
	"\t}\n"
	"\tself->use = Use_target_push;\n"
	"}\n"
	"// !racesow\n"
	"\n"
	"//==============================================================================\n"
	"//\n"
	"//trigger_hurt\n")

# --- script spawn functions take precedence ------------------------------------
edit("game/g_spawn.cpp", "script spawn functions win over C ones",
	"\t// check normal spawn functions\n"
	"\tfor( s = spawns; s->name; s++ )\n",
	"\t// racesow - Give gametype definitions precedence over C ones\n"
	"\tif( G_asCallMapEntitySpawnScript( ent->classname, ent ) )\n"
	"\t\treturn true; // handled by the script\n"
	"\t// !racesow\n"
	"\n"
	"\t// check normal spawn functions\n"
	"\tfor( s = spawns; s->name; s++ )\n")

edit("game/g_local.h", "ISBRUSHMODEL leaves room for non-inline models",
	"#define ISBRUSHMODEL( x ) ( ( ( x > 0 ) && ( (int)x < trap_CM_NumInlineModels() ) ) ? true : false )\n",
	"// racesow: fix maps with many models: allows for 50 non-inline models to load\n"
	"#define ISBRUSHMODEL( x ) ( ( ( x > 0 ) && ( (int)x < trap_CM_NumInlineModels() ) && ( (int)x < MAX_MODELS - 50 ) ) ? true : false )\n")

# --- g_utils.cpp ---------------------------------------------------------------
edit("game/g_utils.cpp", "clients use MASK_PLAYERSOLID",
	"\t\tsolidmask = MASK_MONSTERSOLID;\n"
	"\telse\n"
	"\t\tsolidmask = ent->r.clipmask ? ent->r.clipmask : MASK_SOLID;\n",
	"\t\tsolidmask = MASK_MONSTERSOLID;\n"
	"\t// racesow\n"
	"\telse if( ent->r.client )\n"
	"\t\tsolidmask = MASK_PLAYERSOLID;\n"
	"\t// !racesow\n"
	"\telse\n"
	"\t\tsolidmask = ent->r.clipmask ? ent->r.clipmask : MASK_SOLID;\n")

edit("game/g_utils.cpp", "spawnpoint-in-solid retry + Q3 floating spawnpoints",
	"\tvec3_t start, end;\n"
	"\ttrace_t\ttrace;\n"
	"\n"
	"\tVectorCopy( ent->s.origin, start );\n"
	"\tstart[2] += 16;\n"
	"\tVectorCopy( ent->s.origin, end );\n"
	"\tend[2] -= 16000;\n"
	"\n"
	"\tG_Trace( &trace, start, playerbox_stand_mins, playerbox_stand_maxs, end, ent, MASK_PLAYERSOLID );\n"
	"\tif( trace.startsolid || trace.allsolid )\n"
	"\t{\n"
	"\t\tG_Printf( \"Warning: %s %s spawns inside solid. Inhibited\\n\", ent->classname, vtos( ent->s.origin ) );\n"
	"\t\tG_FreeEdict( ent );\n"
	"\t\treturn;\n"
	"\t}\n"
	"\n"
	"\tif( ent->spawnflags & 1 )  //  floating items flag, we test that they are not inside solid too\n",
	"\tvec3_t start, end;\n"
	"\tvec3_t playerbox_stand_mins_fix, playerbox_stand_maxs_fix; // racesow\n"
	"\ttrace_t\ttrace;\n"
	"\tbool success = true;\n"
	"\n"
	"\tconst float HITBOX_EPSILON = 0.01f;\n"
	"\n"
	"\tVectorCopy( ent->s.origin, start );\n"
	"\tstart[2] += 16;\n"
	"\tVectorCopy( ent->s.origin, end );\n"
	"\tend[2] -= 16000;\n"
	"\n"
	"\t// try normal trace first\n"
	"\tG_Trace( &trace, start, playerbox_stand_mins, playerbox_stand_maxs, end, ent, MASK_PLAYERSOLID );\n"
	"\tsuccess = !( trace.startsolid || trace.allsolid );\n"
	"\n"
	"\t// racesow: try tighter trace second\n"
	"\tif( !success )\n"
	"\t{\n"
	"\t\tVectorCopy( playerbox_stand_mins, playerbox_stand_mins_fix );\n"
	"\t\tVectorCopy( playerbox_stand_maxs, playerbox_stand_maxs_fix );\n"
	"\n"
	"\t\tfor ( int i = 0; i < 2; i++ ) {\n"
	"\t\t\tplayerbox_stand_mins_fix[i] += HITBOX_EPSILON;\n"
	"\t\t\tplayerbox_stand_maxs_fix[i] -= HITBOX_EPSILON;\n"
	"\t\t}\n"
	"\n"
	"\t\tstart[2] -= 16 - HITBOX_EPSILON;\n"
	"\t\tG_Trace( &trace, start, playerbox_stand_mins_fix, playerbox_stand_maxs_fix, end, ent, MASK_PLAYERSOLID );\n"
	"\t\tsuccess = !( trace.startsolid || trace.allsolid );\n"
	"\t}\n"
	"\n"
	"\tif( !success )\n"
	"\t{\n"
	"\t\tG_Printf( \"Warning: %s %s spawns inside solid. Inhibited\\n\", ent->classname, vtos( ent->s.origin ) );\n"
	"\t\tG_FreeEdict( ent );\n"
	"\t\treturn;\n"
	"\t}\n"
	"\n"
	"\t// racesow: Q3 (IBSP) spawnpoints float where the mapper put them\n"
	"\tif( ent->spawnflags & 1 || !Q_stricmp( cm_mapHeader->string, \"IBSP\" ) )  //  floating items flag, we test that they are not inside solid too\n")

# --- p_client.cpp --------------------------------------------------------------
edit("game/p_client.cpp", "inactive player leaves the spawn queue",
	"\t\t\tG_Teams_SetTeam( ent, TEAM_SPECTATOR );\n"
	"\t\t\tclient->queueTimeStamp = 0;\n",
	"\t\t\tG_Teams_SetTeam( ent, TEAM_SPECTATOR );\n"
	"\t\t\tG_SpawnQueue_RemoveClient( ent ); // racesow - set player in free-view\n"
	"\t\t\tclient->queueTimeStamp = 0;\n")


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
