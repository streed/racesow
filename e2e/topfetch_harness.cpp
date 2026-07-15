/*
 * E2E harness for the live top-scores fetch path: drives the REAL
 * RS_ApiFetchTop / RS_ApiPollTop (g_rs_api.cpp, compiled and linked next to
 * this file by e2e/run.sh) exactly the way hrace/apitop.as does — fetch,
 * then poll until an outcome arrives.
 *
 * Usage: topfetch_harness <url> <token> <map> <timeoutSeconds>
 *
 * WARSOW_DIR / FS_GAME select the write directory (the same env contract the
 * native uses in the game container). Exit codes: 0 = poll returned 1 (fresh
 * payload swapped into the topscores file), 2 = poll returned -1 (fetch
 * failed for good), 1 = timed out with no outcome.
 */
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <thread>

void RS_ApiFetchTop( const char *url, const char *token, const char *mapname );
int RS_ApiPollTop( void );

int main( int argc, char **argv )
{
	if( argc < 5 ) {
		fprintf( stderr, "usage: %s <url> <token> <map> <timeoutSeconds>\n", argv[0] );
		return 64;
	}

	RS_ApiFetchTop( argv[1], argv[2], argv[3] );

	int timeoutMs = atoi( argv[4] ) * 1000;
	for( int waited = 0; waited < timeoutMs; waited += 50 ) {
		int r = RS_ApiPollTop();
		if( r == 1 ) {
			printf( "fresh\n" );
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
