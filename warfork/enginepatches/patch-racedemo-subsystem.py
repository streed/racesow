#!/usr/bin/env python3
"""Wire the per-client RACE demo subsystem into the Warfork server.

Warfork's sv_demos.c only knows SERVER demos - one recording of the whole
server, written to demos/server. The Warsow racemod_2.1 fork also carries a
second, per-CLIENT kind, written to demos/server/<map>/ and driven by the
gametype through Client::demoStart / demoStop / demoCancel. That is how a
player's personal best becomes a download on the website, and it is why
warfork/scriptpatches/patch-scripts-as2024.py had to stub those three calls out
and warfork/entrypoint.sh had to set rs_record_demos 0: without the subsystem
the PBs were reporting demo links for files nothing ever recorded.

The functions themselves are vendored in sv_racedemos.c (dropped into
source/server/, where the CMake "*.c" glob picks it up). This script wires the
call sites that drive them:

  server.h   - the svs.race_demos array, the public prototypes, the meta macro
  sv_init.c  - allocate it with the client slots, free it with them
  sv_main.c  - write a snap into every open race demo each frame
  sv_send.c  - mirror reliable server commands into each recording client
  sv_game.c  - mirror game commands likewise
  sv_ccmds.c - the racerecord / racerecordstop / racerecordcancel / racerecordpurge
               console commands the AngelScript natives drive

Run from the warfork-qfusion source/ directory. Exits non-zero (failing the
image build) if any anchor is not found exactly once.
"""
import os
import sys

MARK = "racesow-docker: race demos"

HEADER = "server/server.h"
INIT = "server/sv_init.c"
MAIN = "server/sv_main.c"
SEND = "server/sv_send.c"
GAME = "server/sv_game.c"
CCMDS = "server/sv_ccmds.c"
VENDORED = "server/sv_racedemos.c"

FILES = (HEADER, INIT, MAIN, SEND, GAME, CCMDS)


def read(path):
    with open(path, encoding="utf-8", errors="surrogateescape") as f:
        return f.read()


def write(path, src):
    with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
        f.write(src)


def sub(path, old, new, what):
    src = read(path)
    n = src.count(old)
    if n != 1:
        sys.exit("FATAL: %s anchor found %d time(s), expected 1 in %s"
                 % (what, n, path))
    write(path, src.replace(old, new))


# The vendored translation unit must already be in place - the Dockerfile COPYs
# it next to sv_demos.c before running this. Without it the wiring below would
# compile to unresolved symbols at link time, so fail early and loudly.
if not os.path.exists(VENDORED):
    sys.exit("FATAL: %s is missing - COPY it into source/server/ first" % VENDORED)

for path in FILES:
    if MARK in read(path):
        sys.exit("FATAL: racedemo-subsystem patch already applied to " + path)

# --- 1. server.h: the array, the prototypes, the meta-key macro ---------------
sub(HEADER,
    "\tserver_static_demo_t demo;\n",
    "\tserver_static_demo_t demo;\n"
    "\n"
    "\t// " + MARK + " - one recording slot per client, indexed by playerNum\n"
    "\tserver_static_demo_t *race_demos;   // [sv_maxclients->integer];\n",
    "svs.demo field")

sub(HEADER,
    "void SV_Demo_Purge_f( void );\n",
    "void SV_Demo_Purge_f( void );\n"
    "\n"
    "// " + MARK + " - sv_racedemos.c\n"
    "void SV_RaceDemo_WriteSnap( void );\n"
    "void SV_RaceDemo_Start_f( void );\n"
    "void SV_RaceDemo_Stop_f( void );\n"
    "void SV_RaceDemo_Cancel_f( void );\n"
    "void SV_RaceDemo_Purge_f( void );\n",
    "sv_demos.c prototype block")

