#!/usr/bin/env python3
"""
Warfork port: racesow weapon physics -- Warsow parity (design doc D2).

Gelmo's g_racesow.{cpp,h} (vendored in warfork/enginepatches, byte-identical to
DenMSC/racemod_2.1's) already REGISTERS the rs_* weapon cvars
(rs_rocket_speed, rs_grenade_maxKnockback, rs_plasma_prestep, ...), but until
now nothing read them: RS_Init() was never called and the weapon code was stock
Warfork. So rocket / grenade / plasma jumps -- and every weapon map -- played
differently on Warfork than on Warsow, on one shared leaderboard.

This wires the layer in exactly the way racemod_2.1 does. Every hunk below is
racemod's own, keyed to the same code (Warfork 2.15.1's weapon code is
unchanged from warsow_21_sdk at each anchor):

  g_spawn.cpp   RS_Init() at the end of G_InitLevel (registers the rs_* cvars
                before anything can fire).
  g_clip.cpp    RS_SplashFrac4D (antilag wrapper over RS_SplashFrac).
  g_combat.cpp  G_RadiusDamage self-knockback ("weapon jumps hack") recomputed
                from rs_<weapon>_{min,max}Knockback, rs_<weapon>_splash and
                rs_<weapon>_splashfrac through RS_SplashFrac4D. This block is
                byte-identical to racemod's, so server/enginepatches/
                patch-quad-fix.py (rs_quad_fix) applies on top unchanged.
  g_weapon.cpp  grenade / rocket / plasma use rs_* speed, knockback, splash,
                timeout, gravity; strong grenades bounce twice with
                rs_grenade_friction and bounce off brush models; rockets are
                half speed under water; plasma hitting a SURF_NOIMPACT button
                does no knockback (plasma-shooter maps); an electrobolt stops
                at a shootable button so it activates it; a race player's
                projectile never touches a same-team client; explosion events
                carry ownerNum.
  p_weapon.cpp  per-weapon rs_*_prestep in race; rs_plasma_hack toggles the
                plasma backtrace; rs_rocket_antilag; NO_ROCKET_ANTILAG covers
                plasma too; a weapon pickup raises PSEV_PICKUP (autoswitch).
  gs_weapondefs rocket launcher reload 850 ms (racesow; stock 950) and
                projectile timeout 100 s. Weapon defs reach clients through
                configstrings, so client prediction follows the server.

Not ported, on purpose:
  * level.gametype.playerInteraction. Racemod adds it and ANDs `!it` into every
    race check, but nothing sets it (the gametype scripts never touch it), so
    every one of those edits is a no-op.
  * the gs_pmove.c / gs_public.h movement changes (dash speed 451,
    PM_SnapPosition keeping velocity). Warfork clients predict movement with
    their own stock copy of that code, so a server-only change would cause
    prediction corrections.

Racemod quirks kept for parity: the gunblade self-knockback uses
rs_rocket_splashfrac (not rs_gunblade_splashfrac), and W_Fire_Grenade /
W_Fire_Rocket / W_Fire_Plasma ignore the speed/knockback/splash they are
passed in favour of the rs_* cvars (map shooters included, as on Warsow).
One guard added: racemod's rs_rocket_antilag early-return dereferences
`projectile` without a NULL check; we check it.

Run from source/ (cwd = warfork-qfusion/source), after patch-pjstate-natives.py
(which includes g_racesow.h from g_local.h). Fails loudly if any anchor is not
found the expected number of times.
"""
import sys

EDITS = []


def edit(path, what, old, new, count=1):
	EDITS.append((path, what, old, new, count))


# --- RS_Init -------------------------------------------------------------------
edit("game/g_spawn.cpp", "RS_Init at level init",
	"\tG_asGarbageCollect( true );\n"
	"}\n"
	"\n"
	"void G_ResetLevel( void )\n",
	"\tG_asGarbageCollect( true );\n"
	"\n"
	"\tRS_Init(); // racesow\n"
	"}\n"
	"\n"
	"void G_ResetLevel( void )\n")

