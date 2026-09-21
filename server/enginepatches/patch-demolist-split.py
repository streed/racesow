#!/usr/bin/env python3
"""Give `demolist`/`demoget` back the SERVER demos, and put the per-map race
demos on their own pair of commands.

Two different things write under demos/server on a race box:

  * SERVER autorecords, at the demos/server ROOT. hrace.as drives these via
    match.startAutorecord() whenever a real player is on, so the engine writes
    demos/server/<date>_<time>_hrace_<map>_auto<N>.<ext>.
  * per-player RACE demos, one directory deeper, at demos/server/<map>/. These
    are the personal-best runs hrace/demos.as records through Client::demoStop
    and the website links as downloads.

Stock qfusion points SV_DemoList_f/SV_DemoGet_f at SV_DEMO_DIR (the root). The
racemod_2.1 fork repointed BOTH at "SV_DEMO_DIR/<current map>" instead, so the
autorecorded server demos stopped being listable or fetchable at all - on the
EU box that is 200 files no in-game command can reach. Warfork never took that
change and still lists the root, so today the same command means two different
things depending on which of our four nodes you are standing on.

This restores the stock meaning on both engines and adds the map-scoped view as
new commands:

  demolist / demoget         -> demos/server            (server autorecords)
  racedemolist / racedemoget -> demos/server/<map>      (per-player race demos)

The listing/fetching bodies are shared: each pair becomes a thin wrapper around
a _Dir helper that takes the folder. `racedemoget` still answers with the
client-side `demoget "<path>"` verb, so stock clients download it with no
client change - only the server-side command name is new.

Handles both source shapes:

  * racemod_2.1 - the handlers hold a `char *folder` local assigned from
    va( "%s/%s", SV_DEMO_DIR, CS_MAPNAME ). Local and assignment are dropped.
  * warfork-qfusion (stock) - the handlers use SV_DEMO_DIR inline. Those uses
    become `folder` within the two function bodies only.

Run from the qfusion source/ directory. Exits non-zero (failing the image
build) if any anchor is not found the expected number of times.
"""
import sys

DEMOS = "server/sv_demos.c"
CLIENT = "server/sv_client.c"
HEADER = "server/server.h"

MARK = "racesow-docker: demolist split"

PERMAP = '\tfolder = va( "%s/%s", SV_DEMO_DIR, sv.configstrings[CS_MAPNAME] );\n'


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write(path, src):
    with open(path, "w", encoding="utf-8") as f:
        f.write(src)


def sub(src, old, new, what, path, times=1):
    n = src.count(old)
    if n != times:
        sys.exit("FATAL: %s anchor found %d time(s), expected %d in %s"
                 % (what, n, times, path))
    return src.replace(old, new)


def body_span(src, signature, what):
    """Index range of one function body, signature through its closing brace."""
    start = src.find(signature)
    if start < 0 or src.find(signature, start + 1) >= 0:
        sys.exit("FATAL: %s signature not found exactly once in %s" % (what, DEMOS))
    end = src.find("\n}\n", start)
    if end < 0:
        sys.exit("FATAL: no closing brace for %s in %s" % (what, DEMOS))
    return start, end + len("\n}\n")


# --- guard: never double-apply -----------------------------------------------
for path in (DEMOS, CLIENT, HEADER):
    if MARK in read(path):
        sys.exit("FATAL: demolist-split patch already applied to " + path)

src = read(DEMOS)

LIST_SIG = "void SV_DemoList_f( client_t *client )\n"
GET_SIG = "void SV_DemoGet_f( client_t *client )\n"
LIST_DIR = "static void SV_DemoList_Dir( client_t *client, const char *folder )\n"
GET_DIR = "static void SV_DemoGet_Dir( client_t *client, const char *folder )\n"

# --- 1. sv_demos.c: turn the two handlers into folder-taking helpers ----------
racemod = PERMAP in src
if racemod:
    # racemod_2.1: the per-map folder assignment appears exactly twice - once in
    # each handler. Both go away; the folder arrives as a parameter instead.
    # (SV_RaceDemo_Purge_f has its own `folder`, built from Cmd_Argv, and is
    # deliberately left alone - hence the neighbour-anchored local removals.)
    src = sub(src, PERMAP, "", "per-map folder assignment", DEMOS, times=2)
    src = sub(src,
              "\tchar *folder;\n\tsize_t j, length, length_escaped, pos, extlen;\n",
              "\tsize_t j, length, length_escaped, pos, extlen;\n",
              "SV_DemoList_f folder local", DEMOS)
    src = sub(src,
              "\tchar *folder;\n\tsize_t j, length, length_escaped, pos, pos_bak, msglen;\n",
              "\tsize_t j, length, length_escaped, pos, pos_bak, msglen;\n",
              "SV_DemoGet_f folder local", DEMOS)
    src = sub(src, LIST_SIG, LIST_DIR, "SV_DemoList_f signature", DEMOS)
    src = sub(src, GET_SIG, GET_DIR, "SV_DemoGet_f signature", DEMOS)
