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
    "\tint timeMs, int attemptsSinceLast, const char *cpsCsv,\n"
    "\tint wallJumps, int dashes, int prejumpFails, int restarts,\n"
    "\tint strafeQuality, int maxSpeed, int startSpeed, int distance, int strafes );\n"
    "// racesow-docker: finish-less attempt flush (disconnect / map end)\n"
    "void RS_ApiReportAttempts( const char *url, const char *token, const char *version,\n"
    "\tconst char *mapname, const char *player, const char *login, int count,\n"
    "\tint wallJumps, int dashes, int prejumpFails, int restarts,\n"
    "\tint distance, int strafes );\n"
    "// racesow-docker: live top-scores fetch - GETs the central\n"
    "// /api/game/topscores payload (byte-format identical to a topscores\n"
    "// file) and swaps it into the map's local file; the gametype polls\n"
    "// RS_ApiPollTop and re-reads the file through its normal loader.\n"
    "void RS_ApiFetchTop( const char *url, const char *token, const char *mapname );\n"
    "int RS_ApiPollTop( void );\n"
    "\n"
    "static void asFunc_RS_ApiReportRace( asstring_t *url, asstring_t *token, asstring_t *version,\n"
    "\tasstring_t *mapname, asstring_t *player, asstring_t *login, int timeMs, int attempts, asstring_t *cps,\n"
    "\tint wallJumps, int dashes, int prejumpFails, int restarts, int strafeQuality,\n"
    "\tint maxSpeed, int startSpeed, int distance, int strafes )\n"
    "{\n"
    "\tif( !url || !url->buffer || !mapname || !mapname->buffer || !player || !player->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiReportRace( url->buffer,\n"
    "\t\ttoken && token->buffer ? token->buffer : \"\",\n"
    "\t\tversion && version->buffer ? version->buffer : \"\",\n"
    "\t\tmapname->buffer, player->buffer,\n"
    "\t\tlogin && login->buffer ? login->buffer : \"\",\n"
    "\t\ttimeMs, attempts,\n"
    "\t\tcps && cps->buffer ? cps->buffer : \"\",\n"
    "\t\twallJumps, dashes, prejumpFails, restarts, strafeQuality,\n"
    "\t\tmaxSpeed, startSpeed, distance, strafes );\n"
    "}\n"
    "\n"
    "static void asFunc_RS_ApiReportAttempts( asstring_t *url, asstring_t *token, asstring_t *version,\n"
    "\tasstring_t *mapname, asstring_t *player, asstring_t *login, int count,\n"
    "\tint wallJumps, int dashes, int prejumpFails, int restarts, int distance, int strafes )\n"
    "{\n"
    "\tif( !url || !url->buffer || !mapname || !mapname->buffer || !player || !player->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiReportAttempts( url->buffer,\n"
    "\t\ttoken && token->buffer ? token->buffer : \"\",\n"
    "\t\tversion && version->buffer ? version->buffer : \"\",\n"
    "\t\tmapname->buffer, player->buffer,\n"
    "\t\tlogin && login->buffer ? login->buffer : \"\",\n"
    "\t\tcount,\n"
    "\t\twallJumps, dashes, prejumpFails, restarts, distance, strafes );\n"
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
    "const String &in login, int timeMs, int attempts, const String &in checkpoints, "
    "int wallJumps, int dashes, int prejumpFails, int restarts, int strafeQuality, "
    "int maxSpeed, int startSpeed, int distance, int strafes )\", "
    "asFUNCTION(asFunc_RS_ApiReportRace), NULL },\n"
    "\t{ \"void RS_ApiReportAttempts( const String &in url, const String &in token, "
    "const String &in version, const String &in map, const String &in player, "
    "const String &in login, int count, "
    "int wallJumps, int dashes, int prejumpFails, int restarts, int distance, int strafes )\", "
    "asFUNCTION(asFunc_RS_ApiReportAttempts), NULL },\n"
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

# --- 1f. live map blocklist: pull the central blocked-maps list --------------
# Adds RS_ApiFetchBlocked / RS_ApiPollBlocked / RS_BlockedListText (impl in
# g_rs_api.cpp). The gametype polls the list every ~30s so a map blocked in the
# web admin drops out of the vote pool live, without a server restart. Anchors
# re-emitted so they stay unique. The Dockerfile asserts on
# "asFunc_RS_ApiFetchBlocked".
BLOCKED_WRAPPER = (
    "// racesow-docker: live map blocklist - GETs the central\n"
    "// /api/game/blocked-maps text (one lowercased map name per line) into\n"
    "// memory; the gametype polls RS_ApiPollBlocked and reads RS_BlockedListText\n"
    "// so a map blocked in the web admin leaves the vote pool without a restart.\n"
    "void RS_ApiFetchBlocked( const char *url, const char *token );\n"
    "int RS_ApiPollBlocked( void );\n"
    "const char *RS_BlockedListText( void );\n"
    "\n"
    "static void asFunc_RS_ApiFetchBlocked( asstring_t *url, asstring_t *token )\n"
    "{\n"
    "\tif( !url || !url->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiFetchBlocked( url->buffer, token && token->buffer ? token->buffer : \"\" );\n"
    "}\n"
    "\n"
    "static int asFunc_RS_ApiPollBlocked( void ) { return RS_ApiPollBlocked(); }\n"
    "\n"
    "static asstring_t *asFunc_RS_BlockedListText( void )\n"
    "{\n"
    "\tconst char *s = RS_BlockedListText();\n"
    "\treturn angelExport->asStringFactoryBuffer( s, strlen( s ) );\n"
    "}\n"
    "\n"
) + ANCHOR_TABLE
patch("game/g_ascript.cpp", ANCHOR_TABLE, BLOCKED_WRAPPER, "asFunc blocked wrapper")