# --- RS_SplashFrac4D -----------------------------------------------------------
edit("game/g_clip.cpp", "RS_SplashFrac4D",
	"\tclipEnt = GClip_GetClipEdictForDeltaTime( entNum, timeDelta );\n"
	"\tG_SplashFrac( clipEnt->s.origin, clipEnt->r.mins, clipEnt->r.maxs, hitpoint, \n"
	"\t\tmaxradius, pushdir, kickFrac, dmgFrac );\n"
	"}\n",
	"\tclipEnt = GClip_GetClipEdictForDeltaTime( entNum, timeDelta );\n"
	"\tG_SplashFrac( clipEnt->s.origin, clipEnt->r.mins, clipEnt->r.maxs, hitpoint, \n"
	"\t\tmaxradius, pushdir, kickFrac, dmgFrac );\n"
	"}\n"
	"\n"
	"// racesow\n"
	"void RS_SplashFrac4D( int entNum, vec3_t hitpoint, float maxradius, vec3_t pushdir, \n"
	"\tfloat *kickFrac, float *dmgFrac, int timeDelta, float splashFrac )\n"
	"{\n"
	"\tc4clipedict_t *clipEnt;\n"
	"\n"
	"\tclipEnt = GClip_GetClipEdictForDeltaTime( entNum, timeDelta );\n"
	"\tRS_SplashFrac( clipEnt->s.origin, clipEnt->r.mins,\n"
	"\t\tclipEnt->r.maxs, hitpoint, maxradius, pushdir,\n"
	"\t\tkickFrac, dmgFrac, splashFrac );\n"
	"}\n"
	"// !racesow\n")

edit("game/g_local.h", "RS_SplashFrac4D declaration",
	"void G_SplashFrac4D( int entNum, vec3_t hitpoint, float maxradius, vec3_t pushdir, float *kickFrac, float *dmgFrac, int timeDelta );\n",
	"void G_SplashFrac4D( int entNum, vec3_t hitpoint, float maxradius, vec3_t pushdir, float *kickFrac, float *dmgFrac, int timeDelta );\n"
	"void RS_SplashFrac4D( int entNum, vec3_t hitpoint, float maxradius, vec3_t pushdir, float *kickFrac, float *dmgFrac, int timeDelta, float splashFrac ); // racesow\n")

# --- g_combat.cpp: weapon-jump self knockback ----------------------------------
edit("game/g_combat.cpp", "rs_* locals in G_RadiusDamage",
	"\tfloat maxdamage, mindamage, maxknockback, minknockback, maxstun, minstun, radius;\n"
	"\n"
	"\tassert( inflictor );\n",
	"\tfloat maxdamage, mindamage, maxknockback, minknockback, maxstun, minstun, radius;\n"
	"\n"
	"\t// racesow\n"
	"\tint rs_minKnockback = 0,\n"
	"\t    rs_maxKnockback = 0,\n"
	"\t    rs_radius = 0;\n"
	"\tfloat rs_splashfrac = 1.3;\n"
	"\t// !racesow\n"
	"\n"
	"\tassert( inflictor );\n")