sub(HEADER,
    "#define SV_SetDemoMetaKeyValue(k,v) svs.demo.meta_data_realsize = SNAP_SetDemoMetaKeyValue(svs.demo.meta_data, sizeof(svs.demo.meta_data), svs.demo.meta_data_realsize, k, v)\n",
    "#define SV_SetDemoMetaKeyValue(k,v) svs.demo.meta_data_realsize = SNAP_SetDemoMetaKeyValue(svs.demo.meta_data, sizeof(svs.demo.meta_data), svs.demo.meta_data_realsize, k, v)\n"
    "\n"
    "#define SV_SetRaceDemoMetaKeyValue(i,k,v) svs.race_demos[i].meta_data_realsize = SNAP_SetDemoMetaKeyValue(svs.race_demos[i].meta_data, sizeof(svs.race_demos[i].meta_data), svs.race_demos[i].meta_data_realsize, k, v)\n",
    "SV_SetDemoMetaKeyValue macro")

# --- 2. sv_init.c: allocate alongside the client slots, free with them --------
sub(INIT,
    "\tsvs.client_entities.entities = Mem_Alloc( sv_mempool, sizeof( entity_state_t ) * svs.client_entities.num_entities );\n",
    "\tsvs.client_entities.entities = Mem_Alloc( sv_mempool, sizeof( entity_state_t ) * svs.client_entities.num_entities );\n"
    "\t// " + MARK + "\n"
    "\tsvs.race_demos = Mem_Alloc( sv_mempool, sizeof( server_static_demo_t )*sv_maxclients->integer );\n",
    "client_entities alloc")

sub(INIT,
    "\tif( svs.client_entities.entities )\n"
    "\t{\n"
    "\t\tMem_Free( svs.client_entities.entities );\n"
    "\t\tmemset( &svs.client_entities, 0, sizeof( svs.client_entities ) );\n"
    "\t}\n",
    "\tif( svs.client_entities.entities )\n"
    "\t{\n"
    "\t\tMem_Free( svs.client_entities.entities );\n"
    "\t\tmemset( &svs.client_entities, 0, sizeof( svs.client_entities ) );\n"
    "\t}\n"
    "\n"
    "\t// " + MARK + "\n"
    "\tif( svs.race_demos )\n"
    "\t{\n"
    "\t\tMem_Free( svs.race_demos );\n"
    "\t\tsvs.race_demos = NULL;\n"
    "\t}\n",
    "client_entities free")

# --- 3. sv_main.c: a snap per open race demo, every frame ---------------------
sub(MAIN,
    "\t\t// write snap to server demo file\n"
    "\t\tSV_Demo_WriteSnap();\n",
    "\t\t// write snap to server demo file\n"
    "\t\tSV_Demo_WriteSnap();\n"
    "\n"
    "\t\t// " + MARK + " - write snap to the per-client demo files\n"
    "\t\tSV_RaceDemo_WriteSnap();\n",
    "SV_Demo_WriteSnap call")

# --- 4. sv_send.c: mirror reliable server commands into each recording --------
# A demo is only a faithful replay if it carries the same reliable commands the
# live client got, so each send site gets a matching write into that client's
# open recording (svs.race_demos[i].client is a synthetic client_t for exactly
# this). Indexed by playerNum in the single-client path and by slot in the
# broadcast loop - the same split racemod_2.1 uses.
sub(SEND,
    "\t\tif( cl->state < CS_CONNECTING )\n"
    "\t\t\treturn;\n"
    "\t\tSV_AddServerCommand( cl, message );\n"
    "\t\treturn;\n",
    "\t\tif( cl->state < CS_CONNECTING )\n"
    "\t\t\treturn;\n"
    "\t\tSV_AddServerCommand( cl, message );\n"
    "\n"
    "\t\t// " + MARK + " - add to this client's demo\n"
    "\t\tif( svs.race_demos[cl->edict->r.client->ps.playerNum].file )\n"
    "\t\t\tSV_AddServerCommand( &svs.race_demos[cl->edict->r.client->ps.playerNum].client, message );\n"
    "\n"
    "\t\treturn;\n",
    "single-client SV_AddServerCommand")