BLOCKED_ENTRY = ANCHOR_ENTRY + (
    "\t{ \"void RS_ApiFetchBlocked( const String &in url, const String &in token )\", "
    "asFUNCTION(asFunc_RS_ApiFetchBlocked), NULL },\n"
    "\t{ \"int RS_ApiPollBlocked()\", asFUNCTION(asFunc_RS_ApiPollBlocked), NULL },\n"
    "\t{ \"const String @RS_BlockedListText()\", asFUNCTION(asFunc_RS_BlockedListText), NULL },\n"
)
patch("game/g_ascript.cpp", ANCHOR_ENTRY, BLOCKED_ENTRY, "asGlobFuncs blocked entry")

# --- 1g. live MOTD: pull the central message of the day -----------------------
# Adds RS_ApiFetchMotd / RS_ApiPollMotd / RS_MotdText (impl in g_rs_api.cpp).
# The gametype polls every ~60s (hrace/motd.as) and sets the engine's
# sv_MOTDString cvar, so an MOTD edited in the web admin shows to newly
# connecting players without a restart (the engine-side patch-motd-live.py
# makes SV_MOTD_Get_f re-read the cvar per request). Anchors re-emitted so they
# stay unique. The Dockerfile asserts on "asFunc_RS_ApiFetchMotd".
MOTD_WRAPPER = (
    "// racesow-docker: live message of the day - GETs the central\n"
    "// /api/game/motd text (an RSMOTD header line, then the message) into\n"
    "// memory; the gametype polls RS_ApiPollMotd and reads RS_MotdText, then\n"
    "// sets sv_MOTDString, so an MOTD edited in the web admin shows to newly\n"
    "// connecting players without a restart.\n"
    "void RS_ApiFetchMotd( const char *url, const char *token );\n"
    "int RS_ApiPollMotd( void );\n"
    "const char *RS_MotdText( void );\n"
    "\n"
    "static void asFunc_RS_ApiFetchMotd( asstring_t *url, asstring_t *token )\n"
    "{\n"
    "\tif( !url || !url->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiFetchMotd( url->buffer, token && token->buffer ? token->buffer : \"\" );\n"
    "}\n"
    "\n"
    "static int asFunc_RS_ApiPollMotd( void ) { return RS_ApiPollMotd(); }\n"
    "\n"
    "static asstring_t *asFunc_RS_MotdText( void )\n"
    "{\n"
    "\tconst char *s = RS_MotdText();\n"
    "\treturn angelExport->asStringFactoryBuffer( s, strlen( s ) );\n"
    "}\n"
    "\n"
) + ANCHOR_TABLE
patch("game/g_ascript.cpp", ANCHOR_TABLE, MOTD_WRAPPER, "asFunc motd wrapper")

MOTD_ENTRY = ANCHOR_ENTRY + (
    "\t{ \"void RS_ApiFetchMotd( const String &in url, const String &in token )\", "
    "asFUNCTION(asFunc_RS_ApiFetchMotd), NULL },\n"
    "\t{ \"int RS_ApiPollMotd()\", asFUNCTION(asFunc_RS_ApiPollMotd), NULL },\n"
    "\t{ \"const String @RS_MotdText()\", asFUNCTION(asFunc_RS_MotdText), NULL },\n"
)
patch("game/g_ascript.cpp", ANCHOR_ENTRY, MOTD_ENTRY, "asGlobFuncs motd entry")

# --- 1g2. rotating in-game announcements: pull the central message list -------
# Adds RS_ApiFetchAnnounce / RS_ApiPollAnnounce / RS_AnnounceText (impl in
# g_rs_api.cpp). The gametype polls every ~60s (hrace/announcement.as), splits
# the list on newlines and broadcasts one message per rotation interval, so a
# message edited in the web admin rotates in without a restart. Same shape as
# the MOTD native above. Anchors re-emitted so they stay unique. The Dockerfile
# asserts on "asFunc_RS_ApiFetchAnnounce".
ANNOUNCE_WRAPPER = (
    "// racesow-docker: rotating announcements - GETs the central\n"
    "// /api/game/announcements list (an RSANN header line, then one message\n"
    "// per line) into memory; the gametype polls RS_ApiPollAnnounce and reads\n"
    "// RS_AnnounceText, then broadcasts one message per rotation interval, so a\n"
    "// message edited in the web admin rotates in without a restart.\n"
    "void RS_ApiFetchAnnounce( const char *url, const char *token );\n"
    "int RS_ApiPollAnnounce( void );\n"
    "const char *RS_AnnounceText( void );\n"
    "\n"
    "static void asFunc_RS_ApiFetchAnnounce( asstring_t *url, asstring_t *token )\n"
    "{\n"
    "\tif( !url || !url->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiFetchAnnounce( url->buffer, token && token->buffer ? token->buffer : \"\" );\n"
    "}\n"
    "\n"
    "static int asFunc_RS_ApiPollAnnounce( void ) { return RS_ApiPollAnnounce(); }\n"
    "\n"
    "static asstring_t *asFunc_RS_AnnounceText( void )\n"
    "{\n"
    "\tconst char *s = RS_AnnounceText();\n"
    "\treturn angelExport->asStringFactoryBuffer( s, strlen( s ) );\n"
    "}\n"
    "\n"
) + ANCHOR_TABLE
patch("game/g_ascript.cpp", ANCHOR_TABLE, ANNOUNCE_WRAPPER, "asFunc announce wrapper")