edit("game/g_combat.cpp", "self knockback from rs_* cvars",
	"\t\t\tif( inflictor->s.type == ET_ROCKET )\n"
	"\t\t\t\tweapondef = GS_GetWeaponDef( WEAP_ROCKETLAUNCHER );\n"
	"\t\t\telse if( inflictor->s.type == ET_GRENADE )\n"
	"\t\t\t\tweapondef = GS_GetWeaponDef( WEAP_GRENADELAUNCHER );\n"
	"\t\t\telse if( inflictor->s.type == ET_PLASMA )\n"
	"\t\t\t\tweapondef = GS_GetWeaponDef( WEAP_PLASMAGUN );\n"
	"\t\t\telse if( inflictor->s.type == ET_BLASTER )\n"
	"\t\t\t\tweapondef = GS_GetWeaponDef( WEAP_GUNBLADE );\n"
	"\n"
	"\t\t\tif( weapondef )\n"
	"\t\t\t{\n"
	"\t\t\t\tG_SplashFrac4D( ENTNUM( ent ), inflictor->s.origin, radius, pushDir, &kickFrac, NULL, 0 );\n"
	"\n"
	"\t\t\t\tminknockback = weapondef->firedef.minknockback;\n"
	"\t\t\t\tmaxknockback = weapondef->firedef.knockback;\n"
	"\t\t\t\tclamp_high( minknockback, maxknockback );\n"
	"\t\t\t\tknockback = ( minknockback + ( (float)( maxknockback - minknockback ) * kickFrac ) ) * g_self_knockback->value;\n"
	"\t\t\t\tdamage *= weapondef->firedef.selfdamage;\n"
	"\t\t\t}\n",
	"\t\t\tif( inflictor->s.type == ET_ROCKET )\n"
	"\t\t\t{\n"
	"\t\t\t\tweapondef = GS_GetWeaponDef( WEAP_ROCKETLAUNCHER );\n"
	"\t\t\t\t// racesow\n"
	"\t\t\t\trs_minKnockback = rs_rocket_minKnockback->integer;\n"
	"\t\t\t\trs_maxKnockback = rs_rocket_maxKnockback->integer;\n"
	"\t\t\t\trs_radius = rs_rocket_splash->integer;\n"
	"\t\t\t\trs_splashfrac = rs_rocket_splashfrac->value;\n"
	"\t\t\t\t// !racesow\n"
	"\t\t\t}\n"
	"\t\t\telse if( inflictor->s.type == ET_GRENADE )\n"
	"\t\t\t{\n"
	"\t\t\t\tweapondef = GS_GetWeaponDef( WEAP_GRENADELAUNCHER );\n"
	"\t\t\t\t// racesow\n"
	"\t\t\t\trs_minKnockback = rs_grenade_minKnockback->integer;\n"
	"\t\t\t\trs_maxKnockback = rs_grenade_maxKnockback->integer;\n"
	"\t\t\t\trs_radius = rs_grenade_splash->integer;\n"
	"\t\t\t\trs_splashfrac = rs_grenade_splashfrac->value;\n"
	"\t\t\t\t// !racesow\n"
	"\t\t\t}\n"
	"\t\t\telse if( inflictor->s.type == ET_PLASMA )\n"
	"\t\t\t{\n"
	"\t\t\t\tweapondef = GS_GetWeaponDef( WEAP_PLASMAGUN );\n"
	"\t\t\t\t// racesow\n"
	"\t\t\t\trs_minKnockback = rs_plasma_minKnockback->integer;\n"
	"\t\t\t\trs_maxKnockback = rs_plasma_maxKnockback->integer;\n"
	"\t\t\t\trs_radius = rs_plasma_splash->integer;\n"
	"\t\t\t\trs_splashfrac = rs_plasma_splashfrac->value;\n"
	"\t\t\t\t// !racesow\n"
	"\t\t\t}\n"
	"\t\t\telse if( inflictor->s.type == ET_BLASTER )\n"
	"\t\t\t{\n"
	"\t\t\t\tweapondef = GS_GetWeaponDef( WEAP_GUNBLADE );\n"
	"\t\t\t\t// racesow - TODO: decide default values\n"
	"\t\t\t\trs_minKnockback = rs_gunblade_minKnockback->integer;\n"
	"\t\t\t\trs_maxKnockback = rs_gunblade_maxKnockback->integer;\n"
	"\t\t\t\trs_radius = rs_gunblade_splash->integer;\n"
	"\t\t\t\trs_splashfrac = rs_rocket_splashfrac->value;\n"
	"\t\t\t\t// !racesow\n"
	"\t\t\t}\n"
	"\n"
	"\t\t\t// racesow\n"
	"\t\t\tif( weapondef && rs_minKnockback && rs_maxKnockback && rs_radius )\n"
	"\t\t\t{\n"
	"\t\t\t\tRS_SplashFrac4D( ENTNUM( ent ), inflictor->s.origin, rs_radius, pushDir, &kickFrac, NULL, 0, rs_splashfrac );\n"
	"\n"
	"\t\t\t\tclamp_high( rs_minKnockback, rs_maxKnockback );\n"
	"\t\t\t\tknockback = ( rs_minKnockback + ( (float)( rs_maxKnockback - rs_minKnockback ) * kickFrac ) ) * g_self_knockback->value;\n"
	"\t\t\t\tdamage *= weapondef->firedef.selfdamage;\n"
	"\t\t\t}\n"
	"\t\t\t// !racesow\n")