sub(SEND,
    "\t\tif( client->state < CS_CONNECTING )\n"
    "\t\t\tcontinue;\n"
    "\t\tSV_AddServerCommand( client, message );\n"
    "\t}\n",
    "\t\tif( client->state < CS_CONNECTING )\n"
    "\t\t\tcontinue;\n"
    "\t\tSV_AddServerCommand( client, message );\n"
    "\n"
    "\t\t// " + MARK + " - add to this client's demo\n"
    "\t\tif( svs.race_demos[i].file )\n"
    "\t\t\tSV_AddServerCommand( &svs.race_demos[i].client, message );\n"
    "\t}\n",
    "broadcast SV_AddServerCommand")

# --- 5. sv_game.c: the same for game commands --------------------------------
sub(GAME,
    "\t\t\tif( client->state < CS_SPAWNED )\n"
    "\t\t\t\tcontinue;\n"
    "\t\t\tSV_AddGameCommand( client, cmd );\n"
    "\t\t}\n",
    "\t\t\tif( client->state < CS_SPAWNED )\n"
    "\t\t\t\tcontinue;\n"
    "\t\t\tSV_AddGameCommand( client, cmd );\n"
    "\n"
    "\t\t\t// " + MARK + " - add to this client's demo\n"
    "\t\t\tif( svs.race_demos[i].file )\n"
    "\t\t\t\tSV_AddGameCommand( &svs.race_demos[i].client, cmd );\n"
    "\t\t}\n",
    "broadcast SV_AddGameCommand")

sub(GAME,
    "\t\tif( client->state < CS_SPAWNED )\n"
    "\t\t\treturn;\n"
    "\n"
    "\t\tSV_AddGameCommand( client, cmd );\n"
    "\t}\n",
    "\t\tif( client->state < CS_SPAWNED )\n"
    "\t\t\treturn;\n"
    "\n"
    "\t\tSV_AddGameCommand( client, cmd );\n"
    "\n"
    "\t\t// " + MARK + " - add to this client's demo\n"
    "\t\tif( svs.race_demos[i - 1].file )\n"
    "\t\t\tSV_AddGameCommand( &svs.race_demos[i - 1].client, cmd );\n"
    "\t}\n",
    "single-client SV_AddGameCommand")

# --- 6. sv_ccmds.c: the console commands the AS natives drive -----------------
sub(CCMDS,
    '\tCmd_AddCommand( "serverrecordpurge", SV_Demo_Purge_f );\n',
    '\tCmd_AddCommand( "serverrecordpurge", SV_Demo_Purge_f );\n'
    "\t// " + MARK + " - driven by Client::demoStart/demoStop/demoCancel\n"
    '\tCmd_AddCommand( "racerecord", SV_RaceDemo_Start_f );\n'
    '\tCmd_AddCommand( "racerecordstop", SV_RaceDemo_Stop_f );\n'
    '\tCmd_AddCommand( "racerecordcancel", SV_RaceDemo_Cancel_f );\n'
    '\tCmd_AddCommand( "racerecordpurge", SV_RaceDemo_Purge_f );\n',
    "serverrecord* registration")

sub(CCMDS,
    '\tCmd_RemoveCommand( "serverrecordpurge" );\n',
    '\tCmd_RemoveCommand( "serverrecordpurge" );\n'
    "\t// " + MARK + "\n"
    '\tCmd_RemoveCommand( "racerecord" );\n'
    '\tCmd_RemoveCommand( "racerecordstop" );\n'
    '\tCmd_RemoveCommand( "racerecordcancel" );\n'
    '\tCmd_RemoveCommand( "racerecordpurge" );\n',
    "serverrecord* unregistration")

print("patched: svs.race_demos array + prototypes (server.h)")
print("patched: alloc/free (sv_init.c), per-frame snap (sv_main.c)")
print("patched: reliable-command mirroring (sv_send.c, sv_game.c)")
print("patched: racerecord* console commands (sv_ccmds.c)")
print("racedemo-subsystem patch applied")