ANNOUNCE_ENTRY = ANCHOR_ENTRY + (
    "\t{ \"void RS_ApiFetchAnnounce( const String &in url, const String &in token )\", "
    "asFUNCTION(asFunc_RS_ApiFetchAnnounce), NULL },\n"
    "\t{ \"int RS_ApiPollAnnounce()\", asFUNCTION(asFunc_RS_ApiPollAnnounce), NULL },\n"
    "\t{ \"const String @RS_AnnounceText()\", asFUNCTION(asFunc_RS_AnnounceText), NULL },\n"
)
patch("game/g_ascript.cpp", ANCHOR_ENTRY, ANNOUNCE_ENTRY, "asGlobFuncs announce entry")

# --- 1h. live per-map global ranks: pull every finisher's rank ---------------
# Adds RS_ApiFetchRanks / RS_ApiPollRanks / RS_RanksText (impl in g_rs_api.cpp).
# The gametype (hrace/ranks.as) polls this ~60s and applies each connected
# player's true global rank to the scoreboard "Pos" column, so a player ranked
# past the local top-50 board still sees their position. The fetch native takes
# a map name (like RS_ApiFetchTop) and returns text to the script (like the
# blocked/motd trio). Anchors re-emitted so they stay unique. The Dockerfile
# asserts on "asFunc_RS_ApiFetchRanks".
RANKS_WRAPPER = (
    "// racesow-docker: live per-map global ranks - GETs the central\n"
    "// /api/game/ranks text (a \"//ranks <total>\" header, then \"<rank> <name>\"\n"
    "// lines for EVERY finisher) into memory; the gametype polls RS_ApiPollRanks\n"
    "// and reads RS_RanksText, then shows each connected player's true rank in the\n"
    "// scoreboard - including players ranked past the local top-50 board.\n"
    "void RS_ApiFetchRanks( const char *url, const char *token, const char *mapname );\n"
    "int RS_ApiPollRanks( void );\n"
    "const char *RS_RanksText( void );\n"
    "\n"
    "static void asFunc_RS_ApiFetchRanks( asstring_t *url, asstring_t *token, asstring_t *mapname )\n"
    "{\n"
    "\tif( !url || !url->buffer || !mapname || !mapname->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiFetchRanks( url->buffer,\n"
    "\t\ttoken && token->buffer ? token->buffer : \"\",\n"
    "\t\tmapname->buffer );\n"
    "}\n"
    "\n"
    "static int asFunc_RS_ApiPollRanks( void ) { return RS_ApiPollRanks(); }\n"
    "\n"
    "static asstring_t *asFunc_RS_RanksText( void )\n"
    "{\n"
    "\tconst char *s = RS_RanksText();\n"
    "\treturn angelExport->asStringFactoryBuffer( s, strlen( s ) );\n"
    "}\n"
    "\n"
) + ANCHOR_TABLE
patch("game/g_ascript.cpp", ANCHOR_TABLE, RANKS_WRAPPER, "asFunc ranks wrapper")

RANKS_ENTRY = ANCHOR_ENTRY + (
    "\t{ \"void RS_ApiFetchRanks( const String &in url, const String &in token, "
    "const String &in map )\", asFUNCTION(asFunc_RS_ApiFetchRanks), NULL },\n"
    "\t{ \"int RS_ApiPollRanks()\", asFUNCTION(asFunc_RS_ApiPollRanks), NULL },\n"
    "\t{ \"const String @RS_RanksText()\", asFUNCTION(asFunc_RS_RanksText), NULL },\n"
)
patch("game/g_ascript.cpp", ANCHOR_ENTRY, RANKS_ENTRY, "asGlobFuncs ranks entry")

# --- 1i. per-map weapon inventory: pull the central map-weapons table ---------
# Adds RS_ApiFetchMapWeapons / RS_ApiPollMapWeapons / RS_MapWeaponsText (impl in
# g_rs_api.cpp). The gametype (hrace/mapweapons.as) polls this so `callvote
# randmap rl` / `randmap strafe` can filter the vote pool by what a map plays
# like. Same fetch/poll/text shape as the blocked-maps trio (url + token, no map
# arg). Anchors re-emitted so they stay unique. The Dockerfile asserts on
# "asFunc_RS_ApiFetchMapWeapons".
MAPWEAPONS_WRAPPER = (
    "// racesow-docker: per-map weapon inventory - GETs the central\n"
    "// /api/game/map-weapons text (one \"<map> code code ...\" line per map, a\n"
    "// bare name = strafe) into memory; the gametype polls RS_ApiPollMapWeapons\n"
    "// and reads RS_MapWeaponsText so randmap can filter the vote pool by weapon.\n"
    "void RS_ApiFetchMapWeapons( const char *url, const char *token );\n"
    "int RS_ApiPollMapWeapons( void );\n"
    "const char *RS_MapWeaponsText( void );\n"
    "\n"
    "static void asFunc_RS_ApiFetchMapWeapons( asstring_t *url, asstring_t *token )\n"
    "{\n"
    "\tif( !url || !url->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiFetchMapWeapons( url->buffer, token && token->buffer ? token->buffer : \"\" );\n"
    "}\n"
    "\n"
    "static int asFunc_RS_ApiPollMapWeapons( void ) { return RS_ApiPollMapWeapons(); }\n"
    "\n"
    "static asstring_t *asFunc_RS_MapWeaponsText( void )\n"
    "{\n"
    "\tconst char *s = RS_MapWeaponsText();\n"
    "\treturn angelExport->asStringFactoryBuffer( s, strlen( s ) );\n"
    "}\n"
    "\n"
) + ANCHOR_TABLE
patch("game/g_ascript.cpp", ANCHOR_TABLE, MAPWEAPONS_WRAPPER, "asFunc mapweapons wrapper")