# --- g_weapon.cpp --------------------------------------------------------------
edit("game/g_weapon.cpp", "race projectiles never touch same-team clients",
	"\t\treturn PROJECTILE_TOUCH_DIRECTHIT; // water hits are direct but don't count for awards\n"
	"\n",
	"\t\treturn PROJECTILE_TOUCH_DIRECTHIT; // water hits are direct but don't count for awards\n"
	"\n"
	"\t// racesow\n"
	"\tif( projectile->r.owner && projectile->r.owner->r.client &&\n"
	"\t\ttarget->r.client &&\n"
	"\t\tGS_RaceGametype() &&\n"
	"\t\ttarget->team == projectile->r.owner->team )\n"
	"\t\treturn PROJECTILE_TOUCH_NOT;\n"
	"\t// !racesow\n"
	"\n")

edit("game/g_weapon.cpp", "toss projectile ownerNum",
	"\t//projectile->s.modelindex = trap_ModelIndex (\"models/objects/projectile/plasmagun/proj_plasmagun2.md3\");\n"
	"\tprojectile->s.modelindex = 0;\n"
	"\tprojectile->r.owner = self;\n",
	"\t//projectile->s.modelindex = trap_ModelIndex (\"models/objects/projectile/plasmagun/proj_plasmagun2.md3\");\n"
	"\tprojectile->s.modelindex = 0;\n"
	"\tprojectile->r.owner = self;\n"
	"\tprojectile->s.ownerNum = ENTNUM( self ); // racesow\n")

edit("game/g_weapon.cpp", "gunblade blast event ownerNum",
	"\t\tevent->s.skinnum = ( ( ent->projectileInfo.maxKnockback * 1/8 ) > 255 ) ? 255 : ( ent->projectileInfo.maxKnockback * 1/8 );\n"
	"\t}\n",
	"\t\tevent->s.skinnum = ( ( ent->projectileInfo.maxKnockback * 1/8 ) > 255 ) ? 255 : ( ent->projectileInfo.maxKnockback * 1/8 );\n"
	"\t\tevent->s.ownerNum = ENTNUM( ent->r.owner ); // racesow\n"
	"\t}\n")

edit("game/g_weapon.cpp", "grenade explosion event ownerNum",
	"\tevent->s.weapon = radius;\n"
	"\n"
	"\tG_FreeEdict( ent );\n",
	"\tevent->s.weapon = radius;\n"
	"\tevent->s.ownerNum = ENTNUM( ent->r.owner ); // racesow\n"
	"\n"
	"\tG_FreeEdict( ent );\n")

