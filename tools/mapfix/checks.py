"""
checks.py -- what "broken" means, stated as the engine states it.

Every check below is anchored to a specific line of game code, named in its
docstring, because the failure modes here are all silent: the engine frees a
bad entity or refuses a walljump without printing anything a player or admin
would ever see. A check that is not anchored to real engine behaviour is a
check that will eventually delete something that worked.
"""
from gamedata import NATIVE_SPAWNS, ITEM_CLASSNAMES, AS_SPAWNS
from bsp import SURF_NOWALLJUMP

# Severity drives exit codes and the default scan output, nothing else.
BROKEN, WARN, INFO = "broken", "warn", "info"

# --- entity classes that need a brush ---------------------------------------
# Derived from the engine source, not guessed: these are the spawn functions
# that reach GClip_SetBrushModel(ent, ent->model), via InitTrigger
# (g_trigger.cpp:53), SP_trigger_multiple (g_trigger.cpp:130) or G_InitMover
# (g_utils.cpp:983). With no "model" key that call takes the NULL branch at
# g_clip.cpp:985, which on Warsow does GClip_UnlinkEntity + G_FreeEdict -- the
# entity is gone before the map finishes loading.
NATIVE_BRUSH_CLASSES = frozenset((
    "trigger_multiple", "trigger_once", "trigger_push", "trigger_teleport",
    "trigger_hurt", "trigger_gravity",
    "func_bobbing", "func_button", "func_conveyor", "func_door",
    "func_door_rotating", "func_pendulum", "func_plat", "func_rotating",
    "func_train", "func_water", "func_wall", "func_static", "func_object",
    "func_explosive",
))
# The racemod's own brush entities, which call Entity::setupModel(self.model)
# instead (hrace/entities/trigger_push_velocity.as:47, xonotic.as:30). These are
# not freed, but a brush entity with no brush has no volume, so it can never be
# touched either way.
AS_BRUSH_CLASSES = frozenset(("trigger_push_velocity", "trigger_race_checkpoint"))
BRUSH_CLASSES = NATIVE_BRUSH_CLASSES | AS_BRUSH_CLASSES

# Entities that move a player to a destination.
#
# The two are NOT symmetric, and conflating them is how you delete 1,880 working
# entities. trigger_teleport is an actor: it needs a "target", and with none it
# is freed at spawn (g_trigger.cpp:802). target_teleporter is an actor too in
# principle, but across this pool it is overwhelmingly used as a DESTINATION
# MARKER that a trigger_teleport points AT -- 1,880 of the 1,884 in the pool
# carry no "target" at all, and the racemod treats it as a destination
# alongside misc_teleporter_dest (hrace.as:1268). So "no target" is normal for
# target_teleporter and a hard fault for trigger_teleport.
TELEPORT_ACTOR_CLASSES = frozenset(("trigger_teleport",))
TELEPORT_CLASSES = frozenset(("trigger_teleport", "target_teleporter"))

# Classnames that start or stop the race clock, i.e. what makes a map raceable
# at all. Both spellings are live: the racemod defines target_starttimer and
# target_startTimer because the AngelScript lookup is case-sensitive
# (hrace/entities/timers.as).
START_CLASSES = frozenset(("target_starttimer", "target_startTimer"))
STOP_CLASSES = frozenset(("target_stoptimer", "target_stopTimer"))

# Shaders whose NAME says the mapper meant no-walljump. Never cleared, even in a
# map whose flag is otherwise a blanket compile artifact. "noob" is the defrag /
# racesow convention for a deliberately unwalljumpable surface; the pool also
# has nowj_*, *_nowj, nowalljumpclip and nowalljumpcaulk. Matching is on the
# shader's last path segment so that a texture merely called "object003_side"
# is not mistaken for one of them.
INTENT_SUBSTRINGS = ("noob", "nowj", "nowalljump")
INTENT_EXACT = ("ob",)


def shader_is_deliberate_nowalljump(name: str) -> bool:
    leaf = name.rsplit("/", 1)[-1].lower()
    if leaf in INTENT_EXACT:
        return True
    return any(s in leaf for s in INTENT_SUBSTRINGS)


def spawns(classname: str) -> bool:
    """Reproduce G_CallSpawn (g_spawn.cpp:260) exactly, including its case rules.

    Order matters and so does case: G_ItemForEntity and the spawns[] table use
    Q_stricmp, but G_asCallMapEntitySpawnScript binds an AngelScript function by
    exact name. An entity whose classname resolves nowhere is simply not
    spawned -- G_CallSpawn returns false and the edict is freed, silently unless
    the server runs with developer or sv_cheats set.
    """
    lower = classname.lower()
    return (lower in ITEM_CLASSNAMES_CI
            or classname in AS_SPAWNS
            or lower in NATIVE_SPAWNS_CI)


ITEM_CLASSNAMES_CI = frozenset(c.lower() for c in ITEM_CLASSNAMES)
NATIVE_SPAWNS_CI = frozenset(c.lower() for c in NATIVE_SPAWNS)


class Finding:
    __slots__ = ("code", "severity", "entity_index", "classname", "detail", "fix")

    def __init__(self, code, severity, detail, entity_index=None, classname="", fix=None):
        self.code = code
        self.severity = severity
        self.detail = detail
        self.entity_index = entity_index
        self.classname = classname
        self.fix = fix              # name of the repair that would address it

    def as_dict(self):
        return {"code": self.code, "severity": self.severity, "detail": self.detail,
                "entity": self.entity_index, "classname": self.classname,
                "fix": self.fix}

    def __str__(self):
        where = f" #{self.entity_index} {self.classname}" if self.entity_index is not None else ""
        return f"[{self.code}]{where} {self.detail}"