MAPWEAPONS_ENTRY = ANCHOR_ENTRY + (
    "\t{ \"void RS_ApiFetchMapWeapons( const String &in url, const String &in token )\", "
    "asFUNCTION(asFunc_RS_ApiFetchMapWeapons), NULL },\n"
    "\t{ \"int RS_ApiPollMapWeapons()\", asFUNCTION(asFunc_RS_ApiPollMapWeapons), NULL },\n"
    "\t{ \"const String @RS_MapWeaponsText()\", asFUNCTION(asFunc_RS_MapWeaponsText), NULL },\n"
)
patch("game/g_ascript.cpp", ANCHOR_ENTRY, MAPWEAPONS_ENTRY, "asGlobFuncs mapweapons entry")

# --- 1j. recently-played maps: pull the central last-played list --------------
# Adds RS_ApiFetchLastMaps / RS_ApiPollLastMaps / RS_LastMapsText (impl in
# g_rs_api.cpp). The gametype (hrace/lastmaps.as) polls this ~60s so the in-game
# /lastmaps command answers instantly from the cached list of the maps most
# recently finished across the network. Same fetch/poll/text shape as the
# blocked-maps trio (url + token, no map arg). Anchors re-emitted so they stay
# unique. The Dockerfile asserts on "asFunc_RS_ApiFetchLastMaps".
LASTMAPS_WRAPPER = (
    "// racesow-docker: recently-played maps - GETs the central\n"
    "// /api/game/last-maps text (one lowercased map name per line, most-recent\n"
    "// first) into memory; the gametype polls RS_ApiPollLastMaps and reads\n"
    "// RS_LastMapsText so the in-game /lastmaps command answers from a cached list.\n"
    "void RS_ApiFetchLastMaps( const char *url, const char *token );\n"
    "int RS_ApiPollLastMaps( void );\n"
    "const char *RS_LastMapsText( void );\n"
    "\n"
    "static void asFunc_RS_ApiFetchLastMaps( asstring_t *url, asstring_t *token )\n"
    "{\n"
    "\tif( !url || !url->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiFetchLastMaps( url->buffer, token && token->buffer ? token->buffer : \"\" );\n"
    "}\n"
    "\n"
    "static int asFunc_RS_ApiPollLastMaps( void ) { return RS_ApiPollLastMaps(); }\n"
    "\n"
    "static asstring_t *asFunc_RS_LastMapsText( void )\n"
    "{\n"
    "\tconst char *s = RS_LastMapsText();\n"
    "\treturn angelExport->asStringFactoryBuffer( s, strlen( s ) );\n"
    "}\n"
    "\n"
) + ANCHOR_TABLE
patch("game/g_ascript.cpp", ANCHOR_TABLE, LASTMAPS_WRAPPER, "asFunc lastmaps wrapper")

LASTMAPS_ENTRY = ANCHOR_ENTRY + (
    "\t{ \"void RS_ApiFetchLastMaps( const String &in url, const String &in token )\", "
    "asFUNCTION(asFunc_RS_ApiFetchLastMaps), NULL },\n"
    "\t{ \"int RS_ApiPollLastMaps()\", asFUNCTION(asFunc_RS_ApiPollLastMaps), NULL },\n"
    "\t{ \"const String @RS_LastMapsText()\", asFUNCTION(asFunc_RS_LastMapsText), NULL },\n"
)
patch("game/g_ascript.cpp", ANCHOR_ENTRY, LASTMAPS_ENTRY, "asGlobFuncs lastmaps entry")

# --- 1k. per-player PB on join: pull ONE player's record for the current map ---
# Adds RS_ApiFetchPlayerRecord / RS_ApiPollPlayerRecord / RS_PlayerRecordText
# (impl in g_rs_api.cpp). Unlike the map-wide fetches, this is PER PLAYER: the
# fetch + poll + text natives take a playerNum so several joining players can be
# in flight at once (the native keeps a per-slot result). The gametype
# (hrace/playerrecord.as) fetches on join and seeds that player's best_recordTime
# - rank, finish time AND checkpoint splits - so the scoreboard "Pos"/time works
# for players ranked past the local top-50 board and the live per-checkpoint
# comparison is ready from their first run. The int->String poll/text wrappers
# mirror RS_GhostFrameAt. Anchors re-emitted so they stay unique. The Dockerfile
# asserts on "asFunc_RS_ApiFetchPlayerRecord".
PLAYERREC_WRAPPER = (
    "// racesow-docker: per-player PB on join - GETs the central\n"
    "// /api/game/player-record text (a \"//playerrec <rank> <total>\" header, then\n"
    "// ONE topscores-format record line) into a per-player slot; the gametype polls\n"
    "// RS_ApiPollPlayerRecord(playerNum) and reads RS_PlayerRecordText(playerNum),\n"
    "// then seeds that player's best_recordTime (rank + time + checkpoint splits).\n"
    "void RS_ApiFetchPlayerRecord( const char *url, const char *token, const char *mapname,\n"
    "\tconst char *cleanName, int playerNum );\n"
    "int RS_ApiPollPlayerRecord( int playerNum );\n"
    "const char *RS_PlayerRecordText( int playerNum );\n"
    "\n"
    "static void asFunc_RS_ApiFetchPlayerRecord( asstring_t *url, asstring_t *token,\n"
    "\tasstring_t *mapname, asstring_t *name, int playerNum )\n"
    "{\n"
    "\tif( !url || !url->buffer || !mapname || !mapname->buffer || !name || !name->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiFetchPlayerRecord( url->buffer,\n"
    "\t\ttoken && token->buffer ? token->buffer : \"\",\n"
    "\t\tmapname->buffer, name->buffer, playerNum );\n"
    "}\n"
    "\n"
    "static int asFunc_RS_ApiPollPlayerRecord( int playerNum ) { return RS_ApiPollPlayerRecord( playerNum ); }\n"
    "\n"
    "static asstring_t *asFunc_RS_PlayerRecordText( int playerNum )\n"
    "{\n"
    "\tconst char *s = RS_PlayerRecordText( playerNum );\n"
    "\treturn angelExport->asStringFactoryBuffer( s, strlen( s ) );\n"
    "}\n"
    "\n"
) + ANCHOR_TABLE
patch("game/g_ascript.cpp", ANCHOR_TABLE, PLAYERREC_WRAPPER, "asFunc playerrecord wrapper")