edit("game/g_weapon.cpp", "strong grenades bounce twice",
	"\t// don't explode on doors and plats that take damage\n"
	"\tif( !other->takedamage || ISBRUSHMODEL( other->s.modelindex ) )\n"
	"\t{\n"
	"\t\tG_AddEvent( ent, EV_GRENADE_BOUNCE, ( ent->s.effects & EF_STRONG_WEAPON ) ? FIRE_MODE_STRONG : FIRE_MODE_WEAK, true );\n"
	"\t\treturn;\n"
	"\t}\n",
	"\t// don't explode on doors and plats that take damage\n"
	"\t// racesow - remove check || ISBRUSHMODEL( other->s.modelindex )\n"
	"\tif( !other->takedamage )\n"
	"\t{\n"
	"\t\t// racesow - make grenades bounce twice\n"
	"\t\tif( ent->s.effects & EF_STRONG_WEAPON )\n"
	"\t\t\tent->health -= 1;\n"
	"\n"
	"\t\tif( !( ent->s.effects & EF_STRONG_WEAPON ) ||\n"
	"\t\t    ( ( VectorLength( ent->velocity ) && Q_rint( ent->health ) > 0 ) || ent->timeStamp + 350 > level.time ) )\n"
	"\t\t{\n"
	"\t\t\t// kill some velocity on each bounce\n"
	"\t\t\tfloat fric;\n"
	"\n"
	"\t\t\tfric = bound( 0, rs_grenade_friction->value, 2 ); // racesow\n"
	"\t\t\tVectorScale( ent->velocity, fric, ent->velocity );\n"
	"\t\t\tG_AddEvent( ent, EV_GRENADE_BOUNCE, ( ent->s.effects & EF_STRONG_WEAPON ) ? FIRE_MODE_STRONG : FIRE_MODE_WEAK, true );\n"
	"\t\t\treturn;\n"
	"\t\t}\n"
	"\t\t// !racesow\n"
	"\t}\n")

edit("game/g_weapon.cpp", "grenade uses rs_* cvars",
	"\tgrenade = W_Fire_TossProjectile( self, start, angles, speed, damage, minKnockback, maxKnockback, stun, minDamage, radius, timeout, timeDelta );\n",
	"\tgrenade = W_Fire_TossProjectile( self, start, angles,\n"
	"\t\trs_grenade_speed->integer, damage,\n"
	"\t\trs_grenade_minKnockback->integer,\n"
	"\t\trs_grenade_maxKnockback->integer,\n"
	"\t\tstun, minDamage, rs_grenade_splash->integer,\n"
	"\t\trs_grenade_timeout->integer, timeDelta ); // racesow\n")

edit("game/g_weapon.cpp", "grenade gravity",
	"\tgrenade->classname = \"grenade\";\n",
	"\tgrenade->classname = \"grenade\";\n"
	"\tgrenade->gravity = rs_grenade_gravity->value; // racesow\n")

edit("game/g_weapon.cpp", "strong grenade bounce count",
	"\t\tgrenade->s.modelindex = trap_ModelIndex( PATH_GRENADE_STRONG_MODEL );\n"
	"\t\tgrenade->s.effects |= EF_STRONG_WEAPON;\n",
	"\t\tgrenade->s.modelindex = trap_ModelIndex( PATH_GRENADE_STRONG_MODEL );\n"
	"\t\tgrenade->s.effects |= EF_STRONG_WEAPON;\n"
	"\t\tgrenade->health = 2; // racesow - bounce count\n")

edit("game/g_weapon.cpp", "rocket explosion event ownerNum",
	"\t\tevent->s.weapon = ( ( ent->projectileInfo.radius * 1/8 ) > 255 ) ? 255 : ( ent->projectileInfo.radius * 1/8 );\n"
	"\t}\n",
	"\t\tevent->s.weapon = ( ( ent->projectileInfo.radius * 1/8 ) > 255 ) ? 255 : ( ent->projectileInfo.radius * 1/8 );\n"
	"\t\tevent->s.ownerNum = ENTNUM( ent->r.owner ); // racesow\n"
	"\t}\n")

edit("game/g_weapon.cpp", "rocket uses rs_* cvars, slower under water",
	"\tedict_t\t*rocket;\n"
	"\n"
	"\tif( GS_Instagib() )\n"
	"\t\tdamage = 9999;\n"
	"\n"
	"\trocket = W_Fire_LinearProjectile( self, start, angles, speed, damage, minKnockback, maxKnockback, stun, minDamage, radius, timeout, timeDelta );\n",
	"\tedict_t\t*rocket;\n"
	"\t// racesow - water rockets are slower\n"
	"\tint new_speed = self->waterlevel > 1 ?\n"
	"\t\trs_rocket_speed->integer * 0.5 :\n"
	"\t\trs_rocket_speed->integer;\n"
	"\t// !racesow\n"
	"\n"
	"\tif( GS_Instagib() )\n"
	"\t\tdamage = 9999;\n"
	"\n"
	"\trocket = W_Fire_LinearProjectile( self, start, angles, new_speed,\n"
	"\t\tdamage, rs_rocket_minKnockback->integer,\n"
	"\t\trs_rocket_maxKnockback->integer, stun, minDamage,\n"
	"\t\trs_rocket_splash->integer, timeout, timeDelta ); // racesow\n")