def walljump_findings(bsp, threshold):
    """SURF_NOWALLJUMP (q_collision.h:83) makes gs_pmove.c:178 skip the wall, so
    a player simply cannot walljump off that surface.

    Some maps carry the bit on essentially EVERY shaderref -- including
    "noshader", common/trigger and the skybox, none of which a mapper would ever
    mark by hand. That is a compile artifact, and it disables walljumping across
    the whole map. The pool's 577 hand-made "-wjfix" maps are exactly this bit
    cleared; diffing four of them against their originals shows lump 1 as the
    only difference, and only this one bit within it.

    A map that carries the bit on a MINORITY of its shaderrefs is the opposite
    case: there the flagged shaders are named common/noob, nowalljumpclip,
    nowj_orange and so on. That is intent, and it is left alone.
    """
    refs = bsp.shaderrefs()
    if not refs:
        return [], []
    flagged = [i for i, (_, f, _) in enumerate(refs) if f & SURF_NOWALLJUMP]
    if not flagged:
        return [], []
    frac = len(flagged) / len(refs)
    if frac < threshold:
        names = sorted({refs[i][0] for i in flagged})
        return [Finding("WALLJUMP_SELECTIVE", INFO,
                        f"{len(flagged)}/{len(refs)} shaderrefs carry SURF_NOWALLJUMP "
                        f"({', '.join(names[:4])}) -- reads as deliberate, left alone")], []
    clearable = [i for i in flagged if not shader_is_deliberate_nowalljump(refs[i][0])]
    kept = [refs[i][0] for i in flagged if i not in set(clearable)]
    detail = (f"SURF_NOWALLJUMP on {len(flagged)}/{len(refs)} shaderrefs "
              f"({frac:.0%}) -- walljump is dead map-wide")
    if kept:
        detail += f"; keeping deliberate {', '.join(sorted(set(kept)))}"
    return [Finding("WALLJUMP_BLANKET", BROKEN, detail, fix="walljump")], clearable


def entity_findings(lump, bsp):
    """Everything that makes a trigger or a teleport silently not exist."""
    out = []
    nmodels = bsp.model_count()
    targetnames = lump.targetnames()
    spawnable = {}

    for ent in lump.entities:
        cn = ent.classname
        cl = cn.lower()
        spawnable[ent.index] = spawns(cn) if cn else False

        if cn and not spawns(cn):
            out.append(Finding("CLASSNAME_UNSPAWNABLE", INFO,
                               "no spawn function in the engine, gs_items or any loaded "
                               "racemod section -- the entity is dropped at map load",
                               ent.index, cn, fix="translate-classname"))

        if cl in BRUSH_CLASSES:
            model = ent.get("model")
            if model is None:
                out.append(Finding("BRUSH_NO_MODEL", BROKEN,
                                   "brush entity with no \"model\" key -- freed at spawn "
                                   "(g_clip.cpp:985), so the volume does not exist",
                                   ent.index, cn, fix="drop-dead-brush-ent"))
            elif not model.startswith("*"):
                out.append(Finding("BRUSH_BAD_MODEL", BROKEN,
                                   f"model {model!r} is not an inline brush model",
                                   ent.index, cn))
            else:
                try:
                    idx = int(model[1:])
                except ValueError:
                    idx = -1
                if idx < 1 or idx >= nmodels:
                    out.append(Finding("BRUSH_BAD_MODEL", BROKEN,
                                       f"model {model} is outside the {nmodels}-entry models lump",
                                       ent.index, cn))

    for ent in lump.entities:
        cl = ent.classname.lower()
        target = ent.get("target")
        if cl in TELEPORT_CLASSES:
            if not target:
                if cl in TELEPORT_ACTOR_CLASSES:
                    out.append(Finding("TELEPORT_NO_TARGET", BROKEN,
                                       "trigger_teleport with no \"target\" -- freed outright "
                                       "at spawn (g_trigger.cpp:802), so the volume is not "
                                       "there at all",
                                       ent.index, ent.classname, fix="drop-dead-teleport"))
                # A target_teleporter with no "target" is a destination marker,
                # which is the normal shape in this pool. Not a finding.
                continue
            dests = targetnames.get(target.lower(), [])
            if not dests:
                out.append(Finding("TELEPORT_DEST_MISSING", BROKEN,
                                   f"target {target!r} names no entity -- G_Find returns NULL "
                                   "and the player walks straight through",
                                   ent.index, ent.classname, fix="retarget-teleport"))
            elif not any(spawnable.get(d.index) for d in dests):
                out.append(Finding("TELEPORT_DEST_UNSPAWNED", BROKEN,
                                   f"target {target!r} resolves only to "
                                   f"{dests[0].classname!r}, which has no spawn function, so "
                                   "the destination is freed before any player reaches it",
                                   ent.index, ent.classname))
        elif target and target.lower() not in targetnames:
            out.append(Finding("TARGET_DANGLING", WARN,
                               f"target {target!r} names no entity",
                               ent.index, ent.classname))

    classes = {e.classname for e in lump.entities}
    if not (classes & START_CLASSES) and "trigger_race_checkpoint" not in classes:
        out.append(Finding("NO_START_TIMER", WARN,
                           "no target_starttimer / trigger_race_checkpoint -- the race clock "
                           "can never start on this map"))
    if not (classes & STOP_CLASSES) and "trigger_race_checkpoint" not in classes:
        out.append(Finding("NO_STOP_TIMER", WARN,
                           "no target_stoptimer -- a started race can never finish"))
    return out
