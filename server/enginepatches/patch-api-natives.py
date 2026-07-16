#!/usr/bin/env python3
"""Register the RS_ApiReportRace AngelScript native and link libcurl.

Companion to g_rs_api.cpp (copied into source/game/ by the Dockerfile; the
game CMakeLists globs *.cpp so it compiles automatically). This script wires
it up:

  1. g_ascript.cpp — add the asFunc wrapper and the asGlobFuncs table entry,
     next to the other RS_* racesow natives.
  2. game/CMakeLists.txt — link curl + pthread into the game module.

Run from the qfusion source/ directory. Exits non-zero (failing the image
build) if any anchor is not found exactly once.
"""
import sys

def patch(path, old, new, what):
    # Explicit utf-8: the 18.04 build container runs a POSIX (ASCII) locale,
    # where locale-default open() dies on any non-ASCII byte in either the
    # sources or the injected text.
    src = open(path, encoding="utf-8", errors="surrogateescape").read()
    if src.count(old) != 1:
        sys.exit("FATAL: %s anchor not found exactly once in %s" % (what, path))
    open(path, "w", encoding="utf-8", errors="surrogateescape").write(src.replace(old, new))
    print("patched:", what)

# --- 1a. wrapper functions, inserted just before the global function table ---
ANCHOR_TABLE = "static const asglobfuncs_t asGlobFuncs[] =\n"
WRAPPER = (
    "// racesow-docker: direct HTTP reporting of race finishes to the stats API\n"
    "// (implementation in g_rs_api.cpp; queued + sent on a background thread)\n"
    "void RS_ApiReportRace( const char *url, const char *token, const char *version,\n"
    "\tconst char *mapname, const char *player, const char *login,\n"
    "\tint timeMs, int attemptsSinceLast, const char *cpsCsv );\n"
    "// racesow-docker: finish-less attempt flush (disconnect / map end)\n"
    "void RS_ApiReportAttempts( const char *url, const char *token, const char *version,\n"
    "\tconst char *mapname, const char *player, const char *login, int count );\n"
    "// racesow-docker: live top-scores fetch - GETs the central\n"
    "// /api/game/topscores payload (byte-format identical to a topscores\n"
    "// file) and swaps it into the map's local file; the gametype polls\n"
    "// RS_ApiPollTop and re-reads the file through its normal loader.\n"
    "void RS_ApiFetchTop( const char *url, const char *token, const char *mapname );\n"
    "int RS_ApiPollTop( void );\n"
    "\n"
    "static void asFunc_RS_ApiReportRace( asstring_t *url, asstring_t *token, asstring_t *version,\n"
    "\tasstring_t *mapname, asstring_t *player, asstring_t *login, int timeMs, int attempts, asstring_t *cps )\n"
    "{\n"
    "\tif( !url || !url->buffer || !mapname || !mapname->buffer || !player || !player->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiReportRace( url->buffer,\n"
    "\t\ttoken && token->buffer ? token->buffer : \"\",\n"
    "\t\tversion && version->buffer ? version->buffer : \"\",\n"
    "\t\tmapname->buffer, player->buffer,\n"
    "\t\tlogin && login->buffer ? login->buffer : \"\",\n"
    "\t\ttimeMs, attempts,\n"
    "\t\tcps && cps->buffer ? cps->buffer : \"\" );\n"
    "}\n"
    "\n"
    "static void asFunc_RS_ApiReportAttempts( asstring_t *url, asstring_t *token, asstring_t *version,\n"
    "\tasstring_t *mapname, asstring_t *player, asstring_t *login, int count )\n"
    "{\n"
    "\tif( !url || !url->buffer || !mapname || !mapname->buffer || !player || !player->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiReportAttempts( url->buffer,\n"
    "\t\ttoken && token->buffer ? token->buffer : \"\",\n"
    "\t\tversion && version->buffer ? version->buffer : \"\",\n"
    "\t\tmapname->buffer, player->buffer,\n"
    "\t\tlogin && login->buffer ? login->buffer : \"\",\n"
    "\t\tcount );\n"
    "}\n"
    "\n"
    "static void asFunc_RS_ApiFetchTop( asstring_t *url, asstring_t *token, asstring_t *mapname )\n"
    "{\n"
    "\tif( !url || !url->buffer || !mapname || !mapname->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiFetchTop( url->buffer,\n"
    "\t\ttoken && token->buffer ? token->buffer : \"\",\n"
    "\t\tmapname->buffer );\n"
    "}\n"
    "\n"
    "static int asFunc_RS_ApiPollTop( void )\n"
    "{\n"
    "\treturn RS_ApiPollTop();\n"
    "}\n"
    "\n"
) + ANCHOR_TABLE