edit("game/g_weapon.cpp", "plasma explosion event ownerNum",
	"\tevent->s.weapon = radius & 127;\n",
	"\tevent->s.weapon = radius & 127;\n"
	"\tevent->s.ownerNum = ENTNUM( ent->r.owner ); // racesow\n")

edit("game/g_weapon.cpp", "plasma on SURF_NOIMPACT buttons",
	"\t\telse\n"
	"\t\t{\n"
	"\t\t\tVectorNormalize2( ent->velocity, dir );\n"
	"\t\t}\n"
	"\n"
	"\t\tG_Damage( other, ent, ent->r.owner, dir, ent->velocity, ent->s.origin, ent->projectileInfo.maxDamage, ent->projectileInfo.maxKnockback, ent->projectileInfo.stun, DAMAGE_KNOCKBACK_SOFT, ent->style );\n"
	"\t}\n",
	"\t\telse\n"
	"\t\t{\n"
	"\t\t\tVectorNormalize2( ent->velocity, dir );\n"
	"\t\t}\n"
	"\n"
	"\t\t// racesow - hack for plasma shooters which shoot on buttons\n"
	"\t\t// with SURF_NOIMPACT\n"
	"\t\tif( surfFlags & SURF_NOIMPACT )\n"
	"\t\t{\n"
	"\t\t\tG_Damage( other, ent, ent->r.owner, dir, ent->velocity, ent->s.origin, ent->projectileInfo.maxDamage, 0, 0, DAMAGE_NO_KNOCKBACK, ent->style );\n"
	"\t\t\tG_FreeEdict( ent );\n"
	"\t\t\treturn;\n"
	"\t\t}\n"
	"\t\telse\n"
	"\t\t{\n"
	"\t\t\tG_Damage( other, ent, ent->r.owner, dir, ent->velocity, ent->s.origin, ent->projectileInfo.maxDamage, ent->projectileInfo.maxKnockback, ent->projectileInfo.stun, DAMAGE_KNOCKBACK_SOFT, ent->style );\n"
	"\t\t}\n"
	"\t\t// !racesow\n"
	"\t}\n")

edit("game/g_weapon.cpp", "plasma uses rs_* cvars",
	"\tplasma = W_Fire_LinearProjectile( self, start, angles, speed, damage, minKnockback, maxKnockback, stun, minDamage, radius, timeout, timeDelta );\n",
	"\tplasma = W_Fire_LinearProjectile( self, start, angles,\n"
	"\t\trs_plasma_speed->integer, damage,\n"
	"\t\trs_plasma_minKnockback->integer,\n"
	"\t\trs_plasma_maxKnockback->integer, stun, minDamage,\n"
	"\t\trs_plasma_splash->integer, timeout, timeDelta ); // racesow\n")

edit("game/g_weapon.cpp", "bolt direct-hit event ownerNum",
	"\t\tevent = G_SpawnEvent( EV_BOLT_EXPLOSION, DirToByte( invdir ), self->s.origin );\n"
	"\t\tevent->s.firemode = FIRE_MODE_WEAK;\n",
	"\t\tevent = G_SpawnEvent( EV_BOLT_EXPLOSION, DirToByte( invdir ), self->s.origin );\n"
	"\t\tevent->s.firemode = FIRE_MODE_WEAK;\n"
	"\t\tevent->s.ownerNum = ENTNUM( self->r.owner ); // racesow\n")

