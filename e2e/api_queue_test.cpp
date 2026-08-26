/*
 * Unit tests for the API request queue's eviction ladder (makeRoomLocked) and
 * the map-name gate the player-facing fetch natives rely on (rsMapNameOk), both
 * in server/enginepatches/g_rs_api.cpp.
 *
 * The queue is bounded at QUEUE_MAX, and what it throws away when it is full
 * decides whether a finished race survives an outage. That choice used to be
 * thirteen hand-copied allowlists, one per RS_ApiFetch* entry point; this test
 * pins the single ladder that replaced them.
 *
 * makeRoomLocked lives in g_rs_api.cpp's anonymous namespace — deliberately, it
 * is not part of the native ABI — so this TU #includes the module rather than
 * linking against it. Nothing here starts the worker thread (ensureStarted is
 * never called), so the queue is ours alone and every assertion is exact.
 *
 * Built and run by e2e/run.sh; standalone:
 *   g++ -std=c++11 -o /tmp/apiq e2e/api_queue_test.cpp -lcurl -pthread && /tmp/apiq
 */
#include "../server/enginepatches/g_rs_api.cpp"

#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <unistd.h>

static int failures = 0;

static void check( bool ok, const char *what )
{
	printf( "%s %s\n", ok ? "ok  " : "FAIL", what );
	if( !ok )
		failures++;
}

static ApiRequest mk( int type, const char *url, const char *body )
{
	return ApiRequest{ url, "tok", body, 0, type, "", 0, 0 };
}

// Count how many of `type` are left in the queue.
static size_t countType( ApiState &s, int type )
{
	size_t n = 0;
	for( size_t i = 0; i < s.queue.size(); i++ )
		if( s.queue[i].type == type )
			n++;
	return n;
}

static void fill( ApiState &s, int type, size_t n, const char *body )
{
	for( size_t i = 0; i < n; i++ )
		s.queue.push_back( mk( type, "http://127.0.0.1:1/api/ingest", body ) );
}

static std::string readSpool()
{
	return readFileAll( spoolPath() );
}