patch("game/g_ascript.cpp", ANCHOR_TABLE, WRAPPER, "asFunc wrapper")

# --- 1b. table entry, right after the existing RS_* natives -----------------
ANCHOR_ENTRY = "\t{ \"bool RS_ResetPjState( int playerNum )\", asFUNCTION(asFunc_RS_ResetPjState), NULL },\n"
ENTRY = ANCHOR_ENTRY + (
    "\t{ \"void RS_ApiReportRace( const String &in url, const String &in token, "
    "const String &in version, const String &in map, const String &in player, "
    "const String &in login, int timeMs, int attempts, const String &in checkpoints )\", "
    "asFUNCTION(asFunc_RS_ApiReportRace), NULL },\n"
    "\t{ \"void RS_ApiReportAttempts( const String &in url, const String &in token, "
    "const String &in version, const String &in map, const String &in player, "
    "const String &in login, int count )\", asFUNCTION(asFunc_RS_ApiReportAttempts), NULL },\n"
    "\t{ \"void RS_ApiFetchTop( const String &in url, const String &in token, "
    "const String &in map )\", asFUNCTION(asFunc_RS_ApiFetchTop), NULL },\n"
    "\t{ \"int RS_ApiPollTop()\", asFUNCTION(asFunc_RS_ApiPollTop), NULL },\n"
)

patch("game/g_ascript.cpp", ANCHOR_ENTRY, ENTRY, "asGlobFuncs entry")