else:
    # stock warfork-qfusion: SV_DEMO_DIR is used inline. Rewrite those uses to
    # `folder`, but ONLY inside the two handlers - SV_DEMO_DIR is used all over
    # this file (recording, purge, download validation) and must stay there.
    for sig, dirsig, what in ((LIST_SIG, LIST_DIR, "SV_DemoList_f"),
                              (GET_SIG, GET_DIR, "SV_DemoGet_f")):
        start, end = body_span(src, sig, what)
        body = src[start:end]
        n = body.count("SV_DEMO_DIR")
        if n < 2:
            sys.exit("FATAL: %s uses SV_DEMO_DIR only %d time(s) in %s"
                     % (what, n, DEMOS))
        body = body.replace("SV_DEMO_DIR", "folder").replace(sig, dirsig, 1)
        src = src[:start] + body + src[end:]

# --- 2. sv_demos.c: the four public wrappers ---------------------------------
LIST_WRAPPERS = """/*
* SV_DemoList_f  (%s)
*
* The SERVER demos: match autorecords, written straight into demos/server.
*/
void SV_DemoList_f( client_t *client )
{
	SV_DemoList_Dir( client, SV_DEMO_DIR );
}

/*
* SV_RaceDemoList_f
*
* The per-player RACE demos for the map being played, one directory deeper.
*/
void SV_RaceDemoList_f( client_t *client )
{
	SV_DemoList_Dir( client, va( "%%s/%%s", SV_DEMO_DIR, sv.configstrings[CS_MAPNAME] ) );
}

/*
* SV_DemoGet_f
""" % MARK

src = sub(src, "/*\n* SV_DemoGet_f\n", LIST_WRAPPERS,
          "SV_DemoGet_f comment block", DEMOS)

GET_WRAPPERS = """/*
* SV_DemoGet_f - answers a server-demo request from demos/server.
*/
void SV_DemoGet_f( client_t *client )
{
	SV_DemoGet_Dir( client, SV_DEMO_DIR );
}

/*
* SV_RaceDemoGet_f - answers a race-demo request from demos/server/<map>.
*
* Replies with the same client-side `demoget "<path>"` verb as SV_DemoGet_f,
* so a stock client downloads it without knowing this command exists.
*/
void SV_RaceDemoGet_f( client_t *client )
{
	SV_DemoGet_Dir( client, va( "%s/%s", SV_DEMO_DIR, sv.configstrings[CS_MAPNAME] ) );
}

/*
* SV_IsDemoDownloadRequest
*/
"""

src = sub(src, "/*\n* SV_IsDemoDownloadRequest\n*/\n", GET_WRAPPERS,
          "SV_IsDemoDownloadRequest comment block", DEMOS)
write(DEMOS, src)

# --- 3. server.h: declare the two new handlers -------------------------------
src = read(HEADER)
src = sub(src,
          "void SV_DemoGet_f( client_t *client );",
          "void SV_DemoGet_f( client_t *client );\n"
          "// " + MARK + " - the map-scoped race-demo views\n"
          "void SV_RaceDemoList_f( client_t *client );\n"
          "void SV_RaceDemoGet_f( client_t *client );",
          "SV_DemoGet_f prototype", HEADER)
write(HEADER, src)

# --- 4. sv_client.c: expose them as client commands --------------------------
src = read(CLIENT)
src = sub(src,
          '\t{ "demoget", SV_DemoGet_f },\n',
          '\t{ "demoget", SV_DemoGet_f },\n'
          "\t// " + MARK + "\n"
          '\t{ "racedemolist", SV_RaceDemoList_f },\n'
          '\t{ "racedemoget", SV_RaceDemoGet_f },\n',
          "demoget command table entry", CLIENT)
write(CLIENT, src)

print("patched: %s tree" % ("racemod_2.1" if racemod else "warfork-qfusion"))
print("patched: demolist/demoget -> demos/server root")
print("patched: racedemolist/racedemoget -> demos/server/<map>")
print("demolist-split patch applied")
