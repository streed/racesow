#!/usr/bin/env python3
"""Register the RS_Mirror* AngelScript natives and hook chat for the mesh.

Companion to g_rs_mirror.cpp (copied into source/game/ by the Dockerfile; the
game CMakeLists globs *.cpp so it compiles automatically). This script wires
it up:

  1. g_ascript.cpp - add the asFunc wrappers and asGlobFuncs table entries,
     next to the other RS_* racesow natives.
  2. g_cmds.cpp - call RS_MirrorLocalChat from Cmd_Say_f so locally-originated
     public chat is mirrored to peer servers. Mirrored chat is printed by the
     gametype via G_PrintMsg and never re-enters Cmd_Say_f, so the mesh's
     hop-limit-1 needs no origin tagging to prevent loops.

No CMakeLists change: the mirror needs only libc sockets and pthread, which
patch-api-natives.py already links. Run from the qfusion source/ directory,
AFTER patch-api-natives.py (both anchors stay unique either way, but the
Dockerfile keeps that order). Exits non-zero (failing the image build) if any
anchor is not found exactly once.
"""
import sys

# Every insertion below re-emits its own anchor, so after a successful run the
# anchors still occur exactly once and a naive re-run would duplicate every
# insertion (silently doubling the chat hook, and only failing later in the
# cmake step on redefined statics). Fail fast if the patch is already present.
for _p, _marker in [("game/g_ascript.cpp", "asFunc_RS_MirrorConfigure"),
                    ("game/g_cmds.cpp", "RS_MirrorLocalChat"),
                    ("game/g_gameteams.cpp", "RS_MirrorLocalChat")]:
    if _marker in open(_p, encoding="utf-8").read():
        sys.exit("FATAL: mirror natives patch already applied (%s in %s)" % (_marker, _p))

def patch(path, old, new, what):
    # explicit encoding: the build container runs a POSIX locale, where the
    # default codec is ASCII and any non-ASCII byte would abort the build
    src = open(path, encoding="utf-8").read()
    if src.count(old) != 1:
        sys.exit("FATAL: %s anchor not found exactly once in %s" % (what, path))
    open(path, "w", encoding="utf-8").write(src.replace(old, new))
    print("patched:", what)

# --- 1a. wrapper functions, inserted just before the global function table --
ANCHOR_TABLE = "static const asglobfuncs_t asGlobFuncs[] =\n"

STRING_GETTERS = ["PlayerName", "PlayerServer", "PlayerMap", "PlayerState", "PeerTag", "PeerMap"]
EVENT_GETTERS = ["EventServer", "EventName", "EventText"]

wrapper = (
    "// racesow-docker: cross-server player mirroring over a UDP mesh\n"
    "// (implementation in g_rs_mirror.cpp; all socket I/O runs on a background\n"
    "// thread - these wrappers only swap queues/snapshots under a brief mutex)\n"
    "void RS_MirrorConfigure( const char *tag, const char *secret, int port, const char *peers, const char *map );\n"
    "void RS_MirrorBegin( void );\n"
    "void RS_MirrorPlayer( const char *name, const float *origin, const float *angles, const float *velocity, int flags, int score );\n"
    "void RS_MirrorEnd( void );\n"
    "void RS_MirrorEvent( const char *kind, const char *name, const char *text );\n"
    "int RS_MirrorRefresh( void );\n"
    "int RS_MirrorNextEvent( void );\n"
    "// mirror bots (real fake-client slots; implementation in g_rs_mirrorbots.cpp)\n"
    "int RS_MirrorBotAdd( const char *name, const char *clan, int r, int g, int b, bool spectator );\n"
    "void RS_MirrorBotUpdate( int playerNum, float ox, float oy, float oz,"
    " float pitch, float yaw, float roll, float vx, float vy, float vz, int flags );\n"
    "void RS_MirrorBotRemove( int playerNum );\n"
    "bool RS_MirrorBotIs( int playerNum );\n"
    "// racesow-docker: per-client WR-ghost visibility (g_rs_mirrorbots.cpp); a\n"
    "// viewer who runs \"wrghost off\" has the WR ghost culled from their snapshot\n"
    "void RS_SetHideWrGhost( int playerNum, bool hide );\n"
    "// mirror peer liveness (heard peers with their advertised map + silence age)\n"
    "int RS_MirrorPeerCount( void );\n"
    "int RS_MirrorPeerAge( int i );\n"
)
for g in STRING_GETTERS:
    wrapper += "const char *RS_Mirror%s( int i );\n" % g