# --- 1c. replay feature: WR demo pointer + ghost upload/fetch/replay ----------
# Added for the in-browser + in-game replay feature. Wrappers/entries inserted
# the same way as above; anchors are re-emitted so they stay unique for the
# mirror patcher that runs after. C uses spaces (indentation is irrelevant to
# the compiler); the AngelScript decls survive stripping as string literals, so
# the Dockerfile asserts on "RS_ApiReportWrDemo" / "RS_ApiFetchGhost".
GHOST_WRAPPERS = r'''// racesow-docker: WR demo pointer + ghost trajectory upload/fetch/replay
// (implementation in g_rs_api.cpp; queued + sent/parsed on the worker thread)
void RS_ApiReportWrDemo( const char *url, const char *token, const char *version,
    const char *mapname, const char *player, const char *login, int timeMs, const char *demoPath );
void RS_GhostBegin( void );
void RS_GhostFrame( int x, int y, int z, int pitch, int yaw, int roll, int vx, int vy, int vz, int keys );
void RS_GhostEnd( const char *url, const char *token, const char *version,
    const char *mapname, const char *player, const char *login, int timeMs, int hz, const char *cpsCsv );
void RS_ApiFetchGhost( const char *url, const char *token, const char *mapname );
int RS_ApiPollGhost( void );
int RS_GhostLoadedFrames( void );
int RS_GhostLoadedHz( void );
int RS_GhostLoadedTime( void );
const char *RS_GhostLoadedName( void );
const char *RS_GhostLoadedCps( void );
const char *RS_GhostFrameAt( int i );

static void asFunc_RS_ApiReportWrDemo( asstring_t *url, asstring_t *token, asstring_t *version,
    asstring_t *mapname, asstring_t *player, asstring_t *login, int timeMs, asstring_t *demo )
{
    if( !url || !url->buffer || !mapname || !mapname->buffer || !player || !player->buffer || !demo || !demo->buffer )
        return;
    RS_ApiReportWrDemo( url->buffer,
        token && token->buffer ? token->buffer : "",
        version && version->buffer ? version->buffer : "",
        mapname->buffer, player->buffer,
        login && login->buffer ? login->buffer : "",
        timeMs, demo->buffer );
}

static void asFunc_RS_GhostBegin( void ) { RS_GhostBegin(); }

static void asFunc_RS_GhostFrame( int x, int y, int z, int pitch, int yaw, int roll, int vx, int vy, int vz, int keys )
{
    RS_GhostFrame( x, y, z, pitch, yaw, roll, vx, vy, vz, keys );
}

static void asFunc_RS_GhostEnd( asstring_t *url, asstring_t *token, asstring_t *version,
    asstring_t *mapname, asstring_t *player, asstring_t *login, int timeMs, int hz, asstring_t *cps )
{
    if( !url || !url->buffer || !mapname || !mapname->buffer || !player || !player->buffer )
        return;
    RS_GhostEnd( url->buffer,
        token && token->buffer ? token->buffer : "",
        version && version->buffer ? version->buffer : "",
        mapname->buffer, player->buffer,
        login && login->buffer ? login->buffer : "",
        timeMs, hz, cps && cps->buffer ? cps->buffer : "" );
}

static void asFunc_RS_ApiFetchGhost( asstring_t *url, asstring_t *token, asstring_t *mapname )
{
    if( !url || !url->buffer || !mapname || !mapname->buffer )
        return;
    RS_ApiFetchGhost( url->buffer, token && token->buffer ? token->buffer : "", mapname->buffer );
}

static int asFunc_RS_ApiPollGhost( void ) { return RS_ApiPollGhost(); }
static int asFunc_RS_GhostLoadedFrames( void ) { return RS_GhostLoadedFrames(); }
static int asFunc_RS_GhostLoadedHz( void ) { return RS_GhostLoadedHz(); }
static int asFunc_RS_GhostLoadedTime( void ) { return RS_GhostLoadedTime(); }

static asstring_t *asFunc_RS_GhostLoadedName( void )
{
    const char *s = RS_GhostLoadedName();
    return angelExport->asStringFactoryBuffer( s, strlen( s ) );
}
static asstring_t *asFunc_RS_GhostLoadedCps( void )
{
    const char *s = RS_GhostLoadedCps();
    return angelExport->asStringFactoryBuffer( s, strlen( s ) );
}
static asstring_t *asFunc_RS_GhostFrameAt( int i )
{
    const char *s = RS_GhostFrameAt( i );
    return angelExport->asStringFactoryBuffer( s, strlen( s ) );
}

'''
patch("game/g_ascript.cpp", ANCHOR_TABLE, GHOST_WRAPPERS + ANCHOR_TABLE, "asFunc ghost wrappers")