PLAYERREC_ENTRY = ANCHOR_ENTRY + (
    "\t{ \"void RS_ApiFetchPlayerRecord( const String &in url, const String &in token, "
    "const String &in map, const String &in name, int playerNum )\", "
    "asFUNCTION(asFunc_RS_ApiFetchPlayerRecord), NULL },\n"
    "\t{ \"int RS_ApiPollPlayerRecord( int playerNum )\", asFUNCTION(asFunc_RS_ApiPollPlayerRecord), NULL },\n"
    "\t{ \"const String @RS_PlayerRecordText( int playerNum )\", asFUNCTION(asFunc_RS_PlayerRecordText), NULL },\n"
)
patch("game/g_ascript.cpp", ANCHOR_ENTRY, PLAYERREC_ENTRY, "asGlobFuncs playerrecord entry")

# --- 1k2. "/top <map>": pull ANOTHER map's board for ONE player ----------------
# Adds RS_ApiFetchMapTop / RS_ApiPollMapTop / RS_MapTopText (impl in
# g_rs_api.cpp). PER PLAYER, the same shape as the player-record trio, because
# two players can ask about two different maps at once.
#
# NOT RS_ApiFetchTop with a different argument: that native is the CURRENT map's
# board — it writes topscores/race/<map>.txt for the level loader to re-read, and
# its single shared fetchGen/fetchResult also gates the pending record announce,
# so an arbitrary map's payload landing there could satisfy an announcement about
# the map everyone is racing. This one keeps the board in memory and hands it
# straight to the asking player (hrace/apitop.as). Anchors re-emitted so they
# stay unique. The Dockerfile asserts on "asFunc_RS_ApiFetchMapTop".
MAPTOP_WRAPPER = (
    "// racesow-docker: \"/top <map>\" - GETs the central /api/game/topscores text\n"
    "// for an arbitrary map into a per-player slot; the gametype polls\n"
    "// RS_ApiPollMapTop(playerNum) and reads RS_MapTopText(playerNum), then\n"
    "// tokenises it with its own topscores parser (the payload is byte-identical\n"
    "// to a topscores file) and prints the board to that one player.\n"
    "void RS_ApiFetchMapTop( const char *url, const char *token, const char *mapname,\n"
    "\tint playerNum );\n"
    "int RS_ApiPollMapTop( int playerNum );\n"
    "const char *RS_MapTopText( int playerNum );\n"
    "\n"
    "static void asFunc_RS_ApiFetchMapTop( asstring_t *url, asstring_t *token,\n"
    "\tasstring_t *mapname, int playerNum )\n"
    "{\n"
    "\tif( !url || !url->buffer || !mapname || !mapname->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiFetchMapTop( url->buffer,\n"
    "\t\ttoken && token->buffer ? token->buffer : \"\",\n"
    "\t\tmapname->buffer, playerNum );\n"
    "}\n"
    "\n"
    "static int asFunc_RS_ApiPollMapTop( int playerNum ) { return RS_ApiPollMapTop( playerNum ); }\n"
    "\n"
    "static asstring_t *asFunc_RS_MapTopText( int playerNum )\n"
    "{\n"
    "\tconst char *s = RS_MapTopText( playerNum );\n"
    "\treturn angelExport->asStringFactoryBuffer( s, strlen( s ) );\n"
    "}\n"
    "\n"
) + ANCHOR_TABLE
patch("game/g_ascript.cpp", ANCHOR_TABLE, MAPTOP_WRAPPER, "asFunc maptop wrapper")

MAPTOP_ENTRY = ANCHOR_ENTRY + (
    "\t{ \"void RS_ApiFetchMapTop( const String &in url, const String &in token, "
    "const String &in map, int playerNum )\", "
    "asFUNCTION(asFunc_RS_ApiFetchMapTop), NULL },\n"
    "\t{ \"int RS_ApiPollMapTop( int playerNum )\", asFUNCTION(asFunc_RS_ApiPollMapTop), NULL },\n"
    "\t{ \"const String @RS_MapTopText( int playerNum )\", asFUNCTION(asFunc_RS_MapTopText), NULL },\n"
)
patch("game/g_ascript.cpp", ANCHOR_ENTRY, MAPTOP_ENTRY, "asGlobFuncs maptop entry")