int main()
{
	// Keep the spool inside a scratch dir; spoolPath() reads these two.
	char tmpl[] = "/tmp/rs_api_queue_test_XXXXXX";
	const char *dir = mkdtemp( tmpl );
	assert( dir );
	setenv( "WARSOW_DIR", dir, 1 );
	setenv( "FS_GAME", "racemod", 1 );
	std::string racelog = std::string( dir ) + "/racemod/racelog";
	// spoolReport fopen()s the file directly, so the directory has to exist.
	if( system( ( "mkdir -p '" + racelog + "'" ).c_str() ) != 0 )
		return 77;

	// --- 1. under the cap: nothing is touched --------------------------------
	{
		ApiState s;
		fill( s, REQ_POST_REPORT, 10, "{\"r\":1}" );
		makeRoomLocked( &s );
		check( s.queue.size() == 10, "below QUEUE_MAX: queue untouched" );
	}

	// --- 2. a fetch is evicted before any report is spooled ------------------
	// The regression this ladder exists for: RS_ApiFetchTop's old allowlist
	// named only TOPSCORES and PLAYERREC, so a queue holding (say) a MOTD fetch
	// looked "all reports" to it and it spooled a finish instead.
	{
		ApiState s;
		remove( spoolPath().c_str() );
		fill( s, REQ_POST_REPORT, QUEUE_MAX - 1, "{\"r\":2}" );
		s.queue.push_back( mk( REQ_GET_MOTD, "http://127.0.0.1:1/api/game/motd", "" ) );
		makeRoomLocked( &s );
		check( s.queue.size() == QUEUE_MAX - 1, "at cap: one entry evicted" );
		check( countType( s, REQ_GET_MOTD ) == 0, "the MOTD fetch is the one evicted" );
		check( countType( s, REQ_POST_REPORT ) == QUEUE_MAX - 1, "every report kept" );
		check( readSpool().empty(), "no report spooled while a fetch was available" );
	}

	// --- 3. every fetch type is evictable ------------------------------------
	{
		const int fetches[] = { REQ_GET_TOPSCORES, REQ_GET_GHOST, REQ_GET_BLOCKED,
			REQ_GET_MOTD, REQ_GET_ANNOUNCE, REQ_GET_RANKS, REQ_GET_MAPWEAPONS,
			REQ_GET_LASTMAPS, REQ_GET_PLAYERREC, REQ_GET_SAVEDSTART,
			REQ_GET_AWARDS, REQ_GET_TOURNEY, REQ_GET_MAPTOP };
		bool all = true;
		for( size_t k = 0; k < sizeof( fetches ) / sizeof( fetches[0] ); k++ ) {
			ApiState s;
			remove( spoolPath().c_str() );
			fill( s, REQ_POST_REPORT, QUEUE_MAX - 1, "{\"r\":3}" );
			s.queue.push_back( mk( fetches[k], "http://127.0.0.1:1/x", "" ) );
			makeRoomLocked( &s );
			if( countType( s, fetches[k] ) != 0 || !readSpool().empty() )
				all = false;
		}
		check( all, "all 13 fetch types evict ahead of a report" );
	}

	// --- 4. nothing but reports: the OLDEST is spooled, not dropped ----------
	{
		ApiState s;
		remove( spoolPath().c_str() );
		fill( s, REQ_POST_REPORT, QUEUE_MAX, "{\"r\":\"oldest\"}" );
		s.queue.front().body = "{\"r\":\"THEOLDEST\"}";
		makeRoomLocked( &s );
		check( s.queue.size() == QUEUE_MAX - 1, "at cap, all reports: one evicted" );
		std::string spool = readSpool();
		check( spool.find( "THEOLDEST" ) != std::string::npos,
			"the oldest report went to the spool for redelivery" );
	}

	// --- 5. a tournament join at the FRONT is not silently discarded ---------
	// spoolReport() refuses to write a join (replaying a sign-up on the next
	// boot would answer a slot whose occupant has left), so the old
	// "spool the front, then pop it" pair dropped it without a trace.
	{
		ApiState s;
		remove( spoolPath().c_str() );
		s.queue.push_back( mk( REQ_POST_TJOIN, "http://127.0.0.1:1/join", "{\"code\":\"RS9K4MTB\"}" ) );
		fill( s, REQ_POST_REPORT, QUEUE_MAX - 1, "{\"r\":\"keepme\"}" );
		makeRoomLocked( &s );
		check( countType( s, REQ_POST_TJOIN ) == 1, "the queued tournament join survives" );
		check( countType( s, REQ_POST_REPORT ) == QUEUE_MAX - 2, "a report was evicted instead" );
		check( readSpool().find( "keepme" ) != std::string::npos, "and it was spooled, not lost" );
	}

	// --- 6. a queue of nothing but joins: oldest dropped, never spooled ------
	{
		ApiState s;
		remove( spoolPath().c_str() );
		fill( s, REQ_POST_TJOIN, QUEUE_MAX, "{\"code\":\"X\"}" );
		makeRoomLocked( &s );
		check( s.queue.size() == QUEUE_MAX - 1, "all joins: the oldest is dropped" );
		check( readSpool().empty(), "a join is never written to the spool" );
	}

	// --- 7. the map-name gate the player-facing natives lean on --------------
	// RS_ApiFetchTop / RS_ApiFetchGhost / RS_ApiFetchPlayerRecord already used
	// this, but RS_ApiFetchMapTop ("/top <map>") is the first one whose map name
	// comes from a PLAYER rather than from the loaded level, so what it accepts
	// is now player-facing input handling and not just an internal sanity check.
	check( rsMapNameOk( "wrace1" ), "an ordinary map name is accepted" );
	check( rsMapNameOk( "gu3#5-stickupkids" ), "'#' is accepted (a real map has one)" );
	check( rsMapNameOk( "un-dead!020_3" ), "'!' is accepted (a real map has one)" );
	check( rsMapNameOk( "4^3" ), "'^' is accepted (a real map has one)" );
	check( rsMapNameOk( "3ont-p900`archi" ), "'`' is accepted (a real map has one)" );
	check( rsMapNameOk( "wrace1-reversed" ), "the reverse-board suffix is accepted" );

	check( !rsMapNameOk( "" ), "an empty name is refused" );
	check( !rsMapNameOk( NULL ), "a null name is refused" );
	check( !rsMapNameOk( "../../etc/passwd" ), "a traversal is refused" );
	check( !rsMapNameOk( ".hidden" ), "a leading dot is refused" );
	check( !rsMapNameOk( "-rf" ), "a leading dash is refused" );
	check( !rsMapNameOk( "a/b" ), "a path separator is refused" );
	check( !rsMapNameOk( "map;rm -rf /" ), "';' is refused (it separates console commands)" );
	check( !rsMapNameOk( "map$x" ), "'$' is refused" );
	check( !rsMapNameOk( "map&x" ), "'&' is refused" );
	check( !rsMapNameOk( "map\"x" ), "a quote is refused" );
	check( !rsMapNameOk( "map*" ), "a glob character is refused" );
	check( !rsMapNameOk( "a..b" ), "'..' anywhere is refused" );
	check( !rsMapNameOk( std::string( 65, 'a' ).c_str() ), "an over-long name is refused" );

	// --- 8. per-slot polls reject an out-of-range slot ----------------------
	// g_state is still null here (nothing in this test starts the worker), so
	// these also pin the "never started" path returning a benign 0.
	check( RS_ApiPollMapTop( -1 ) == 0, "a negative slot polls 0" );
	check( RS_ApiPollMapTop( ApiState::RS_PLAYERREC_MAX ) == 0, "an over-range slot polls 0" );
	check( std::string( RS_MapTopText( -1 ) ).empty(), "a negative slot reads empty" );
	check( std::string( RS_MapTopText( ApiState::RS_PLAYERREC_MAX ) ).empty(),
		"an over-range slot reads empty" );

	if( system( ( "rm -rf '" + std::string( dir ) + "'" ).c_str() ) != 0 )
		{} // best effort

	if( failures ) {
		printf( "\n%d check(s) FAILED\n", failures );
		return 1;
	}
	printf( "\napi queue + map-name gate: all checks passed\n" );
	return 0;
}
