"""
repairs.py -- the edits, each one the minimum that makes the map playable.

Two rules hold for every repair here:

  * It only ever writes lump 0 or the flags word of lump 1. Nothing rebuilds
    geometry, and nothing renumbers anything.
  * It refuses when the right answer is ambiguous. A repair that guesses is
    worse than a finding that stays open, because a guess ships silently.
"""
from bsp import SURF_NOWALLJUMP
from checks import BRUSH_CLASSES, TELEPORT_ACTOR_CLASSES, TELEPORT_CLASSES, spawns

# Q3 / defrag classnames with an unambiguous Warsow equivalent. Deliberately
# short: every entry restores what the mapper clearly meant, and anything with a
# judgement call in it (item_haste, holdable_*, weapon_grapplinghook, ammo_nails
# -- Warsow has no equivalent at all) is left off rather than approximated.
# Opt-in via --enable translate-classname; it changes what a map contains.
CLASSNAME_TRANSLATIONS = {
    "item_health": "item_health_medium",        # Q3's 25hp bubble
    "item_armor_green": "item_armor_ga",
    "target_smallprint": "target_print",        # defrag's small centerprint
    "shooter_rocket_targetplayer": "shooter_rocket",
    "shooter_plasma_targetplayer": "shooter_plasma",
    "shooter_grenade_targetplayer": "shooter_grenade",
}

ALL_REPAIRS = ("walljump", "reattach-orphan-model", "drop-dead-brush-ent",
               "drop-dead-teleport", "retarget-teleport", "translate-classname")
DEFAULT_REPAIRS = ("walljump", "reattach-orphan-model", "drop-dead-brush-ent",
                   "drop-dead-teleport", "retarget-teleport")


class Change:
    __slots__ = ("repair", "detail")

    def __init__(self, repair, detail):
        self.repair = repair
        self.detail = detail

    def __str__(self):
        return f"{self.repair}: {self.detail}"


def apply_walljump(bsp, clearable, enabled):
    if "walljump" not in enabled or not clearable:
        return []
    refs = bsp.shaderrefs()
    for i in clearable:
        bsp.set_shaderref_flags(i, refs[i][1] & ~SURF_NOWALLJUMP)
    names = sorted({refs[i][0] for i in clearable})
    return [Change("walljump",
                   f"cleared SURF_NOWALLJUMP on {len(clearable)} shaderrefs "
                   f"({', '.join(names[:3])}{', ...' if len(names) > 3 else ''})")]


def _orphan_models(lump, bsp):
    """Brush models no entity claims. Model 0 is the world and never orphaned."""
    used = set()
    for e in lump.entities:
        m = e.get("model", "")
        if m.startswith("*"):
            try:
                used.add(int(m[1:]))
            except ValueError:
                pass
    return [i for i in range(1, bsp.model_count()) if i not in used]


def apply_entity_repairs(lump, bsp, enabled):
    changes = []

    # 1. Brush entities with no model. Prefer giving the brush back over
    #    deleting the entity, but only when there is exactly one candidate and
    #    exactly one claimant -- with two of either, matching them up is a
    #    guess about geometry this tool cannot see.
    modelless = [e for e in lump.entities
                 if e.classname.lower() in BRUSH_CLASSES and e.get("model") is None]
    if modelless and "reattach-orphan-model" in enabled:
        orphans = _orphan_models(lump, bsp)
        if len(orphans) == 1 and len(modelless) == 1:
            ent = modelless[0]
            ent.set("model", f"*{orphans[0]}")
            changes.append(Change("reattach-orphan-model",
                                  f"#{ent.index} {ent.classname}: attached the map's one "
                                  f"unreferenced brush model *{orphans[0]}"))
            modelless = []
        elif orphans:
            changes.append(Change("reattach-orphan-model",
                                  f"declined: {len(orphans)} unreferenced brush models for "
                                  f"{len(modelless)} model-less entities -- ambiguous, "
                                  "left for a human"))
    if modelless and "drop-dead-brush-ent" in enabled:
        for ent in modelless:
            lump.remove(ent)
            changes.append(Change("drop-dead-brush-ent",
                                  f"#{ent.index} {ent.classname}: removed -- the engine frees "
                                  "it anyway, and on unpatched Warfork it dropped the server"))

    # 2. trigger_teleport with no destination key at all. The engine frees it
    #    outright, so removing it changes nothing at runtime -- it just stops the
    #    dead entity tripping the same Warfork brush-model crash path.
    #    Restricted to trigger_teleport ON PURPOSE: a target_teleporter without a
    #    "target" is a destination marker that other teleports point at, and
    #    removing those would break the maps rather than fix them.
    if "drop-dead-teleport" in enabled:
        for ent in [e for e in lump.entities
                    if e.classname.lower() in TELEPORT_ACTOR_CLASSES and not e.get("target")]:
            lump.remove(ent)
            changes.append(Change("drop-dead-teleport",
                                  f"#{ent.index} {ent.classname}: removed -- teleporter with "
                                  "no target"))

    # 3. Teleporters whose target does not resolve. G_Find already matches
    #    case-insensitively, so the only recoverable misses are stray whitespace
    #    -- and only when the trimmed name hits exactly one entity.
    if "retarget-teleport" in enabled:
        names = lump.targetnames()
        for ent in lump.entities:
            if ent.classname.lower() not in TELEPORT_CLASSES:
                continue
            target = ent.get("target")
            if not target or target.lower() in names:
                continue
            hit = names.get(target.strip().lower(), [])
            if len(hit) >= 1 and target.strip():
                ent.set("target", target.strip())
                changes.append(Change("retarget-teleport",
                                      f"#{ent.index} {ent.classname}: target {target!r} -> "
                                      f"{target.strip()!r}"))

    # 4. Classname translation (opt-in).
    if "translate-classname" in enabled:
        for ent in lump.entities:
            cn = ent.classname
            if cn in CLASSNAME_TRANSLATIONS and not spawns(cn):
                new = CLASSNAME_TRANSLATIONS[cn]
                ent.set("classname", new)
                changes.append(Change("translate-classname",
                                      f"#{ent.index} {cn} -> {new}"))
    return changes