# --- 1l. per-player saved START on join: pull ONE player's saved start(s) ------
# Adds RS_ApiFetchSavedStart / RS_ApiPollSavedStart / RS_SavedStartText (impl in
# g_rs_api.cpp). PER PLAYER (playerNum-keyed per-slot result), the same shape as
# the player-record trio: the gametype (hrace/savedstarts.as) fetches on join and
# teleports the returning player to their saved spot. Anchors re-emitted so they
# stay unique. The Dockerfile asserts on "asFunc_RS_ApiFetchSavedStart".
SAVEDSTART_WRAPPER = (
    "// racesow-docker: per-player saved START on join - GETs the central\n"
    "// /api/game/saved-start text (a \"//starts\" header, then a\n"
    "// \"<race|reverse> x y z pitch yaw roll\" line per saved direction) into a\n"
    "// per-player slot; the gametype polls RS_ApiPollSavedStart(playerNum) and\n"
    "// reads RS_SavedStartText(playerNum), then spawns the player at their start.\n"
    "void RS_ApiFetchSavedStart( const char *url, const char *token, const char *mapname,\n"
    "\tconst char *cleanName, int playerNum );\n"
    "int RS_ApiPollSavedStart( int playerNum );\n"
    "const char *RS_SavedStartText( int playerNum );\n"
    "\n"
    "static void asFunc_RS_ApiFetchSavedStart( asstring_t *url, asstring_t *token,\n"
    "\tasstring_t *mapname, asstring_t *name, int playerNum )\n"
    "{\n"
    "\tif( !url || !url->buffer || !mapname || !mapname->buffer || !name || !name->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiFetchSavedStart( url->buffer,\n"
    "\t\ttoken && token->buffer ? token->buffer : \"\",\n"
    "\t\tmapname->buffer, name->buffer, playerNum );\n"
    "}\n"
    "\n"
    "static int asFunc_RS_ApiPollSavedStart( int playerNum ) { return RS_ApiPollSavedStart( playerNum ); }\n"
    "\n"
    "static asstring_t *asFunc_RS_SavedStartText( int playerNum )\n"
    "{\n"
    "\tconst char *s = RS_SavedStartText( playerNum );\n"
    "\treturn angelExport->asStringFactoryBuffer( s, strlen( s ) );\n"
    "}\n"
    "\n"
) + ANCHOR_TABLE
patch("game/g_ascript.cpp", ANCHOR_TABLE, SAVEDSTART_WRAPPER, "asFunc savedstart wrapper")

SAVEDSTART_ENTRY = ANCHOR_ENTRY + (
    "\t{ \"void RS_ApiFetchSavedStart( const String &in url, const String &in token, "
    "const String &in map, const String &in name, int playerNum )\", "
    "asFUNCTION(asFunc_RS_ApiFetchSavedStart), NULL },\n"
    "\t{ \"int RS_ApiPollSavedStart( int playerNum )\", asFUNCTION(asFunc_RS_ApiPollSavedStart), NULL },\n"
    "\t{ \"const String @RS_SavedStartText( int playerNum )\", asFUNCTION(asFunc_RS_SavedStartText), NULL },\n"
)
patch("game/g_ascript.cpp", ANCHOR_ENTRY, SAVEDSTART_ENTRY, "asGlobFuncs savedstart entry")

# --- 1m. /savestart POST: persist (or clear) a player's saved start -----------
# Adds RS_ApiSaveStart (impl in g_rs_api.cpp). Fire-and-forget POST like RS_ApiFlag
# (no poll); an empty coords string = delete that direction. Anchors re-emitted so
# they stay unique. The Dockerfile asserts on "asFunc_RS_ApiSaveStart".
SAVESTART_WRAPPER = (
    "// racesow-docker: /savestart - POST a player's saved start (empty coords =\n"
    "// clear) to /api/ingest/saved-start (queued + sent on the worker thread).\n"
    "void RS_ApiSaveStart( const char *url, const char *token, const char *mapname,\n"
    "\tconst char *player, const char *login, const char *mode, const char *coords );\n"
    "\n"
    "static void asFunc_RS_ApiSaveStart( asstring_t *url, asstring_t *token, asstring_t *mapname,\n"
    "\tasstring_t *player, asstring_t *login, asstring_t *mode, asstring_t *coords )\n"
    "{\n"
    "\tif( !url || !url->buffer || !mapname || !mapname->buffer || !player || !player->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiSaveStart( url->buffer,\n"
    "\t\ttoken && token->buffer ? token->buffer : \"\",\n"
    "\t\tmapname->buffer, player->buffer,\n"
    "\t\tlogin && login->buffer ? login->buffer : \"\",\n"
    "\t\tmode && mode->buffer ? mode->buffer : \"\",\n"
    "\t\tcoords && coords->buffer ? coords->buffer : \"\" );\n"
    "}\n"
    "\n"
) + ANCHOR_TABLE
patch("game/g_ascript.cpp", ANCHOR_TABLE, SAVESTART_WRAPPER, "asFunc savestart wrapper")

SAVESTART_ENTRY = ANCHOR_ENTRY + (
    "\t{ \"void RS_ApiSaveStart( const String &in url, const String &in token, "
    "const String &in map, const String &in player, const String &in login, "
    "const String &in mode, const String &in coords )\", "
    "asFUNCTION(asFunc_RS_ApiSaveStart), NULL },\n"
)
patch("game/g_ascript.cpp", ANCHOR_ENTRY, SAVESTART_ENTRY, "asGlobFuncs savestart entry")