GHOST_ENTRIES = ANCHOR_ENTRY + (
    "\t{ \"void RS_ApiReportWrDemo( const String &in url, const String &in token, "
    "const String &in version, const String &in map, const String &in player, "
    "const String &in login, int timeMs, const String &in demo )\", "
    "asFUNCTION(asFunc_RS_ApiReportWrDemo), NULL },\n"
    "\t{ \"void RS_GhostBegin()\", asFUNCTION(asFunc_RS_GhostBegin), NULL },\n"
    "\t{ \"void RS_GhostFrame( int x, int y, int z, int pitch, int yaw, int roll, "
    "int vx, int vy, int vz, int keys )\", asFUNCTION(asFunc_RS_GhostFrame), NULL },\n"
    "\t{ \"void RS_GhostEnd( const String &in url, const String &in token, "
    "const String &in version, const String &in map, const String &in player, "
    "const String &in login, int timeMs, int hz, const String &in cps )\", "
    "asFUNCTION(asFunc_RS_GhostEnd), NULL },\n"
    "\t{ \"void RS_ApiFetchGhost( const String &in url, const String &in token, "
    "const String &in map )\", asFUNCTION(asFunc_RS_ApiFetchGhost), NULL },\n"
    "\t{ \"int RS_ApiPollGhost()\", asFUNCTION(asFunc_RS_ApiPollGhost), NULL },\n"
    "\t{ \"int RS_GhostLoadedFrames()\", asFUNCTION(asFunc_RS_GhostLoadedFrames), NULL },\n"
    "\t{ \"int RS_GhostLoadedHz()\", asFUNCTION(asFunc_RS_GhostLoadedHz), NULL },\n"
    "\t{ \"int RS_GhostLoadedTime()\", asFUNCTION(asFunc_RS_GhostLoadedTime), NULL },\n"
    "\t{ \"const String @RS_GhostLoadedName()\", asFUNCTION(asFunc_RS_GhostLoadedName), NULL },\n"
    "\t{ \"const String @RS_GhostLoadedCps()\", asFUNCTION(asFunc_RS_GhostLoadedCps), NULL },\n"
    "\t{ \"const String @RS_GhostFrameAt( int i )\", asFUNCTION(asFunc_RS_GhostFrameAt), NULL },\n"
)
patch("game/g_ascript.cpp", ANCHOR_ENTRY, GHOST_ENTRIES, "asGlobFuncs ghost entries")

# --- 1e. in-game /flag: report the current map for review --------------------
# Adds the RS_ApiFlag native (implementation in g_rs_api.cpp). Wrapper/entry
# inserted the same way as above; the anchors are re-emitted so they stay unique
# for any later patcher. The Dockerfile asserts on "asFunc_RS_ApiFlag".
FLAG_WRAPPER = (
    "// racesow-docker: in-game /flag - report the current map for review\n"
    "// (implementation in g_rs_api.cpp; queued + POSTed on the worker thread)\n"
    "void RS_ApiFlag( const char *url, const char *token, const char *mapname,\n"
    "\tconst char *reason, const char *player, const char *login );\n"
    "\n"
    "static void asFunc_RS_ApiFlag( asstring_t *url, asstring_t *token, asstring_t *mapname,\n"
    "\tasstring_t *reason, asstring_t *player, asstring_t *login )\n"
    "{\n"
    "\tif( !url || !url->buffer || !mapname || !mapname->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiFlag( url->buffer,\n"
    "\t\ttoken && token->buffer ? token->buffer : \"\",\n"
    "\t\tmapname->buffer,\n"
    "\t\treason && reason->buffer ? reason->buffer : \"\",\n"
    "\t\tplayer && player->buffer ? player->buffer : \"\",\n"
    "\t\tlogin && login->buffer ? login->buffer : \"\" );\n"
    "}\n"
    "\n"
) + ANCHOR_TABLE
patch("game/g_ascript.cpp", ANCHOR_TABLE, FLAG_WRAPPER, "asFunc flag wrapper")

FLAG_ENTRY = ANCHOR_ENTRY + (
    "\t{ \"void RS_ApiFlag( const String &in url, const String &in token, "
    "const String &in map, const String &in reason, const String &in player, "
    "const String &in login )\", asFUNCTION(asFunc_RS_ApiFlag), NULL },\n"
)
patch("game/g_ascript.cpp", ANCHOR_ENTRY, FLAG_ENTRY, "asGlobFuncs flag entry")

# --- 2. link libcurl + pthread into the game module --------------------------
ANCHOR_LINK = "target_link_libraries(game PRIVATE ${ANGELSCRIPT_LIBRARY})"
LINK = "target_link_libraries(game PRIVATE ${ANGELSCRIPT_LIBRARY} curl pthread)"

patch("game/CMakeLists.txt", ANCHOR_LINK, LINK, "game curl linkage")

print("api natives patch applied")
