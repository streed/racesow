/*
 * E2E harness for the generated-map sync: drives the REAL RS_ApiFetchBlocked /
 * RS_ApiPollBlocked / RS_BlockedListText (g_rs_api.cpp, compiled and linked
 * next to this file by e2e/run.sh) the way hrace/blockedmaps.as does when
 * rs_api_mapsync_url is set: one fetch with the server's token, then poll
 * until an outcome arrives, then print the list text the gametype would parse.
 *
 * Usage: mapsync_harness <url> <token> <timeoutSeconds>
 *
 * Exit codes: 0 = poll returned 1 (list printed on stdout), 2 = poll returned
 * -1 (fetch failed for good: the gametype falls back to the public list),
 * 1 = timed out with no outcome.
 */
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <thread>

void RS_ApiFetchBlocked( const char *url, const char *token );
int RS_ApiPollBlocked( void );
const char *RS_BlockedListText( void );

int main( int argc, char **argv )
{
	if( argc < 4 ) {
		fprintf( stderr, "usage: %s <url> <token> <timeoutSeconds>\n", argv[0] );
		return 64;
	}

	RS_ApiFetchBlocked( argv[1], argv[2] );

	int timeoutMs = atoi( argv[3] ) * 1000;
	for( int waited = 0; waited < timeoutMs; waited += 50 ) {
		int r = RS_ApiPollBlocked();
		if( r == 1 ) {
			fputs( RS_BlockedListText(), stdout );
			return 0;
		}
		if( r == -1 ) {
			printf( "failed\n" );
			return 2;
		}
		std::this_thread::sleep_for( std::chrono::milliseconds( 50 ) );
	}
	printf( "timeout\n" );
	return 1;
}
