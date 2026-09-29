#!/usr/bin/env python3
"""sv_mapscan: pick up new map packs while the server runs, no restart.

Why
---
A new .pk3 used to need a server restart: the engine lists each game
directory's packs at boot, and nothing looked again. Generated maps
(tools/mapgen) arrive at any time, and with the shared map store
(docs/shared-maps.md) they appear on every box the moment they are added on
one. Restarting every server for each new map is the cost this removes.

The stock engine already knows how to do the hard part. ML_Update()
(qcommon/mlist.c) runs FS_Rescan(), which re-lists every base path's game
directories, loads any pack it has not seen, and adds the maps inside to the
map list. SV_Map_f already calls it when asked for an unknown map, and every
racemod vote path enumerates that same list (ML_GetMapByNum, see
hrace/utils.as GetMapsByPattern). The only thing missing is something that
calls it without being asked for a map by name. This patch adds that:

  * sv_mapscan <seconds>  (default 0 = off). While a map is running, rescan
    at most this often. The entrypoint sets it (MAPSCAN_SECONDS).
  * mapscan               console/rcon command: rescan now and report.

Both print one line when they find something, so the log says when a map
became available:
    mapscan: +1 map(s), 4303 on the list

One trap is closed on purpose. FS_Rescan raises FS_NOTIFY_NEWPAKS, and stock
SV_CheckPostUpdateRestart() answers that flag by restarting the current map
after five idle minutes: a leftover of the retired auto-updater. A rescan
triggered here clears the flag, so finding a new map never restarts anything.

Cost: one directory listing per base path per scan. On the shared store this
is an NFS readdir. It runs on the server thread, so the mount must be `soft`
with a short timeout (docs/shared-maps.md): a hung server must turn into a
failed scan, not a frozen game.

Edits server/sv_main.c only. Run from the qfusion source/ directory. Exits
non-zero (failing the image build) if an anchor is not found exactly once.
"""
import sys

PATH = "server/sv_main.c"


def patch(src, old, new, what):
    if src.count(old) != 1:
        sys.exit("FATAL: %s anchor not found exactly once in %s" % (what, PATH))
    print("patched:", what)
    return src.replace(old, new)


# Explicit utf-8 + surrogateescape: the 18.04 build container runs a POSIX
# (ASCII) locale. All inserted text is ASCII.
src = open(PATH, encoding="utf-8", errors="surrogateescape").read()

# --- 1. cvar + scan function, before SV_Frame ---------------------------------
FRAME_ANCHOR = "/*\n* SV_Frame\n*/\nvoid SV_Frame( int realmsec, int gamemsec )\n"
SCAN = r'''/*
* racesow-docker: runtime map-pack rescans (see enginepatches/patch-mapscan.py)
*/
static cvar_t *sv_mapscan;
static unsigned int sv_mapscan_last;

static int SV_MapScan_Count( void )
{
	int n = 0;
	while( ML_GetMapByNum( n, NULL, 0 ) )
		n++;
	return n;
}

// Returns how many maps the scan added (0 when nothing new was found).
static int SV_MapScan( bool verbose )
{
	int before, after;

	sv_mapscan_last = Sys_Milliseconds();
	before = SV_MapScan_Count();
	if( !ML_Update() )
	{
		if( verbose )
			Com_Printf( "mapscan: no new map packs, %d on the list\n", before );
		return 0;
	}
	// Found something: that raised FS_NOTIFY_NEWPAKS, which the stock
	// post-update logic would answer by restarting the map when idle.
	FS_RemoveNotifications( FS_NOTIFY_NEWPAKS );
	after = SV_MapScan_Count();
	Com_Printf( "mapscan: +%d map(s), %d on the list\n", after - before, after );
	return after - before;
}

static void SV_MapScan_f( void )
{
	SV_MapScan( true );
}

static void SV_MapScan_Frame( void )
{
	unsigned int interval;

	if( !sv_mapscan || sv_mapscan->integer <= 0 || sv.state != ss_game )
		return;
	interval = (unsigned int)sv_mapscan->integer * 1000u;
	// Unsigned difference, so the ~49-day wrap of Sys_Milliseconds is harmless.
	if( Sys_Milliseconds() - sv_mapscan_last < interval )
		return;
	SV_MapScan( false );
}

'''
src = patch(src, FRAME_ANCHOR, SCAN + FRAME_ANCHOR, "SV_MapScan")

# --- 2. run it once per frame, after the stock post-update check ------------
TAIL_ANCHOR = "\tSV_CheckAutoUpdate();\n\n\tSV_CheckPostUpdateRestart();\n}\n"
src = patch(src, TAIL_ANCHOR,
            "\tSV_CheckAutoUpdate();\n\n\tSV_CheckPostUpdateRestart();\n\n"
            "\tSV_MapScan_Frame(); // racesow-docker: patch-mapscan.py\n}\n",
            "SV_MapScan_Frame call")

# --- 3. register the cvar and the command -------------------------------------
# Warsow defaults this to "wdm1" and Warfork to "wfdm1"; the line is otherwise
# byte-identical, so one patch serves both engines (as patch-demolist-split.py
# already does). Pick whichever spelling this tree actually has.
INIT_CANDIDATES = [
    '\tsv_defaultmap =\t\t    Cvar_Get( "sv_defaultmap", "%s", CVAR_ARCHIVE );\n' % d
    for d in ("wdm1", "wfdm1")
]
INIT_ANCHOR = next((a for a in INIT_CANDIDATES if src.count(a) == 1), None)
if INIT_ANCHOR is None:
    sys.exit("FATAL: sv_defaultmap registration anchor not found exactly once in %s" % PATH)
src = patch(src, INIT_ANCHOR, INIT_ANCHOR +
            '\t// racesow-docker: runtime map-pack rescans (patch-mapscan.py)\n'
            '\tsv_mapscan = Cvar_Get( "sv_mapscan", "0", 0 );\n'
            '\tsv_mapscan_last = Sys_Milliseconds();\n'
            '\tCmd_AddCommand( "mapscan", SV_MapScan_f );\n',
            "sv_mapscan registration")

open(PATH, "w", encoding="utf-8", errors="surrogateescape").write(src)