for g in EVENT_GETTERS:
    wrapper += "const char *RS_Mirror%s( void );\n" % g

wrapper += (
    "\n"
    "static void asFunc_RS_MirrorConfigure( asstring_t *tag, asstring_t *secret, int port, asstring_t *peers, asstring_t *map )\n"
    "{\n"
    "\tRS_MirrorConfigure(\n"
    "\t\ttag && tag->buffer ? tag->buffer : \"\",\n"
    "\t\tsecret && secret->buffer ? secret->buffer : \"\",\n"
    "\t\tport,\n"
    "\t\tpeers && peers->buffer ? peers->buffer : \"\",\n"
    "\t\tmap && map->buffer ? map->buffer : \"\" );\n"
    "}\n"
    "\n"
    "static void asFunc_RS_MirrorBegin( void )\n"
    "{\n"
    "\tRS_MirrorBegin();\n"
    "}\n"
    "\n"
    "static void asFunc_RS_MirrorPlayer( asstring_t *name, asvec3_t *origin, asvec3_t *angles, asvec3_t *velocity, int flags, int score )\n"
    "{\n"
    "\tif( !name || !name->buffer || !origin || !angles || !velocity )\n"
    "\t\treturn;\n"
    "\tRS_MirrorPlayer( name->buffer, origin->v, angles->v, velocity->v, flags, score );\n"
    "}\n"
    "\n"
    "static void asFunc_RS_MirrorEnd( void )\n"
    "{\n"
    "\tRS_MirrorEnd();\n"
    "}\n"
    "\n"
    "static void asFunc_RS_MirrorEvent( asstring_t *kind, asstring_t *name, asstring_t *text )\n"
    "{\n"
    "\tif( !kind || !kind->buffer || !name || !name->buffer )\n"
    "\t\treturn;\n"
    "\tRS_MirrorEvent( kind->buffer, name->buffer, text && text->buffer ? text->buffer : \"\" );\n"
    "}\n"
    "\n"
    "static int asFunc_RS_MirrorRefresh( void )\n"
    "{\n"
    "\treturn RS_MirrorRefresh();\n"
    "}\n"
    "\n"
    "static int asFunc_RS_MirrorNextEvent( void )\n"
    "{\n"
    "\treturn RS_MirrorNextEvent();\n"
    "}\n"
    "\n"
    "static int asFunc_RS_MirrorBotAdd( asstring_t *name, asstring_t *clan, int r, int g, int b, bool spectator )\n"
    "{\n"
    "\treturn RS_MirrorBotAdd( name && name->buffer ? name->buffer : \"\",\n"
    "\t\tclan && clan->buffer ? clan->buffer : \"\", r, g, b, spectator );\n"
    "}\n"
    "\n"
    "static void asFunc_RS_MirrorBotUpdate( int playerNum, asvec3_t *origin, asvec3_t *angles, asvec3_t *velocity, int flags )\n"
    "{\n"
    "\tif( !origin || !angles || !velocity )\n"
    "\t\treturn;\n"
    "\tRS_MirrorBotUpdate( playerNum, origin->v[0], origin->v[1], origin->v[2],\n"
    "\t\tangles->v[0], angles->v[1], angles->v[2],\n"
    "\t\tvelocity->v[0], velocity->v[1], velocity->v[2], flags );\n"
    "}\n"
    "\n"
    "static void asFunc_RS_MirrorBotRemove( int playerNum )\n"
    "{\n"
    "\tRS_MirrorBotRemove( playerNum );\n"
    "}\n"
    "\n"
    "static bool asFunc_RS_MirrorBotIs( int playerNum )\n"
    "{\n"
    "\treturn RS_MirrorBotIs( playerNum );\n"
    "}\n"
    "\n"
    "static void asFunc_RS_SetHideWrGhost( int playerNum, bool hide )\n"
    "{\n"
    "\tRS_SetHideWrGhost( playerNum, hide );\n"
    "}\n"
    "\n"
    "static int asFunc_RS_MirrorPeerCount( void )\n"
    "{\n"
    "\treturn RS_MirrorPeerCount();\n"
    "}\n"
    "\n"
    "static int asFunc_RS_MirrorPeerAge( int i )\n"
    "{\n"
    "\treturn RS_MirrorPeerAge( i );\n"
    "}\n"
    "\n"
)
for g in STRING_GETTERS:
    wrapper += (
        "static asstring_t *asFunc_RS_Mirror%s( int i )\n"
        "{\n"
        "\tconst char *s = RS_Mirror%s( i );\n"
        "\treturn angelExport->asStringFactoryBuffer( s, strlen( s ) );\n"
        "}\n"
        "\n"
    ) % (g, g)
