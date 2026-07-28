#!/usr/bin/env python3
# TEMPORARY diagnostic: trace race trigger dispatch (start/checkpoint/finish).
# Logs, for each touch of a trigger targeting a *Timer*/checkpoint entity, the
# G_TriggerWait decision + the player's debounce state. Removed once the Warfork
# start-trigger-fires-once bug is understood. Run from source/ (cwd via `cd source`).
import sys
PATH = "game/g_trigger.cpp"
src = open(PATH, encoding="utf-8", errors="surrogateescape").read()

OLD = (
    "static void multi_trigger( edict_t *ent )\n"
    "{\n"
    "\tif( G_TriggerWait( ent, ent->activator ) )\n"
    "\t\treturn;\t\t// already been triggered\n"
    "\n"
    "\tG_UseTargets( ent, ent->activator );\n"
)
NEW = (
    "static void multi_trigger( edict_t *ent )\n"
    "{\n"
    "\tbool rsdbg_b = G_TriggerWait( ent, ent->activator );\n"
    "\tif( ent->target && ( strstr( ent->target, \"Timer\" ) || strstr( ent->target, \"checkpoint\" ) ) )\n"
    "\t\tfprintf( stderr, \"RSDBG mt tgt=%s wait=%f blk=%d to=%u te=%d lt=%d inuse=%d\\n\",\n"
    "\t\t\tent->target, ent->wait, (int)rsdbg_b,\n"
    "\t\t\tent->activator ? ent->activator->trigger_timeout : 0u,\n"
    "\t\t\t( ent->activator && ent->activator->trigger_entity ) ? (int)( ent->activator->trigger_entity - game.edicts ) : -1,\n"
    "\t\t\tlevel.time, (int)ent->r.inuse );\n"
    "\tif( rsdbg_b )\n"
    "\t\treturn;\t\t// already been triggered\n"
    "\n"
    "\tG_UseTargets( ent, ent->activator );\n"
)
if src.count(OLD) != 1:
    sys.exit("FATAL: multi_trigger anchor not found exactly once in " + PATH)
src = src.replace(OLD, NEW)

# also log when a trigger frees itself (wait<=0 path)
OLD2 = (
    "\tif( ent->wait <= 0 )\n"
    "\t{\n"
    "\t\t// we can't just remove (self) here, because this is a touch function\n"
)
NEW2 = (
    "\tif( ent->wait <= 0 )\n"
    "\t{\n"
    "\t\tif( ent->target && ( strstr( ent->target, \"Timer\" ) || strstr( ent->target, \"checkpoint\" ) ) )\n"
    "\t\t\tfprintf( stderr, \"RSDBG FREEING trigger tgt=%s wait=%f\\n\", ent->target, ent->wait );\n"
    "\t\t// we can't just remove (self) here, because this is a touch function\n"
)
if src.count(OLD2) == 1:
    src = src.replace(OLD2, NEW2)

open(PATH, "w", encoding="utf-8", errors="surrogateescape").write(src)
print("DEBUG trigger patch applied")