edit("game/g_weapon.cpp", "bolt wall-hit event ownerNum",
	"\t\tevent = G_SpawnEvent( EV_BOLT_EXPLOSION, DirToByte( plane ? plane->normal : NULL ), self->s.origin );\n"
	"\t\tevent->s.firemode = FIRE_MODE_WEAK;\n",
	"\t\tevent = G_SpawnEvent( EV_BOLT_EXPLOSION, DirToByte( plane ? plane->normal : NULL ), self->s.origin );\n"
	"\t\tevent->s.firemode = FIRE_MODE_WEAK;\n"
	"\t\tevent->s.ownerNum = ENTNUM( self->r.owner ); // racesow\n")

# Both electrobolt fire paths (combined + full-instant) share this text.
edit("game/g_weapon.cpp", "electrobolt stops at shootable buttons",
	"\t\t\tG_Damage( hit, self, self, dir, dir, tr.endpos, damage, knockback, stun, dmgflags, mod );\n"
	"\t\t\t\n"
	"\t\t\t// spawn a impact event on each damaged ent\n",
	"\t\t\tG_Damage( hit, self, self, dir, dir, tr.endpos, damage, knockback, stun, dmgflags, mod );\n"
	"\n"
	"\t\t\t// racesow - hit check here for shootable buttons\n"
	"\t\t\tif( hit->movetype == MOVETYPE_NONE || hit->movetype == MOVETYPE_PUSH )\n"
	"\t\t\t\tbreak;\n"
	"\t\t\t// !racesow\n"
	"\t\t\t\n"
	"\t\t\t// spawn a impact event on each damaged ent\n",
	count=2)

# --- p_weapon.cpp --------------------------------------------------------------
edit("game/p_weapon.cpp", "weapon pickup raises PSEV_PICKUP",
	"\tother->r.client->ps.inventory[item->tag]++;\n",
	"\tother->r.client->ps.inventory[item->tag]++;\n"
	"\tG_AddPlayerStateEvent( other->r.client, PSEV_PICKUP, ( item->flags & IT_WEAPON ? item->tag : 0 ) ); // racesow - trigger autoswitch\n")

edit("game/p_weapon.cpp", "rs_plasma_hack toggles the plasma backtrace",
	"\tif( projectile->s.type == ET_PLASMA )\n"
	"\t\tW_Plasma_Backtrace( projectile, plasma_hack_start );\n",
	"\tif( projectile->s.type == ET_PLASMA && rs_plasma_hack->integer ) // racesow\n"
	"\t\tW_Plasma_Backtrace( projectile, plasma_hack_start );\n")

edit("game/p_weapon.cpp", "prestep local",
	"\tint ucmdSeed;\n",
	"\tint ucmdSeed;\n"
	"\tfloat prestep; // racesow\n")

edit("game/p_weapon.cpp", "prestep default",
	"\tVectorAdd( ent->s.origin, viewoffset, origin );\n",
	"\tVectorAdd( ent->s.origin, viewoffset, origin );\n"
	"\tprestep = g_projectile_prestep->value; // racesow\n")

edit("game/p_weapon.cpp", "per-weapon race prestep",
	"\t\tprojectile = G_Fire_Grenade( origin, angles, firedef, ent, ucmdSeed );\n"
	"\t\tbreak;\n"
	"\n"
	"\tcase WEAP_ROCKETLAUNCHER:\n"
	"\t\tprojectile = G_Fire_Rocket( origin, angles, firedef, ent, ucmdSeed );\n"
	"\t\tbreak;\n"
	"\tcase WEAP_PLASMAGUN:\n"
	"\t\tprojectile = G_Fire_Plasma( origin, angles, firedef, ent, ucmdSeed );\n"
	"\t\tbreak;\n",
	"\t\tprojectile = G_Fire_Grenade( origin, angles, firedef, ent, ucmdSeed );\n"
	"\t\t// racesow - racesow 0.42 had grenade prestep 24\n"
	"\t\tif( GS_RaceGametype() )\n"
	"\t\t\tprestep = rs_grenade_prestep->integer;\n"
	"\t\t// !racesow\n"
	"\t\tbreak;\n"
	"\n"
	"\tcase WEAP_ROCKETLAUNCHER:\n"
	"\t\tprojectile = G_Fire_Rocket( origin, angles, firedef, ent, ucmdSeed );\n"
	"\t\t// racesow - racesow 0.42 had rocket prestep 0\n"
	"\t\tif( GS_RaceGametype() )\n"
	"\t\t\tprestep = rs_rocket_prestep->integer;\n"
	"\t\t// !racesow\n"
	"\t\tbreak;\n"
	"\tcase WEAP_PLASMAGUN:\n"
	"\t\tprojectile = G_Fire_Plasma( origin, angles, firedef, ent, ucmdSeed );\n"
	"\t\t// racesow - racesow 0.42 had plasma prestep 32\n"
	"\t\tif( GS_RaceGametype() )\n"
	"\t\t\tprestep = rs_plasma_prestep->integer;\n"
	"\t\t// !racesow\n"
	"\t\tbreak;\n")