for g in EVENT_GETTERS:
    wrapper += (
        "static asstring_t *asFunc_RS_Mirror%s( void )\n"
        "{\n"
        "\tconst char *s = RS_Mirror%s();\n"
        "\treturn angelExport->asStringFactoryBuffer( s, strlen( s ) );\n"
        "}\n"
        "\n"
    ) % (g, g)

patch("game/g_ascript.cpp", ANCHOR_TABLE, wrapper + ANCHOR_TABLE, "asFunc mirror wrappers")

# --- 1b. table entries, right after the existing RS_* natives ---------------
ANCHOR_ENTRY = "\t{ \"bool RS_ResetPjState( int playerNum )\", asFUNCTION(asFunc_RS_ResetPjState), NULL },\n"
entries = ANCHOR_ENTRY
for decl, func in [
    ("void RS_MirrorConfigure( const String &in tag, const String &in secret, int port, "
     "const String &in peers, const String &in map )", "Configure"),
    ("void RS_MirrorBegin()", "Begin"),
    ("void RS_MirrorPlayer( const String &in name, const Vec3 &in origin, const Vec3 &in angles, "
     "const Vec3 &in velocity, int flags, int score )", "Player"),
    ("void RS_MirrorEnd()", "End"),
    ("void RS_MirrorEvent( const String &in kind, const String &in name, const String &in text )", "Event"),
    ("int RS_MirrorRefresh()", "Refresh"),
    ("const String @RS_MirrorPlayerName( int index )", "PlayerName"),
    ("const String @RS_MirrorPlayerServer( int index )", "PlayerServer"),
    ("const String @RS_MirrorPlayerMap( int index )", "PlayerMap"),
    ("const String @RS_MirrorPlayerState( int index )", "PlayerState"),
    ("int RS_MirrorNextEvent()", "NextEvent"),
    ("const String @RS_MirrorEventServer()", "EventServer"),
    ("const String @RS_MirrorEventName()", "EventName"),
    ("const String @RS_MirrorEventText()", "EventText"),
    ("int RS_MirrorBotAdd( const String &in name, const String &in clan, int r, int g, int b, bool spectator )", "BotAdd"),
    ("void RS_MirrorBotUpdate( int playerNum, const Vec3 &in origin, const Vec3 &in angles, "
     "const Vec3 &in velocity, int flags )", "BotUpdate"),
    ("void RS_MirrorBotRemove( int playerNum )", "BotRemove"),
    ("bool RS_MirrorBotIs( int playerNum )", "BotIs"),
    ("int RS_MirrorPeerCount()", "PeerCount"),
    ("const String @RS_MirrorPeerTag( int index )", "PeerTag"),
    ("const String @RS_MirrorPeerMap( int index )", "PeerMap"),
    ("int RS_MirrorPeerAge( int index )", "PeerAge"),
]:
    entries += "\t{ \"%s\", asFUNCTION(asFunc_RS_Mirror%s), NULL },\n" % (decl, func)

