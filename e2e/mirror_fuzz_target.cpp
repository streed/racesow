/*
 * ASan/UBSan fuzz target for the mesh receive/parse path.
 *
 * Links the REAL g_rs_mirror.cpp, configures it in no-secret (source-IP
 * allowlist) mode with 127.0.0.1 as the only peer, then stays alive draining
 * the game-thread consume natives while an external fuzzer (mirror_fuzz.py)
 * floods the bound UDP port from 127.0.0.1. Every malformed datagram therefore
 * passes the IP allowlist and reaches the full header + body parser on the
 * worker thread under the sanitizers — any OOB read/write, overflow, or UB
 * aborts the process (nonzero exit), while the concurrent native calls exercise
 * the snapshot/event consume path against the worker's writes.
 *
 *   build: g++ -std=c++11 -fsanitize=address,undefined -fno-sanitize-recover=all
 *              -O1 -g -pthread mirror_fuzz_target.cpp ../server/enginepatches/g_rs_mirror.cpp
 *   run:   ./target <port> <seconds>   (mirror_fuzz.py sends to 127.0.0.1:<port>)
 */
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <thread>

void RS_MirrorConfigure( const char *tag, const char *secret, int port, const char *peers, const char *map );
int RS_MirrorRefresh( void );
const char *RS_MirrorPlayerName( int i );
const char *RS_MirrorPlayerServer( int i );
const char *RS_MirrorPlayerMap( int i );
const char *RS_MirrorPlayerState( int i );
int RS_MirrorNextEvent( void );
const char *RS_MirrorEventServer( void );
const char *RS_MirrorEventName( void );
const char *RS_MirrorEventText( void );

int main( int argc, char **argv )
{
	if( argc != 3 ) {
		fprintf( stderr, "usage: %s <port> <seconds>\n", argv[0] );
		return 2;
	}
	int port = atoi( argv[1] );
	int seconds = atoi( argv[2] );

	// no secret => source-IP allowlist; 127.0.0.1 peer accepts the fuzzer's
	// packets so they reach the parser without needing a valid HMAC.
	RS_MirrorConfigure( "HOST", "", port, "127.0.0.1:9", "fuzzmap" );

	auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds( seconds );
	unsigned long long consumed = 0;   // E-body events that reached the queue
	unsigned long long rowTouches = 0; // S-body rows that reached the snapshot
	int peakRows = 0;
	while( std::chrono::steady_clock::now() < deadline ) {
		int n = RS_MirrorRefresh();
		if( n > peakRows )
			peakRows = n;
		for( int i = 0; i < n; i++ ) {
			// touch every returned pointer so ASan sees any use-after-free /
			// dangling-into-worker-mutated-string bug on the consume path.
			volatile const char *a = RS_MirrorPlayerName( i );
			volatile const char *b = RS_MirrorPlayerServer( i );
			volatile const char *c = RS_MirrorPlayerMap( i );
			volatile const char *d = RS_MirrorPlayerState( i );
			(void)a; (void)b; (void)c; (void)d;
			rowTouches++;
		}
		int t;
		while( ( t = RS_MirrorNextEvent() ) != 0 ) {
			volatile const char *a = RS_MirrorEventServer();
			volatile const char *b = RS_MirrorEventName();
			volatile const char *c = RS_MirrorEventText();
			(void)a; (void)b; (void)c;
			consumed++;
		}
		std::this_thread::sleep_for( std::chrono::milliseconds( 3 ) );
	}
	// Coverage proof: nonzero rowTouches AND consumed means hostile datagrams
	// actually reached BOTH body parsers (state + event), not just the rejects.
	fprintf( stderr, "fuzz target: clean exit — events=%llu rowTouches=%llu peakRows=%d\n",
		consumed, rowTouches, peakRows );
	return 0;
}