# --- 1n. per-player achievement announcements: poll fresh award rows ----------
# Adds RS_ApiFetchAwards / RS_ApiPollAwards / RS_AwardsText (impl in
# g_rs_api.cpp). PER PLAYER (playerNum-keyed per-slot result), the same shape as
# the player-record/saved-start trios: the gametype (hrace/awards.as) seeds a
# high-water award row id on join (after < 0 = the ?seed=1 variant) and then
# polls for rows above it, popping "Achievement unlocked" for each. Anchors
# re-emitted so they stay unique. The Dockerfile asserts on
# "asFunc_RS_ApiFetchAwards".
AWARDS_WRAPPER = (
    "// racesow-docker: per-player achievement announcements - GETs the central\n"
    "// /api/game/awards text (a \"//awards\" header, then one\n"
    "// \"<rowId>\\t<tier>\\t<title>\\t<description>\" line per fresh award) into a\n"
    "// per-player slot; the gametype polls RS_ApiPollAwards(playerNum), reads\n"
    "// RS_AwardsText(playerNum) and announces the new rows.\n"
    "void RS_ApiFetchAwards( const char *url, const char *token, const char *cleanName,\n"
    "\tint after, int playerNum );\n"
    "int RS_ApiPollAwards( int playerNum );\n"
    "const char *RS_AwardsText( int playerNum );\n"
    "\n"
    "static void asFunc_RS_ApiFetchAwards( asstring_t *url, asstring_t *token,\n"
    "\tasstring_t *name, int after, int playerNum )\n"
    "{\n"
    "\tif( !url || !url->buffer || !name || !name->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiFetchAwards( url->buffer,\n"
    "\t\ttoken && token->buffer ? token->buffer : \"\",\n"
    "\t\tname->buffer, after, playerNum );\n"
    "}\n"
    "\n"
    "static int asFunc_RS_ApiPollAwards( int playerNum ) { return RS_ApiPollAwards( playerNum ); }\n"
    "\n"
    "static asstring_t *asFunc_RS_AwardsText( int playerNum )\n"
    "{\n"
    "\tconst char *s = RS_AwardsText( playerNum );\n"
    "\treturn angelExport->asStringFactoryBuffer( s, strlen( s ) );\n"
    "}\n"
    "\n"
) + ANCHOR_TABLE
patch("game/g_ascript.cpp", ANCHOR_TABLE, AWARDS_WRAPPER, "asFunc awards wrapper")

AWARDS_ENTRY = ANCHOR_ENTRY + (
    "\t{ \"void RS_ApiFetchAwards( const String &in url, const String &in token, "
    "const String &in name, int after, int playerNum )\", "
    "asFUNCTION(asFunc_RS_ApiFetchAwards), NULL },\n"
    "\t{ \"int RS_ApiPollAwards( int playerNum )\", asFUNCTION(asFunc_RS_ApiPollAwards), NULL },\n"
    "\t{ \"const String @RS_AwardsText( int playerNum )\", asFUNCTION(asFunc_RS_AwardsText), NULL },\n"
)
patch("game/g_ascript.cpp", ANCHOR_ENTRY, AWARDS_ENTRY, "asGlobFuncs awards entry")

# --- 1o. tournaments: the current/next tournament feed + the in-game join -----
# Adds RS_ApiFetchTourney / RS_ApiPollTourney / RS_TourneyText (SHARED, the
# lastmaps shape: one deduped payload per server, re-fetched every ~60s) and
# RS_ApiTourneyJoin / RS_ApiPollTourneyJoin / RS_TourneyJoinText (PER PLAYER,
# playerNum-keyed like the awards trio). The join is the only POST in this file
# whose REPLY is read: the player has to be told whether their entry code
# worked, so the response body is captured into their slot and printed. Anchors
# re-emitted so they stay unique. The Dockerfile asserts on
# "asFunc_RS_ApiFetchTourney" and "asFunc_RS_ApiTourneyJoin".
TOURNEY_WRAPPER = (
    "// racesow-docker: tournaments - GETs the central /api/game/tournament text\n"
    "// (an \"RSTOURNEY\" header, then one \"T\\t...\" line and one \"M\\t<map>\" line\n"
    "// per pool map) into memory; the gametype polls RS_ApiPollTourney and reads\n"
    "// RS_TourneyText. RS_ApiTourneyJoin POSTs an entry redeem for ONE player and\n"
    "// captures the reply in that player\'s slot (RS_ApiPollTourneyJoin /\n"
    "// RS_TourneyJoinText), because the reply is what gets printed to them.\n"
    "void RS_ApiFetchTourney( const char *url, const char *token );\n"
    "int RS_ApiPollTourney( void );\n"
    "const char *RS_TourneyText( void );\n"
    "void RS_ApiTourneyJoin( const char *url, const char *token, const char *code,\n"
    "\tconst char *player, const char *login, int playerNum );\n"
    "int RS_ApiPollTourneyJoin( int playerNum );\n"
    "const char *RS_TourneyJoinText( int playerNum );\n"
    "\n"
    "static void asFunc_RS_ApiFetchTourney( asstring_t *url, asstring_t *token )\n"
    "{\n"
    "\tif( !url || !url->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiFetchTourney( url->buffer, token && token->buffer ? token->buffer : \"\" );\n"
    "}\n"
    "\n"
    "static int asFunc_RS_ApiPollTourney( void ) { return RS_ApiPollTourney(); }\n"
    "\n"
    "static asstring_t *asFunc_RS_TourneyText( void )\n"
    "{\n"
    "\tconst char *s = RS_TourneyText();\n"
    "\treturn angelExport->asStringFactoryBuffer( s, strlen( s ) );\n"
    "}\n"
    "\n"
    "static void asFunc_RS_ApiTourneyJoin( asstring_t *url, asstring_t *token, asstring_t *code,\n"
    "\tasstring_t *player, asstring_t *login, int playerNum )\n"
    "{\n"
    "\tif( !url || !url->buffer || !player || !player->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiTourneyJoin( url->buffer,\n"
    "\t\ttoken && token->buffer ? token->buffer : \"\",\n"
    "\t\tcode && code->buffer ? code->buffer : \"\",\n"
    "\t\tplayer->buffer,\n"
    "\t\tlogin && login->buffer ? login->buffer : \"\",\n"
    "\t\tplayerNum );\n"
    "}\n"
    "\n"
    "static int asFunc_RS_ApiPollTourneyJoin( int playerNum ) { return RS_ApiPollTourneyJoin( playerNum ); }\n"
    "\n"
    "static asstring_t *asFunc_RS_TourneyJoinText( int playerNum )\n"
    "{\n"
    "\tconst char *s = RS_TourneyJoinText( playerNum );\n"
    "\treturn angelExport->asStringFactoryBuffer( s, strlen( s ) );\n"
    "}\n"
    "\n"
) + ANCHOR_TABLE
patch("game/g_ascript.cpp", ANCHOR_TABLE, TOURNEY_WRAPPER, "asFunc tourney wrappers")