edit("game/p_weapon.cpp", "use race prestep; rs_rocket_antilag; plasma antilag hack",
	"\t\t\tG_ProjectileDistancePrestep( projectile, g_projectile_prestep->value );\n"
	"\t}\n"
	"\n"
	"#ifdef NO_ROCKET_ANTILAG\n"
	"\t// hack for disabling antilag on rockets\n"
	"\tif( projectile && projectile->s.type == ET_ROCKET )\n",
	"\t\t\tG_ProjectileDistancePrestep( projectile, prestep ); // racesow - use our prestep\n"
	"\t}\n"
	"\n"
	"\t// racesow - enable no_antilag skipping if rs_rocket_antilag is 1\n"
	"\tif( GS_RaceGametype() && rs_rocket_antilag->integer && projectile && projectile->s.type == ET_ROCKET )\n"
	"\t\treturn;\n"
	"\t// !racesow\n"
	"\n"
	"#ifdef NO_ROCKET_ANTILAG\n"
	"\t// hack for disabling antilag on rockets\n"
	"\tif( projectile && ( projectile->s.type == ET_ROCKET || projectile->s.type == ET_PLASMA ) ) // racesow - disable plasma too\n")


# --- gs_weapondefs.c: rocket launcher timings ----------------------------------
def patch_rocket_defs(src):
	start = src.find('\t\t"Rocket Launcher",\n')
	end = src.find('\t\t"Lasergun",\n', start)
	if start < 0 or end < 0 or src.count('\t\t"Rocket Launcher",\n') != 1:
		sys.exit("FATAL: Rocket Launcher weapondef block not found exactly once in gameshared/gs_weapondefs.c")
	block = src[start:end]
	pairs = [
		("\t\t\t950,\t\t\t\t\t\t\t// reload frametime\n",
		 "\t\t\t850,\t\t\t\t\t\t\t// reload frametime - racesow - basewsw had (0.5: 950, 0.6: 925, 1.0: 850, 1.1: 900)\n"),
		("\t\t\t10000,\t\t\t\t\t\t\t// projectile timeout\n",
		 "\t\t\t100000,\t\t\t\t\t\t\t// projectile timeout - racesow - basewsw had (0.6: 10000)\n"),
	]
	for old, new in pairs:
		n = block.count(old)
		if n != 2:
			sys.exit("FATAL: Rocket Launcher %r found %d times (expected 2: strong + weak)" % (old.strip(), n))
		block = block.replace(old, new)
	print("patched gameshared/gs_weapondefs.c: rocket launcher reload 850 ms, timeout 100 s")
	return src[:start] + block + src[end:]


def main():
	files = {}
	for path, what, old, new, count in EDITS:
		if path not in files:
			with open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
				files[path] = f.read()
		n = files[path].count(old)
		if n != count:
			sys.exit("FATAL: %s anchor found %d times (expected %d) in %s" % (what, n, count, path))
		files[path] = files[path].replace(old, new)
		print("patched %s: %s" % (path, what))

	path = "gameshared/gs_weapondefs.c"
	with open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
		files[path] = patch_rocket_defs(f.read())

	for path, src in files.items():
		with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
			f.write(src)


if __name__ == "__main__":
	main()