# Per-client WR-ghost visibility native (not a RS_Mirror* name, so registered
# explicitly rather than through the loop above).
entries += ("\t{ \"void RS_SetHideWrGhost( int playerNum, bool hide )\", "
            "asFUNCTION(asFunc_RS_SetHideWrGhost), NULL },\n")

patch("game/g_ascript.cpp", ANCHOR_ENTRY, entries, "asGlobFuncs mirror entries")

# --- 2a. chat hook forward declaration ---------------------------------------
ANCHOR_SAY = "void Cmd_Say_f( edict_t *ent, bool arg0, bool checkflood )\n{"
DECL = (
    "// racesow-docker: cross-server chat mirroring (g_rs_mirror.cpp)\n"
    "void RS_MirrorLocalChat( const char *name, const char *text );\n"
    "\n"
) + ANCHOR_SAY

patch("game/g_cmds.cpp", ANCHOR_SAY, DECL, "Cmd_Say_f forward decl")

# --- 2b. chat hook at the single public-chat funnel ---------------------------
ANCHOR_CHAT = "\tG_ChatMsg( NULL, ent, false, \"%s\", text );\n"
HOOK = (
    "\t// racesow-docker: mirror locally-originated public chat to peer servers.\n"
    "\t// Mirrored chat is printed by the gametype via G_PrintMsg and never\n"
    "\t// re-enters Cmd_Say_f, so hop-limit-1 needs no origin tagging.\n"
    "\tif( ent->r.client )\n"
    "\t\tRS_MirrorLocalChat( ent->r.client->netname, text );\n"
) + ANCHOR_CHAT

patch("game/g_cmds.cpp", ANCHOR_CHAT, HOOK, "Cmd_Say_f mirror hook")

# --- 3. mirror say_team as well (g_gameteams.cpp / G_Say_Team) ----------------
# On an individual gametype (race), an active player's say_team is redirected to
# Cmd_Say_f above and is already mirrored. The two remaining delivery paths in
# G_Say_Team - spectator team chat, and real team chat on a team-based gametype -
# are not, so hook both so say_team crosses the mesh like say. (No double-mirror:
# the redirect returns before reaching these.)
ANCHOR_TEAM_FN = "void G_Say_Team( edict_t *who, char *msg, bool checkflood )\n{"
DECL_TEAM = (
    "// racesow-docker: mirror team / spectator chat to peer servers too (see\n"
    "// patch-mirror-natives.py). Active players' say_team on an individual\n"
    "// gametype is redirected to Cmd_Say_f above and already mirrored.\n"
    "void RS_MirrorLocalChat( const char *name, const char *text );\n"
    "\n"
) + ANCHOR_TEAM_FN
patch("game/g_gameteams.cpp", ANCHOR_TEAM_FN, DECL_TEAM, "G_Say_Team forward decl")

# spectator team chat funnel
ANCHOR_SPEC = "\t\tG_ChatMsg( NULL, who, true, \"%s\", msg );\n"
HOOK_SPEC = (
    "\t\tif( who->r.client )\n"
    "\t\t\tRS_MirrorLocalChat( who->r.client->netname, msg );\n"
) + ANCHOR_SPEC
patch("game/g_gameteams.cpp", ANCHOR_SPEC, HOOK_SPEC, "G_Say_Team spectator hook")

# team-based delivery funnel (dead code on race; future-proof for team gametypes)
ANCHOR_TEAM = "\tG_ChatMsg( NULL, who, true, \"%s\", outmsg );\n"
HOOK_TEAM = (
    "\tif( who->r.client )\n"
    "\t\tRS_MirrorLocalChat( who->r.client->netname, outmsg );\n"
) + ANCHOR_TEAM
patch("game/g_gameteams.cpp", ANCHOR_TEAM, HOOK_TEAM, "G_Say_Team team hook")

print("mirror natives patch applied")
