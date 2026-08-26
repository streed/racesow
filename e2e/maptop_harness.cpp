/*
 * E2E harness for the "/top <map>" path: drives the REAL RS_ApiFetchMapTop /
 * RS_ApiPollMapTop / RS_MapTopText (g_rs_api.cpp, compiled and linked next to
 * this file by e2e/run.sh) exactly the way hrace/apitop.as does — fetch on a
 * player slot, poll until an outcome arrives, then read that slot's board.
 *
 * Usage: maptop_harness <url> <token> <timeoutSeconds> <map>:<slot> [<map>:<slot> ...]
 *
 * Several pairs may be given and are ALL queued before any polling starts, which
 * is the point: two players asking about two different maps at the same moment is
 * exactly what the per-slot design exists for, and a shared buffer would show up
 * here as one board answering both slots. ':' is not in the native's map-name
 * allowlist, so splitting on it is unambiguous.
 *
 * Unlike topfetch_harness this writes NO file — an arbitrary map's board is held
 * in memory and handed to the asking player — so each board is printed to stdout
 * framed by a "=== <slot> <map> <outcome>" line for the caller to assert against.
 * An EMPTY board is a legitimate "no records" and is reported as ok.
 *
 * Exit: 0 = every slot got a board, 2 = some slot's fetch failed for good,
 * 1 = some slot timed out or was refused outright (an unsafe map name never
 * reaches the network).
 */
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

void RS_ApiFetchMapTop( const char *url, const char *token, const char *mapname, int playerNum );
int RS_ApiPollMapTop( int playerNum );
const char *RS_MapTopText( int playerNum );

struct Want {
	std::string map;
	int slot;
	int outcome; // 0 pending, 1 ok, -1 failed
};

int main( int argc, char **argv )
{
	if( argc < 5 ) {
		fprintf( stderr, "usage: %s <url> <token> <timeoutSeconds> <map>:<slot> ...\n", argv[0] );
		return 3;
	}
	const char *url = argv[1], *token = argv[2];
	int timeout = atoi( argv[3] );

	std::vector<Want> wants;
	for( int i = 4; i < argc; i++ ) {
		const char *colon = strrchr( argv[i], ':' );
		if( !colon ) {
			fprintf( stderr, "maptop: bad pair '%s' (want <map>:<slot>)\n", argv[i] );
			return 3;
		}
		Want w;
		w.map.assign( argv[i], colon - argv[i] );
		w.slot = atoi( colon + 1 );
		w.outcome = 0;
		wants.push_back( w );
	}

	// Queue every request first, then poll — see the header comment.
	for( size_t i = 0; i < wants.size(); i++ )
		RS_ApiFetchMapTop( url, token, wants[i].map.c_str(), wants[i].slot );

	int rc = 0;
	size_t settled = 0;
	for( int waited = 0; waited < timeout * 20 && settled < wants.size(); waited++ ) {
		for( size_t i = 0; i < wants.size(); i++ ) {
			if( wants[i].outcome != 0 )
				continue;
			int r = RS_ApiPollMapTop( wants[i].slot );
			if( r == 0 )
				continue;
			wants[i].outcome = r;
			settled++;
			if( r == 1 ) {
				printf( "=== %d %s ok\n", wants[i].slot, wants[i].map.c_str() );
				fputs( RS_MapTopText( wants[i].slot ), stdout );
			} else {
				printf( "=== %d %s failed\n", wants[i].slot, wants[i].map.c_str() );
				rc = 2;
			}
		}
		if( settled < wants.size() )
			std::this_thread::sleep_for( std::chrono::milliseconds( 50 ) );
	}

	for( size_t i = 0; i < wants.size(); i++ ) {
		if( wants[i].outcome == 0 ) {
			printf( "=== %d %s timeout\n", wants[i].slot, wants[i].map.c_str() );
			fprintf( stderr, "maptop: slot %d (%s) timed out with no outcome\n",
				wants[i].slot, wants[i].map.c_str() );
			rc = 1;
		}
	}
	fflush( stdout );
	return rc;
}