TOURNEY_ENTRY = ANCHOR_ENTRY + (
    "\t{ \"void RS_ApiFetchTourney( const String &in url, const String &in token )\", "
    "asFUNCTION(asFunc_RS_ApiFetchTourney), NULL },\n"
    "\t{ \"int RS_ApiPollTourney()\", asFUNCTION(asFunc_RS_ApiPollTourney), NULL },\n"
    "\t{ \"const String @RS_TourneyText()\", asFUNCTION(asFunc_RS_TourneyText), NULL },\n"
    "\t{ \"void RS_ApiTourneyJoin( const String &in url, const String &in token, "
    "const String &in code, const String &in player, const String &in login, int playerNum )\", "
    "asFUNCTION(asFunc_RS_ApiTourneyJoin), NULL },\n"
    "\t{ \"int RS_ApiPollTourneyJoin( int playerNum )\", asFUNCTION(asFunc_RS_ApiPollTourneyJoin), NULL },\n"
    "\t{ \"const String @RS_TourneyJoinText( int playerNum )\", asFUNCTION(asFunc_RS_TourneyJoinText), NULL },\n"
)
patch("game/g_ascript.cpp", ANCHOR_ENTRY, TOURNEY_ENTRY, "asGlobFuncs tourney entries")

# --- 1o. 1v1 duels: report a concluded match-up ------------------------------
# Adds RS_ApiReportDuel (impl in g_rs_api.cpp). Fire-and-forget POST like
# RS_ApiFlag: hrace/duel.as calls it once when a duel concludes and nothing
# reads a reply. Anchors re-emitted so they stay unique. The Dockerfile asserts
# on "asFunc_RS_ApiReportDuel".
DUEL_WRAPPER = (
    "// racesow-docker: 1v1 duels - POSTs a concluded head-to-head (two players,\n"
    "// the map, each one's best time and finish count, the winner and why it\n"
    "// ended) to the central /api/game/duel so it lands on both profiles.\n"
    "void RS_ApiReportDuel( const char *url, const char *token, const char *version,\n"
    "\tconst char *mapname,\n"
    "\tconst char *nameA, const char *loginA, int timeA, int finishesA,\n"
    "\tconst char *nameB, const char *loginB, int timeB, int finishesB,\n"
    "\tconst char *winner, const char *reason, int durationSec );\n"
    "\n"
    "static void asFunc_RS_ApiReportDuel( asstring_t *url, asstring_t *token, asstring_t *version,\n"
    "\tasstring_t *mapname,\n"
    "\tasstring_t *nameA, asstring_t *loginA, int timeA, int finishesA,\n"
    "\tasstring_t *nameB, asstring_t *loginB, int timeB, int finishesB,\n"
    "\tasstring_t *winner, asstring_t *reason, int durationSec )\n"
    "{\n"
    "\tif( !url || !url->buffer || !mapname || !mapname->buffer )\n"
    "\t\treturn;\n"
    "\tif( !nameA || !nameA->buffer || !nameB || !nameB->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiReportDuel( url->buffer,\n"
    "\t\ttoken && token->buffer ? token->buffer : \"\",\n"
    "\t\tversion && version->buffer ? version->buffer : \"\",\n"
    "\t\tmapname->buffer,\n"
    "\t\tnameA->buffer,\n"
    "\t\tloginA && loginA->buffer ? loginA->buffer : \"\",\n"
    "\t\ttimeA, finishesA,\n"
    "\t\tnameB->buffer,\n"
    "\t\tloginB && loginB->buffer ? loginB->buffer : \"\",\n"
    "\t\ttimeB, finishesB,\n"
    "\t\twinner && winner->buffer ? winner->buffer : \"\",\n"
    "\t\treason && reason->buffer ? reason->buffer : \"\",\n"
    "\t\tdurationSec );\n"
    "}\n"
    "\n"
) + ANCHOR_TABLE
patch("game/g_ascript.cpp", ANCHOR_TABLE, DUEL_WRAPPER, "asFunc duel wrapper")

DUEL_ENTRY = ANCHOR_ENTRY + (
    "\t{ \"void RS_ApiReportDuel( const String &in url, const String &in token, "
    "const String &in version, const String &in map, "
    "const String &in nameA, const String &in loginA, int timeA, int finishesA, "
    "const String &in nameB, const String &in loginB, int timeB, int finishesB, "
    "const String &in winner, const String &in reason, int durationSec )\", "
    "asFUNCTION(asFunc_RS_ApiReportDuel), NULL },\n"
)
patch("game/g_ascript.cpp", ANCHOR_ENTRY, DUEL_ENTRY, "asGlobFuncs duel entry")

# --- 2. link libcurl + pthread into the game module --------------------------
ANCHOR_LINK = "target_link_libraries(game PRIVATE ${ANGELSCRIPT_LIBRARY})"
LINK = "target_link_libraries(game PRIVATE ${ANGELSCRIPT_LIBRARY} curl pthread)"

patch("game/CMakeLists.txt", ANCHOR_LINK, LINK, "game curl linkage")

print("api natives patch applied")
