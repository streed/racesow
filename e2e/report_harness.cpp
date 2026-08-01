/*
 * E2E harness: drives the REAL g_rs_api.cpp (compiled and linked next to this
 * file by e2e/run.sh) the same way the hrace gametype does, so the bytes on
 * the wire are exactly what a live game server sends.
 *
 * Usage: report_harness <url> <token> <version> [lingerSeconds] < reports.tsv
 *
 * Each stdin line is one finish, tab-separated, mirroring the arguments
 * racelog.as passes to RS_ApiReportRace:
 *
 *   map \t playerName \t login \t timeMs \t cp1,cp2,... [\t attempts
 *       [\t wallJumps \t dashes \t prejumpFails \t restarts
 *       [\t strafeQuality \t maxSpeed \t startSpeed \t distance \t strafes]]]
 *
 * (login and the checkpoint list may be empty; the trailing counters are
 * optional and default to "omitted", so existing inputs are unchanged).
 * strafeQuality is basis points 0..10000; maxSpeed/startSpeed are ups; both
 * are per-run snapshots. distance/strafes are counter deltas since the last
 * flush. Any of them may be -1 to exercise the native's omit path.
 * lingerSeconds keeps the
 * process alive after EOF, standing in for the game server staying up — the
 * sender's paced 2s retry backoff only applies while the module is loaded; at
 * shutdown the remaining retries drain unpaced. The process exits after the
 * linger; g_rs_api.cpp's library destructor joins the sender thread, which
 * drains the queue before the process ends.
 */
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

// MUST stay byte-identical to the definition in server/enginepatches/g_rs_api.cpp
// (and to the declaration patch-api-natives.py injects into g_ascript.cpp) —
// C++ mangles the parameter list into the symbol, so any drift here surfaces as
// an "undefined reference to RS_ApiReportRace(...)" at link time, not as a
// compile error at the call site.
void RS_ApiReportRace( const char *url, const char *token, const char *version,
	const char *mapname, const char *player, const char *login,
	int timeMs, int attemptsSinceLast, const char *cpsCsv,
	int wallJumps, int dashes, int prejumpFails, int restarts,
	int strafeQuality, int maxSpeed, int startSpeed, int distance, int strafes );

// Split on single tabs, preserving empty fields (strtok would collapse them).
static std::vector<std::string> splitTabs( const char *line )
{
	std::vector<std::string> out;
	std::string cur;
	for( const char *p = line; *p && *p != '\n' && *p != '\r'; p++ ) {
		if( *p == '\t' ) {
			out.push_back( cur );
			cur.clear();
		} else {
			cur += *p;
		}
	}
	out.push_back( cur );
	return out;
}

int main( int argc, char **argv )
{
	if( argc != 4 && argc != 5 ) {
		fprintf( stderr, "usage: %s <url> <token> <version> [lingerSeconds] < reports.tsv\n", argv[0] );
		return 2;
	}

	char line[4096];
	int queued = 0;
	while( fgets( line, sizeof( line ), stdin ) ) {
		if( line[0] == '\0' || line[0] == '\n' || line[0] == '#' )
			continue;
		std::vector<std::string> f = splitTabs( line );
		if( f.size() < 5 || f.size() > 15 ) {
			fprintf( stderr, "harness: bad line (want 5-15 tab-separated fields): %s", line );
			return 2;
		}
		// optional 6th field: attempts since the player's last flush
		// (racelog.as counts starts and attaches them the same way)
		int attempts = f.size() >= 6 ? atoi( f[5].c_str() ) : 1;
		// optional 7th-10th fields: movement metrics; -1 => omit from the payload
		int wallJumps   = f.size() >= 7  ? atoi( f[6].c_str() ) : -1;
		int dashes      = f.size() >= 8  ? atoi( f[7].c_str() ) : -1;
		int prejumpFails= f.size() >= 9  ? atoi( f[8].c_str() ) : -1;
		int restarts    = f.size() >= 10 ? atoi( f[9].c_str() ) : -1;
		// optional 11th-13th: per-run snapshots (strafe quality in basis points,
		// max/start speed in ups) stored on the finish row, never summed.
		int strafeQuality = f.size() >= 11 ? atoi( f[10].c_str() ) : -1;
		int maxSpeed      = f.size() >= 12 ? atoi( f[11].c_str() ) : -1;
		int startSpeed    = f.size() >= 13 ? atoi( f[12].c_str() ) : -1;
		// optional 14th-15th: counter deltas since the last flush, summed into
		// the run tally like the movement metrics above.
		int distance      = f.size() >= 14 ? atoi( f[13].c_str() ) : -1;
		int strafes       = f.size() >= 15 ? atoi( f[14].c_str() ) : -1;
		RS_ApiReportRace( argv[1], argv[2], argv[3],
			f[0].c_str(), f[1].c_str(), f[2].c_str(),
			atoi( f[3].c_str() ), attempts, f[4].c_str(),
			wallJumps, dashes, prejumpFails, restarts,
			strafeQuality, maxSpeed, startSpeed, distance, strafes );
		queued++;
	}
	int linger = argc == 5 ? atoi( argv[4] ) : 0;
	if( linger > 0 ) {
		fprintf( stderr, "harness: queued %d report(s), lingering %ds...\n", queued, linger );
		std::this_thread::sleep_for( std::chrono::seconds( linger ) );
	}
	fprintf( stderr, "harness: queued %d report(s), draining...\n", queued );
	return 0;
}
