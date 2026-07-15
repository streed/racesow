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
    "\tint timeMs, const char *cpsCsv );\n"
    "// racesow-docker: live top-scores fetch - GETs the central\n"
    "// /api/game/topscores payload (byte-format identical to a topscores\n"
    "// file) and swaps it into the map's local file; the gametype polls\n"
    "// RS_ApiPollTop and re-reads the file through its normal loader.\n"
    "void RS_ApiFetchTop( const char *url, const char *token, const char *mapname );\n"
    "int RS_ApiPollTop( void );\n"
    "\n"
    "static void asFunc_RS_ApiReportRace( asstring_t *url, asstring_t *token, asstring_t *version,\n"
    "\tasstring_t *mapname, asstring_t *player, asstring_t *login, int timeMs, asstring_t *cps )\n"
    "{\n"
    "\tif( !url || !url->buffer || !mapname || !mapname->buffer || !player || !player->buffer )\n"
    "\t\treturn;\n"
    "\tRS_ApiReportRace( url->buffer,\n"
    "\t\ttoken && token->buffer ? token->buffer : \"\",\n"
    "\t\tversion && version->buffer ? version->buffer : \"\",\n"
    "\t\tmapname->buffer, player->buffer,\n"
    "\t\tlogin && login->buffer ? login->buffer : \"\",\n"
    "\t\ttimeMs,\n"
    "\t\tcps && cps->buffer ? cps->buffer : \"\" );\n"
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
    "const String &in login, int timeMs, const String &in checkpoints )\", "
    "asFUNCTION(asFunc_RS_ApiReportRace), NULL },\n"
    "\t{ \"void RS_ApiFetchTop( const String &in url, const String &in token, "
    "const String &in map )\", asFUNCTION(asFunc_RS_ApiFetchTop), NULL },\n"
    "\t{ \"int RS_ApiPollTop()\", asFUNCTION(asFunc_RS_ApiPollTop), NULL },\n"
)

patch("game/g_ascript.cpp", ANCHOR_ENTRY, ENTRY, "asGlobFuncs entry")

# --- 2. link libcurl + pthread into the game module --------------------------
ANCHOR_LINK = "target_link_libraries(game PRIVATE ${ANGELSCRIPT_LIBRARY})"
LINK = "target_link_libraries(game PRIVATE ${ANGELSCRIPT_LIBRARY} curl pthread)"

patch("game/CMakeLists.txt", ANCHOR_LINK, LINK, "game curl linkage")

print("api natives patch applied")
