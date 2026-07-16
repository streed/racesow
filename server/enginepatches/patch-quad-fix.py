#!/usr/bin/env python3
"""rs_quad_fix: Quake3/defrag-style quad damage rocket-jump boost.

Background
----------
In Quake 3 (and defrag), knockback is derived from damage, so the quad
powerup's damage multiplier also multiplies self-knockback -- a quaded rocket
jump launches you much higher. Warsow has the same intent: it defines
QUAD_KNOCKBACK_SCALE (=3, matching Q3's default g_quadfactor) in g_local.h and
scales BOTH damage and knockback by it at weapon-fire time (p_weapon.cpp).

BUT racesow's "weapon jumps hack" in G_RadiusDamage (g_combat.cpp) *recomputes*
self-knockback from the rs_<weapon>_minKnockback / rs_<weapon>_maxKnockback
cvars (times g_self_knockback) whenever a player splash-hits themselves. That
recompute REPLACES the fire-time knockback wholesale, throwing away the quad
scaling -- so on a normal race server quad has no effect on rocket / plasma /
grenade jumps.

This patch re-applies a quad factor to that recomputed self-knockback, behind
two server cvars:
  * rs_quad_fix             (default 0) -- master on/off; 0 = stock racesow.
  * rs_quad_knockback_scale (default 3) -- the multiplier used when enabled.
                            Q3's g_quadfactor is 3; ~2 approximates the feel of
                            a Q3 rocket jump (Q3 caps knockback at 200, so its
                            high-damage weapons only reach ~2x up close).
It only touches the self-jump path, so it has no effect on damage/knockback
dealt to other players (that path already keeps quad scaling via projectileInfo,
and is moot in a solo time-trial anyway).

Files edited (all independent of the g_ascript.cpp natives patches):
  * game/g_racesow.h   -- extern declarations of the two cvars
  * game/g_racesow.cpp -- definitions + registration in RS_Init()
  * game/g_combat.cpp  -- the quad-knockback boost in G_RadiusDamage

Run from the qfusion source/ directory. Exits non-zero (failing the image
build) if any anchor is not found exactly once.
"""
import sys


def patch(path, old, new, what):
    # Explicit utf-8 + surrogateescape: the 18.04 build container runs a POSIX
    # (ASCII) locale, where locale-default open() dies on any non-ASCII byte in
    # the sources. All INSERTED text below is kept strictly ASCII.
    src = open(path, encoding="utf-8", errors="surrogateescape").read()
    if src.count(old) != 1:
        sys.exit("FATAL: %s anchor not found exactly once in %s" % (what, path))
    open(path, "w", encoding="utf-8", errors="surrogateescape").write(src.replace(old, new))
    print("patched:", what)


# --- 1. extern declaration (g_racesow.h) ------------------------------------
H_ANCHOR = "extern cvar_t *rs_gunblade_splashfrac;\n"
H_NEW = H_ANCHOR + (
    "// racesow-docker: Q3/defrag-style quad self-knockback (see patch-quad-fix.py)\n"
    "extern cvar_t *rs_quad_fix;             // enable toggle (default 0)\n"
    "extern cvar_t *rs_quad_knockback_scale; // factor when enabled (Q3 g_quadfactor = 3)\n"
)
patch("game/g_racesow.h", H_ANCHOR, H_NEW, "rs_quad_fix extern")

# --- 2a. definition (g_racesow.cpp) -----------------------------------------
DEF_ANCHOR = "cvar_t *rs_gunblade_splashfrac;\n"
DEF_NEW = DEF_ANCHOR + (
    "// racesow-docker: rs_quad_fix + scale (see patch-quad-fix.py)\n"
    "cvar_t *rs_quad_fix;\n"
    "cvar_t *rs_quad_knockback_scale;\n"
)
patch("game/g_racesow.cpp", DEF_ANCHOR, DEF_NEW, "rs_quad_fix definition")

# --- 2b. registration in RS_Init() (g_racesow.cpp) --------------------------
# rs_quad_fix default "0": off unless an admin sets it to 1 to test. The scale
# defaults to "3" (Q3 g_quadfactor) but only bites when rs_quad_fix is on, so
# the shipped default behavior is unchanged. CVAR_ARCHIVE to match the sibling
# rs_* knockback cvars (persists in the server config).
REG_ANCHOR = (
    "\trs_gunblade_splashfrac = trap_Cvar_Get( \"rs_gunblade_splashfrac\", "
    "\"1.3\", CVAR_ARCHIVE );\n"
)
REG_NEW = REG_ANCHOR + (
    "\trs_quad_fix = trap_Cvar_Get( \"rs_quad_fix\", \"0\", CVAR_ARCHIVE );\n"
    "\trs_quad_knockback_scale = trap_Cvar_Get( \"rs_quad_knockback_scale\", "
    "\"3\", CVAR_ARCHIVE );\n"
)
patch("game/g_racesow.cpp", REG_ANCHOR, REG_NEW, "rs_quad_fix registration")

# --- 3. the quad-knockback boost (g_combat.cpp, G_RadiusDamage) -------------
# Injected immediately after the self-jump knockback recompute, still inside the
# `if( weapondef && rs_minKnockback && rs_maxKnockback && rs_radius )` block so
# it only scales the recomputed (quad-stripped) value -- never the fallback
# projectileInfo path, which already carries quad scaling (avoids double-apply).
# ent == attacker here, so ent->r.client is the firing player. 4 tabs to match.
COMBAT_ANCHOR = (
    "\t\t\t\tknockback = ( rs_minKnockback + ( (float)( rs_maxKnockback - "
    "rs_minKnockback ) * kickFrac ) ) * g_self_knockback->value;\n"
)
COMBAT_NEW = COMBAT_ANCHOR + (
    "\t\t\t\t// racesow-docker: rs_quad_fix - restore Quake3/defrag quad rocket-jump\n"
    "\t\t\t\t// boost. The recompute above replaces the fire-time knockback (which\n"
    "\t\t\t\t// Warsow otherwise scales by QUAD_KNOCKBACK_SCALE for direct hits), so\n"
    "\t\t\t\t// without this quad has no effect on jumps. rs_quad_knockback_scale sets\n"
    "\t\t\t\t// the factor (Q3 g_quadfactor default = 3; ~2 approximates Q3 rockets\n"
    "\t\t\t\t// under their 200 knockback cap). ent == attacker here.\n"
    "\t\t\t\tif( rs_quad_fix->integer && ent->r.client->ps.inventory[POWERUP_QUAD] > 0 )\n"
    "\t\t\t\t\tknockback *= rs_quad_knockback_scale->value;\n"
)
patch("game/g_combat.cpp", COMBAT_ANCHOR, COMBAT_NEW, "rs_quad_fix knockback boost")

print("quad-fix patch applied")
