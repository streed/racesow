/*
 * E2E harness: drives the REAL g_rs_mirror.cpp (compiled and linked next to
 * this file, same pattern as report_harness.cpp) the way the hrace gametype
 * does, so the datagrams on the wire are exactly what a live server sends.
 * Two harness processes peered at each other form a real two-node mesh.
 *
 * Usage: mirror_harness <tag> <port> <peers> <secret> <map> <player> <seconds>
 *
 * Publishes <player> at 10Hz with a moving origin, says one chat line at
 * ~0.5s, and prints everything received:
 *
 *   EVENT <type> <server> <name> <text>     (type: 1 chat, 2 join, 3 leave)
 *   SNAP <count> [<server> <name> <map> | ...]   (once per second)
 *
 * Exits 0 after <seconds>; the library destructor joins the worker thread.
 */
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <thread>

void RS_MirrorConfigure( const char *tag, const char *secret, int port, const char *peers, const char *map );
void RS_MirrorBegin( void );
void RS_MirrorPlayer( const char *name, const float *origin, const float *angles, const float *velocity, int flags );
void RS_MirrorEnd( void );
void RS_MirrorEvent( const char *kind, const char *name, const char *text );
int RS_MirrorRefresh( void );
const char *RS_MirrorPlayerName( int i );
const char *RS_MirrorPlayerServer( int i );
const char *RS_MirrorPlayerMap( int i );
const char *RS_MirrorPlayerState( int i );
int RS_MirrorNextEvent( void );
const char *RS_MirrorEventServer( void );
const char *RS_MirrorEventName( void );
const char *RS_MirrorEventText( void );
void RS_MirrorLocalChat( const char *name, const char *text );

int main( int argc, char **argv )
{
	if( argc != 8 ) {
		fprintf( stderr, "usage: %s <tag> <port> <peers> <secret> <map> <player> <seconds>\n", argv[0] );
		return 2;
	}
	const char *tag = argv[1];
	int port = atoi( argv[2] );
	const char *peers = argv[3];
	const char *secret = argv[4];
	const char *map = argv[5];
	const char *player = argv[6];
	int seconds = atoi( argv[7] );

	RS_MirrorConfigure( tag, secret, port, peers, map );
	RS_MirrorEvent( "J", player, "" );

	char chat[128];
	snprintf( chat, sizeof( chat ), "hello from %s", tag );
	bool chatted = false;

	for( int tick = 0; tick < seconds * 10; tick++ ) {
		float t = tick * 0.1f;
		float origin[3] = { 100.0f + t * 50.0f, 200.0f, 64.0f };
		float angles[3] = { 0.0f, 90.0f, 0.0f };
		float velocity[3] = { 500.0f, 0.0f, 0.0f };

		RS_MirrorBegin();
		RS_MirrorPlayer( player, origin, angles, velocity, 1 );
		RS_MirrorEnd();

		if( !chatted && tick >= 5 ) {
			RS_MirrorLocalChat( player, chat ); // exercises the g_cmds.cpp entry point
			chatted = true;
		}

		int n = RS_MirrorRefresh();
		int type;
		while( ( type = RS_MirrorNextEvent() ) != 0 )
			printf( "EVENT %d %s %s %s\n", type, RS_MirrorEventServer(), RS_MirrorEventName(), RS_MirrorEventText() );
		if( tick % 10 == 9 ) {
			printf( "SNAP %d", n );
			for( int i = 0; i < n; i++ )
				printf( " | %s %s %s [%s]", RS_MirrorPlayerServer( i ), RS_MirrorPlayerName( i ),
					RS_MirrorPlayerMap( i ), RS_MirrorPlayerState( i ) );
			printf( "\n" );
		}
		fflush( stdout );
		std::this_thread::sleep_for( std::chrono::milliseconds( 100 ) );
	}

	RS_MirrorEvent( "L", player, "" );
	std::this_thread::sleep_for( std::chrono::milliseconds( 300 ) );
	return 0;
}
