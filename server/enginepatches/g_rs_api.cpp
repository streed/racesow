/*
 * racesow-docker: direct HTTP reporting of race finishes to the central
 * stats API, straight from the game module — no log-scraping sidecar.
 *
 * This file is copied into source/game/ of the DenMSC racemod_2.1 tree at
 * image build time (the game CMakeLists globs *.cpp) and exposed to the
 * hrace AngelScript gametype as RS_ApiReportRace(...) via a patch to
 * g_ascript.cpp (see patch-api-natives.py). It POSTs the same JSON the
 * stats collector sends to /api/ingest, so the web API is unchanged:
 *
 *   {"version":V,"map":M,"source":"racelog",
 *    "records":[{"name":N,"login":L,"time":T,"checkpoints":[...]}]}
 *
 * Design constraints:
 *  - The game frame must never block: requests are queued and a single
 *    background thread drains them with libcurl.
 *  - The ingest endpoint is idempotent, so fire-and-forget with bounded
 *    retries is safe; permanent (4xx) failures are dropped and logged.
 *  - Logging from the worker uses stderr (thread-safe; lands in the
 *    container log). Engine Com_Printf is not safe off the main thread.
 *  - The .so can be dlclose()d on gametype shutdown; a destructor stops
 *    and joins the worker so no thread outlives the library.
 */

#include <curl/curl.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

enum RequestType {
	REQ_POST_REPORT,   // fire-and-forget race finish -> /api/ingest
	REQ_GET_TOPSCORES, // live top scores -> swapped into the local topscores file
	REQ_GET_GHOST,     // WR ghost trajectory -> parsed into memory (RS_ApiPollGhost)
	REQ_GET_BLOCKED,   // live map blocklist -> stored in memory (RS_ApiPollBlocked)
	REQ_GET_MOTD,      // live message of the day -> stored in memory (RS_ApiPollMotd)
	REQ_GET_ANNOUNCE,  // rotating in-game announcements -> stored in memory (RS_ApiPollAnnounce)
	REQ_GET_RANKS,      // live per-map global ranks -> stored in memory (RS_ApiPollRanks)
	REQ_GET_MAPWEAPONS, // per-map weapon inventory -> stored in memory (RS_ApiPollMapWeapons)
	REQ_GET_LASTMAPS,   // recently-played maps -> stored in memory (RS_ApiPollLastMaps)
	REQ_GET_PLAYERREC,  // one player's PB on the current map -> stored per-slot (RS_ApiPollPlayerRecord)
	REQ_GET_SAVEDSTART  // one player's saved start(s) on the current map -> per-slot (RS_ApiPollSavedStart)
};

// note: no default member initializers — the game module builds as C++11,
// where they would make this a non-aggregate and break brace-initialization
struct ApiRequest {
	std::string url;
	std::string token;
	std::string body;
	int attempts;
	int type;             // RequestType
	std::string filePath; // REQ_GET_TOPSCORES: where the payload lands
	unsigned gen;         // REQ_GET_TOPSCORES / REQ_GET_PLAYERREC: fetch generation (stale = discard)
	int slot;             // REQ_GET_PLAYERREC: which player slot this result belongs to (else 0/unused)
};

constexpr size_t QUEUE_MAX = 256;
// Fetches only: they are fully reproducible on the next refresh interval, so
// burning retries on them is pointless. POST reports are never attempt-capped
// — a report is delivered, or it lands in the on-disk spool (see below).
constexpr int MAX_ATTEMPTS = 3;

// All mutable state lives on the heap behind a raw pointer, NOT in static
// objects. Static C++ objects get their destructors run from the __cxa_atexit
// list BEFORE this translation unit's __attribute__((destructor)) fires (both
// at process exit and, depending on glibc, at dlclose) — with a static
// std::thread that means ~thread() on a still-joinable worker, i.e.
// std::terminate on every clean shutdown. The struct is deliberately never
// freed: after rsApiShutdown joins the worker it is dead weight, and freeing
// it would just reopen the ordering race.
struct ApiState {
	std::mutex mutex;
	std::condition_variable cv;
	std::deque<ApiRequest> queue;
	std::thread worker;
	std::atomic<bool> stop;

	// Top-scores fetch handshake with the script thread. fetchGen is bumped
	// by every RS_ApiFetchTop; a completing request whose gen no longer
	// matches is discarded (the map changed / a newer fetch superseded it).
	// fetchResult is read-and-cleared by RS_ApiPollTop: 0 = nothing new,
	// 1 = fresh payload swapped into the file, -1 = fetch failed for good.
	std::atomic<unsigned> fetchGen;
	std::atomic<int> fetchResult;

	// WR-ghost fetch handshake (same shape as the top-scores one, separate so a
	// ghost fetch and a top-scores fetch never clobber each other's result).
	// The parsed trajectory lives here behind ghostMutex; the script thread
	// copies it out after RS_ApiPollGhost reports 1.
	std::atomic<unsigned> fetchGhostGen;
	std::atomic<int> fetchGhostResult;
	std::mutex ghostMutex;
	std::vector<int> ghostFrames; // flat: 9 ints per frame (x y z p yaw r vx vy vz)
	int ghostFrameCount;
	int ghostHz;
	int ghostTime;
	std::string ghostName; // record holder (raw, may carry ^ colour codes)
	std::string ghostCps;  // checkpoint frame indices, space-separated

	// Blocked-maps fetch handshake (same shape as the top-scores/ghost ones, a
	// separate result so a blocklist fetch never clobbers another fetch's
	// outcome). blockedText holds the raw payload (one lowercased map name per
	// line, possibly empty); the script thread copies it out with
	// RS_BlockedListText after RS_ApiPollBlocked reports 1.
	std::atomic<unsigned> fetchBlockedGen;
	std::atomic<int> fetchBlockedResult;
	std::mutex blockedMutex;
	std::string blockedText;

	// MOTD fetch handshake (same shape again). motdRaw holds the raw payload
	// INCLUDING its "RSMOTD\n" header line: empty therefore means "never
	// fetched", while a bare header means "fetched, admin wants no MOTD" — the
	// distinction keeps a cleared MOTD from being confused with a failure. The
	// worker only signals 1 when the payload actually changed, so the gametype
	// does not rewrite sv_MOTDString every refresh interval. The script thread
	// reads the header-stripped text with RS_MotdText after a poll of 1.
	std::atomic<unsigned> fetchMotdGen;
	std::atomic<int> fetchMotdResult;
	std::mutex motdMutex;
	std::string motdRaw;

	// Announcements fetch handshake (same shape as MOTD). announceRaw holds the
	// raw payload INCLUDING its "RSANN\n" header line: one message per following
	// line, which the gametype rotates through and broadcasts to everyone at a
	// low frequency. Empty = never fetched; a bare header = fetched but no
	// messages configured. Deduped on change so the gametype only re-parses the
	// list when an admin actually edits it. The script thread reads the
	// header-stripped text with RS_AnnounceText after RS_ApiPollAnnounce reports 1.
	std::atomic<unsigned> fetchAnnounceGen;
	std::atomic<int> fetchAnnounceResult;
	std::mutex announceMutex;
	std::string announceRaw;

	// Ranks fetch handshake (same shape as the blocked/motd ones). ranksText
	// holds the raw payload ("//ranks <total>\n<rank> <name>\n..."); the script
	// thread copies it out with RS_RanksText after RS_ApiPollRanks reports 1.
	// Deduped on change like MOTD so the gametype only re-parses the (possibly
	// large) blob when the ranks actually moved.
	std::atomic<unsigned> fetchRanksGen;
	std::atomic<int> fetchRanksResult;
	std::mutex ranksMutex;
	std::string ranksText;

	// Map-weapons fetch handshake (same shape as the blocked/ranks ones).
	// mapWeaponsText holds the raw payload (one "<map> code code ..." line per
	// map, a bare name = strafe); the script thread copies it out with
	// RS_MapWeaponsText after RS_ApiPollMapWeapons reports 1. Deduped on change
	// like MOTD/ranks so the gametype only re-parses the (large, but static)
	// table when it actually changed.
	std::atomic<unsigned> fetchMapWeaponsGen;
	std::atomic<int> fetchMapWeaponsResult;
	std::mutex mapWeaponsMutex;
	std::string mapWeaponsText;

	// Last-maps fetch handshake (same shape as the blocked/mapweapons ones).
	// lastMapsText holds the raw payload (one lowercased map name per line,
	// most-recent first); the script thread copies it out with RS_LastMapsText
	// after RS_ApiPollLastMaps reports 1. Deduped on change like the others so the
	// gametype only re-parses when the list actually moved.
	std::atomic<unsigned> fetchLastMapsGen;
	std::atomic<int> fetchLastMapsResult;
	std::mutex lastMapsMutex;
	std::string lastMapsText;

	// Per-player PB fetch handshake. Unlike every fetch above (one shared slot per
	// map), this is PER PLAYER: a player-record fetch is keyed by playerNum so
	// several joining players can be in flight at once without clobbering each
	// other. Fixed C array (std::atomic is not copyable, so a std::vector is
	// illegal); sized to a compile-time cap >= the engine's MAX_CLIENTS, matching
	// RS_MAX_BOT_SLOTS. playerRecText[i] holds the raw "//playerrec ..." payload
	// for slot i, guarded by the single playerRecMutex; the per-slot gen supersedes
	// an in-flight fetch (a re-join / rename on the same slot), and the per-slot
	// result is read-and-cleared by RS_ApiPollPlayerRecord(i).
	static const int RS_PLAYERREC_MAX = 256;
	std::atomic<unsigned> fetchPlayerRecGen[RS_PLAYERREC_MAX];
	std::atomic<int> fetchPlayerRecResult[RS_PLAYERREC_MAX];
	std::mutex playerRecMutex;
	std::string playerRecText[RS_PLAYERREC_MAX];

	// Per-player saved-START fetch handshake — identical PER-PLAYER shape to the
	// player-record slots above (keyed by playerNum, one payload per slot behind
	// savedStartMutex, a per-slot gen to supersede an in-flight re-join fetch,
	// per-slot result read-and-cleared by RS_ApiPollSavedStart(i)). Shares the
	// RS_PLAYERREC_MAX cap (both are keyed by the same player slot).
	std::atomic<unsigned> fetchSavedStartGen[RS_PLAYERREC_MAX];
	std::atomic<int> fetchSavedStartResult[RS_PLAYERREC_MAX];
	std::mutex savedStartMutex;
	std::string savedStartText[RS_PLAYERREC_MAX];

	ApiState()
		: stop( false ), fetchGen( 0 ), fetchResult( 0 ), fetchGhostGen( 0 ), fetchGhostResult( 0 ),
		  ghostFrameCount( 0 ), ghostHz( 0 ), ghostTime( 0 ),
		  fetchBlockedGen( 0 ), fetchBlockedResult( 0 ), fetchMotdGen( 0 ), fetchMotdResult( 0 ),
		  fetchAnnounceGen( 0 ), fetchAnnounceResult( 0 ),
		  fetchRanksGen( 0 ), fetchRanksResult( 0 ),
		  fetchMapWeaponsGen( 0 ), fetchMapWeaponsResult( 0 ),
		  fetchLastMapsGen( 0 ), fetchLastMapsResult( 0 )
	{
		// Atomics can't be aggregate-initialized in the member-init list loop-free,
		// so zero the per-slot arrays here in the ctor body.
		for( int i = 0; i < RS_PLAYERREC_MAX; i++ ) {
			fetchPlayerRecGen[i].store( 0 );
			fetchPlayerRecResult[i].store( 0 );
			fetchSavedStartGen[i].store( 0 );
			fetchSavedStartResult[i].store( 0 );
		}
	}
};

// Script-thread-only accumulator for building a ghost upload body incrementally
// (RS_GhostBegin/Frame/End) — avoids an O(n^2) string concat in AngelScript.
std::string g_ghostBuild;
bool g_ghostBuildFirst = true;

ApiState *g_state = nullptr;

// Swallow the response body; we only care about the status code.
size_t discardBody( void *, size_t size, size_t nmemb, void * )
{
	return size * nmemb;
}

// Collect a (bounded) response body into a std::string.
constexpr size_t BODY_MAX = 1u << 20; // a top-50 payload is a few KB
size_t collectBody( void *data, size_t size, size_t nmemb, void *userp )
{
	std::string *out = (std::string *)userp;
	size_t n = size * nmemb;
	if( out->size() + n > BODY_MAX )
		return 0; // absurd payload; abort the transfer
	out->append( (const char *)data, n );
	return n;
}

// RFC3986 percent-encode for a query-string value. The map-name fetches never
// needed this (map names are [a-z0-9._-]), but a player nick can carry spaces,
// '&', '#' or UTF-8 bytes that would corrupt "?map=..&name=<nick>" — and curl
// does NOT auto-encode CURLOPT_URL. Hand-rolled + ASCII so it survives the
// POSIX-locale build; encodes everything except the RFC3986 unreserved set.
std::string urlEncode( const std::string &s )
{
	static const char hex[] = "0123456789ABCDEF";
	std::string out;
	out.reserve( s.size() );
	for( size_t i = 0; i < s.size(); i++ ) {
		unsigned char c = (unsigned char)s[i];
		if( ( c >= 'A' && c <= 'Z' ) || ( c >= 'a' && c <= 'z' ) ||
			( c >= '0' && c <= '9' ) || c == '-' || c == '_' || c == '.' || c == '~' ) {
			out.push_back( (char)c );
		} else {
			out.push_back( '%' );
			out.push_back( hex[c >> 4] );
			out.push_back( hex[c & 0xF] );
		}
	}
	return out;
}

// -1 = transport error (retryable), otherwise the HTTP status.
long doGet( const ApiRequest &req, std::string &out )
{
	CURL *curl = curl_easy_init();
	if( !curl )
		return -1;

	struct curl_slist *headers = nullptr;
	if( !req.token.empty() ) {
		std::string auth = "Authorization: Bearer " + req.token;
		headers = curl_slist_append( headers, auth.c_str() );
	}

	curl_easy_setopt( curl, CURLOPT_URL, req.url.c_str() );
	if( headers )
		curl_easy_setopt( curl, CURLOPT_HTTPHEADER, headers );
	curl_easy_setopt( curl, CURLOPT_HTTPGET, 1L );
	curl_easy_setopt( curl, CURLOPT_CONNECTTIMEOUT, 5L );
	curl_easy_setopt( curl, CURLOPT_TIMEOUT, 10L );
	curl_easy_setopt( curl, CURLOPT_NOSIGNAL, 1L );
	curl_easy_setopt( curl, CURLOPT_FOLLOWLOCATION, 1L );
	curl_easy_setopt( curl, CURLOPT_MAXREDIRS, 3L );
	// http(s) only on redirects: never follow into file:// etc., and keep the
	// Authorization header from wandering to arbitrary protocols. NB: the
	// non-_STR option is deprecated in modern curl but is the ONLY spelling
	// libcurl 7.58 (the Ubuntu 18.04 build target) has — do not "modernize".
	curl_easy_setopt( curl, CURLOPT_REDIR_PROTOCOLS, (long)( CURLPROTO_HTTP | CURLPROTO_HTTPS ) );
	curl_easy_setopt( curl, CURLOPT_WRITEFUNCTION, collectBody );
	curl_easy_setopt( curl, CURLOPT_WRITEDATA, &out );

	CURLcode rc = curl_easy_perform( curl );
	long status = -1;
	if( rc == CURLE_OK )
		curl_easy_getinfo( curl, CURLINFO_RESPONSE_CODE, &status );
	else
		fprintf( stderr, "rs_api: %s: %s\n", req.url.c_str(), curl_easy_strerror( rc ) );

	if( headers )
		curl_slist_free_all( headers );
	curl_easy_cleanup( curl );
	return status;
}

// Read a file fully (worker thread; plain libc). Empty string when absent.
std::string readFileAll( const std::string &path )
{
	std::string out;
	FILE *f = fopen( path.c_str(), "rb" );
	if( !f )
		return out;
	char buf[8192];
	size_t n;
	while( ( n = fread( buf, 1, sizeof( buf ), f ) ) > 0 ) {
		out.append( buf, n );
		if( out.size() > BODY_MAX )
			break;
	}
	fclose( f );
	return out;
}

// tmp + rename so the engine (or a reader like the collector) never sees a
// half-written topscores file. Runs on the worker thread — plain libc only.
bool writeFileAtomic( const std::string &path, const std::string &data )
{
	std::string tmp = path + ".apitmp";
	FILE *f = fopen( tmp.c_str(), "wb" );
	if( !f )
		return false;
	size_t w = fwrite( data.data(), 1, data.size(), f );
	int rc = fclose( f );
	if( w != data.size() || rc != 0 ) {
		remove( tmp.c_str() );
		return false;
	}
	if( rename( tmp.c_str(), path.c_str() ) != 0 ) {
		remove( tmp.c_str() );
		return false;
	}
	return true;
}

// ---- undeliverable-report spool ---------------------------------------------
// A report the worker cannot deliver (shutdown drain against a dead API, or
// queue overflow) is appended here — one "<url>\t<body>" line — and re-queued
// on the next boot, so a web outage or a deploy can no longer permanently lose
// finishes. Bodies are single-line JSON (jsonEscapeInto escapes control chars)
// so the line framing is safe. Lives in the racelog bind mount next to
// events.log, which already persists across container rebuilds.
constexpr size_t SPOOL_LINE_MAX = 256 * 1024; // skips multi-MB ghost uploads
constexpr size_t SPOOL_LOAD_MAX = 128;        // per boot; keeps QUEUE_MAX headroom

std::string spoolPath()
{
	const char *base = getenv( "WARSOW_DIR" );
	if( !base || !base[0] )
		base = "/warsow";
	const char *fsgame = getenv( "FS_GAME" );
	if( !fsgame || !fsgame[0] )
		fsgame = "racemod";
	return std::string( base ) + "/" + fsgame + "/racelog/pending-reports.log";
}

// Append one undeliverable report (worker or script thread; O_APPEND keeps
// concurrent line appends whole at these sizes). Fetches pass through here
// from the shared eviction paths — their empty body makes this a no-op.
void spoolReport( const ApiRequest &req )
{
	if( req.url.empty() || req.body.empty() )
		return;
	if( req.url.size() + req.body.size() + 2 > SPOOL_LINE_MAX ) {
		fprintf( stderr, "rs_api: not spooling oversized report (%zu bytes)\n", req.body.size() );
		return;
	}
	FILE *f = fopen( spoolPath().c_str(), "ab" );
	if( !f ) {
		fprintf( stderr, "rs_api: cannot open report spool %s — report lost\n", spoolPath().c_str() );
		return;
	}
	fprintf( f, "%s\t%s\n", req.url.c_str(), req.body.c_str() );
	fclose( f );
	fprintf( stderr, "rs_api: spooled undeliverable report for redelivery next boot\n" );
}

// Load (and remove) the spool left by a previous run. The auth token is NOT
// persisted to disk; redelivery uses the container's INGEST_TOKEN env, which
// is the same secret the gametype passes on live reports.
std::vector<ApiRequest> loadSpool()
{
	std::vector<ApiRequest> out;
	std::string path = spoolPath();
	FILE *f = fopen( path.c_str(), "rb" );
	if( !f )
		return out;
	const char *token = getenv( "INGEST_TOKEN" );
	std::string line;
	size_t skipped = 0;
	int c;
	while( ( c = fgetc( f ) ) != EOF ) {
		if( c != '\n' ) {
			if( line.size() < SPOOL_LINE_MAX )
				line += (char)c; // oversized lines saturate and are rejected below
			continue;
		}
		size_t tab = line.find( '\t' );
		if( tab != std::string::npos && tab > 0 && tab + 1 < line.size() &&
			line.size() < SPOOL_LINE_MAX && out.size() < SPOOL_LOAD_MAX ) {
			out.push_back( ApiRequest{ line.substr( 0, tab ), token ? token : "",
				line.substr( tab + 1 ), 0, REQ_POST_REPORT, "", 0, 0 } );
		} else if( !line.empty() ) {
			skipped++;
		}
		line.clear();
	}
	fclose( f );
	remove( path.c_str() );
	if( !out.empty() || skipped )
		fprintf( stderr, "rs_api: re-queued %zu spooled report(s), skipped %zu\n",
			out.size(), skipped );
	return out;
}

// -1 = transport error (retryable), otherwise the HTTP status.
long doPost( const ApiRequest &req )
{
	CURL *curl = curl_easy_init();
	if( !curl )
		return -1;

	struct curl_slist *headers = nullptr;
	headers = curl_slist_append( headers, "Content-Type: application/json" );
	if( !req.token.empty() ) {
		std::string auth = "Authorization: Bearer " + req.token;
		headers = curl_slist_append( headers, auth.c_str() );
	}

	curl_easy_setopt( curl, CURLOPT_URL, req.url.c_str() );
	curl_easy_setopt( curl, CURLOPT_HTTPHEADER, headers );
	curl_easy_setopt( curl, CURLOPT_POSTFIELDS, req.body.c_str() );
	curl_easy_setopt( curl, CURLOPT_POSTFIELDSIZE, (long)req.body.size() );
	curl_easy_setopt( curl, CURLOPT_CONNECTTIMEOUT, 5L );
	curl_easy_setopt( curl, CURLOPT_TIMEOUT, 10L );
	curl_easy_setopt( curl, CURLOPT_NOSIGNAL, 1L ); // threads + SIGALRM don't mix
	curl_easy_setopt( curl, CURLOPT_FOLLOWLOCATION, 1L );
	curl_easy_setopt( curl, CURLOPT_MAXREDIRS, 3L );
	curl_easy_setopt( curl, CURLOPT_WRITEFUNCTION, discardBody );

	CURLcode rc = curl_easy_perform( curl );
	long status = -1;
	if( rc == CURLE_OK )
		curl_easy_getinfo( curl, CURLINFO_RESPONSE_CODE, &status );
	else
		fprintf( stderr, "rs_api: %s: %s\n", req.url.c_str(), curl_easy_strerror( rc ) );

	curl_slist_free_all( headers );
	curl_easy_cleanup( curl );
	return status;
}

// Parse the flat-text WR ghost payload the web serves at /api/game/ghost:
//   line 1: RSGHOST <v> <hz> <time> <frameCount>
//   line 2: <holder name>
//   line 3: <cp frame indices, space separated, maybe empty>
//   then <frameCount> lines of: x y z pitch yaw roll vx vy vz
// Positions are truncated to ints (a ghost path needs no sub-unit precision).
// Returns false on anything that is not a well-formed ghost (proxy error page,
// truncated body, etc.) so it can never drive a bot from garbage.
bool parseGhostPayload( const std::string &payload, std::vector<int> &frames,
	int &frameCount, int &hz, int &timeMs, std::string &name, std::string &cps )
{
	if( payload.compare( 0, 8, "RSGHOST " ) != 0 )
		return false;

	size_t pos = 0;
	std::string line;
	auto nextLine = [&]( std::string &out ) -> bool {
		if( pos > payload.size() )
			return false;
		size_t nl = payload.find( '\n', pos );
		if( nl == std::string::npos ) {
			out = payload.substr( pos );
			pos = payload.size() + 1;
		} else {
			out = payload.substr( pos, nl - pos );
			pos = nl + 1;
		}
		return true;
	};

	std::string header;
	if( !nextLine( header ) )
		return false;
	int v = 0;
	if( sscanf( header.c_str(), "RSGHOST %d %d %d %d", &v, &hz, &timeMs, &frameCount ) != 4 )
		return false;
	if( frameCount < 0 || frameCount > 200000 || hz <= 0 || hz > 1000 )
		return false;

	if( !nextLine( name ) )
		return false;
	if( !nextLine( cps ) )
		return false; // may be empty, but the line must exist

	frames.clear();
	frames.reserve( (size_t)frameCount * 9 );
	int got = 0;
	while( got < frameCount && nextLine( line ) ) {
		float f[9];
		if( sscanf( line.c_str(), "%f %f %f %f %f %f %f %f %f",
				&f[0], &f[1], &f[2], &f[3], &f[4], &f[5], &f[6], &f[7], &f[8] ) != 9 )
			break;
		// float->int of inf/NaN/out-of-range is UB — reject the frame line
		// (world coordinates and velocities fit comfortably inside +/-1e9).
		bool finite = true;
		for( int k = 0; k < 9; k++ ) {
			if( !std::isfinite( f[k] ) || f[k] < -1e9f || f[k] > 1e9f ) {
				finite = false;
				break;
			}
		}
		if( !finite )
			break;
		for( int k = 0; k < 9; k++ )
			frames.push_back( (int)f[k] );
		got++;
	}
	frameCount = got;
	return got >= 2;
}

void workerMain( ApiState *s )
{
	// Redeliver anything a previous run had to spool (deploy/outage overlap).
	{
		std::vector<ApiRequest> spooled = loadSpool();
		if( !spooled.empty() ) {
			std::lock_guard<std::mutex> lock( s->mutex );
			for( size_t i = 0; i < spooled.size(); i++ )
				s->queue.push_back( std::move( spooled[i] ) );
		}
	}

	// Once one drain attempt fails during shutdown, the API is presumed down
	// for the rest of the drain: every remaining report is spooled without a
	// network attempt, so a dead API costs ONE curl timeout instead of one per
	// queued report (which could blow the container's stop grace entirely).
	bool stopDrainFailed = false;

	for( ;; ) {
		ApiRequest req;
		{
			std::unique_lock<std::mutex> lock( s->mutex );
			s->cv.wait( lock, [s] { return s->stop.load() || !s->queue.empty(); } );
			if( s->queue.empty() )
				return; // stop requested and nothing left to send
			req = std::move( s->queue.front() );
			s->queue.pop_front();
		}

		long status;
		if( req.type == REQ_GET_GHOST ) {
			if( s->stop.load() )
				continue;
			std::string payload;
			status = doGet( req, payload );
			bool current = req.gen == s->fetchGhostGen.load();
			if( status >= 200 && status < 300 ) {
				if( !current )
					continue; // superseded (map changed / newer fetch) — drop
				std::vector<int> frames;
				int fc = 0, hz = 0, tm = 0;
				std::string nm, cps;
				if( parseGhostPayload( payload, frames, fc, hz, tm, nm, cps ) ) {
					std::lock_guard<std::mutex> lock( s->ghostMutex );
					s->ghostFrames.swap( frames );
					s->ghostFrameCount = fc;
					s->ghostHz = hz;
					s->ghostTime = tm;
					s->ghostName = nm;
					s->ghostCps = cps;
					s->fetchGhostResult.store( 1 );
				} else {
					fprintf( stderr, "rs_api: rejecting non-ghost payload from %s\n", req.url.c_str() );
					s->fetchGhostResult.store( -1 );
				}
				continue;
			}
			if( !current )
				continue;
			bool permanent = status >= 400 && status < 500;
			req.attempts++;
			if( permanent || req.attempts >= MAX_ATTEMPTS ) {
				// 404 = no WR ghost for this map yet — expected, not logged.
				if( status != 404 )
					fprintf( stderr, "rs_api: ghost fetch failed for good, status %ld: %s\n",
						status, req.url.c_str() );
				s->fetchGhostResult.store( -1 );
				continue;
			}
			// transient: fall through to the requeue below
		} else if( req.type == REQ_GET_TOPSCORES ) {
			// A fetch queued when shutdown is already under way is worthless:
			// nobody will ever poll the result.
			if( s->stop.load() )
				continue;

			std::string payload;
			status = doGet( req, payload );
			bool current = req.gen == s->fetchGen.load();
			if( status >= 200 && status < 300 ) {
				if( !current )
					continue; // superseded while in flight — drop silently
				// A topscores payload always starts with its "//<map> top
				// scores" header. Anything else (captive portal, proxy error
				// page answering 200) must never reach the records file —
				// the loader would tokenize garbage into 0ms "records".
				if( payload.compare( 0, 2, "//" ) != 0 ) {
					fprintf( stderr, "rs_api: rejecting non-topscores payload from %s\n",
						req.url.c_str() );
					s->fetchResult.store( -1 );
					continue;
				}
				// Unchanged since the last swap: skip the write AND the
				// poll signal — reloading an identical payload is pure
				// churn for the gametype's merge every interval.
				if( payload == readFileAll( req.filePath ) )
					continue;
				if( writeFileAtomic( req.filePath, payload ) ) {
					s->fetchResult.store( 1 );
				} else {
					fprintf( stderr, "rs_api: cannot write %s\n", req.filePath.c_str() );
					s->fetchResult.store( -1 );
				}
				continue;
			}
			if( !current )
				continue; // superseded — do not burn retries on a stale fetch
			bool permanent = status >= 400 && status < 500;
			req.attempts++;
			if( permanent || req.attempts >= MAX_ATTEMPTS ) {
				// 404 is the expected "no central records for this map yet" —
				// not worth a log line per refresh interval.
				if( status != 404 )
					fprintf( stderr, "rs_api: top-scores fetch failed for good, status %ld: %s\n",
						status, req.url.c_str() );
				s->fetchResult.store( -1 );
				continue;
			}
		} else if( req.type == REQ_GET_BLOCKED ) {
			// A fetch queued once shutdown is under way is worthless: nobody
			// will ever poll the result.
			if( s->stop.load() )
				continue;
			std::string payload;
			status = doGet( req, payload );
			bool current = req.gen == s->fetchBlockedGen.load();
			if( status >= 200 && status < 300 ) {
				if( !current )
					continue; // superseded while in flight — drop silently
				// The list is plain text, one map name per line; an empty body
				// is valid ("nothing blocked"). Reject an HTML body, though — a
				// captive portal / proxy error page answering 200 must never
				// overwrite the good list. Map names never contain '<', so its
				// presence marks a non-blocklist payload.
				if( payload.find( '<' ) != std::string::npos ) {
					fprintf( stderr, "rs_api: rejecting non-blocklist payload from %s\n",
						req.url.c_str() );
					s->fetchBlockedResult.store( -1 );
					continue;
				}
				{
					std::lock_guard<std::mutex> lock( s->blockedMutex );
					s->blockedText.swap( payload );
				}
				s->fetchBlockedResult.store( 1 );
				continue;
			}
			if( !current )
				continue; // superseded — do not burn retries on a stale fetch
			bool permanent = status >= 400 && status < 500;
			req.attempts++;
			if( permanent || req.attempts >= MAX_ATTEMPTS ) {
				if( status != 404 )
					fprintf( stderr, "rs_api: blocked-maps fetch failed for good, status %ld: %s\n",
						status, req.url.c_str() );
				s->fetchBlockedResult.store( -1 );
				continue;
			}
			// transient: fall through to the requeue below
		} else if( req.type == REQ_GET_MOTD ) {
			// A fetch queued once shutdown is under way is worthless: nobody
			// will ever poll the result.
			if( s->stop.load() )
				continue;
			std::string payload;
			status = doGet( req, payload );
			bool current = req.gen == s->fetchMotdGen.load();
			if( status >= 200 && status < 300 ) {
				if( !current )
					continue; // superseded while in flight — drop silently
				// The web always prefixes the text with an "RSMOTD" header
				// line, so a captive portal / proxy error page answering 200
				// can never become the message of the day.
				if( payload.compare( 0, 7, "RSMOTD\n" ) != 0 ) {
					fprintf( stderr, "rs_api: rejecting non-motd payload from %s\n",
						req.url.c_str() );
					s->fetchMotdResult.store( -1 );
					continue;
				}
				{
					std::lock_guard<std::mutex> lock( s->motdMutex );
					// Unchanged since the last swap: skip the signal — the
					// gametype would only rewrite sv_MOTDString with the same
					// value (same idea as the topscores file compare).
					if( payload == s->motdRaw )
						continue;
					s->motdRaw.swap( payload );
				}
				s->fetchMotdResult.store( 1 );
				continue;
			}
			if( !current )
				continue; // superseded — do not burn retries on a stale fetch
			bool permanent = status >= 400 && status < 500;
			req.attempts++;
			if( permanent || req.attempts >= MAX_ATTEMPTS ) {
				if( status != 404 )
					fprintf( stderr, "rs_api: motd fetch failed for good, status %ld: %s\n",
						status, req.url.c_str() );
				s->fetchMotdResult.store( -1 );
				continue;
			}
			// transient: fall through to the requeue below
		} else if( req.type == REQ_GET_ANNOUNCE ) {
			// A fetch queued once shutdown is under way is worthless: nobody
			// will ever poll the result.
			if( s->stop.load() )
				continue;
			std::string payload;
			status = doGet( req, payload );
			bool current = req.gen == s->fetchAnnounceGen.load();
			if( status >= 200 && status < 300 ) {
				if( !current )
					continue; // superseded while in flight — drop silently
				// The web always prefixes the list with an "RSANN" header line,
				// so a captive portal / proxy error page answering 200 can never
				// become the announcement rotation.
				if( payload.compare( 0, 6, "RSANN\n" ) != 0 ) {
					fprintf( stderr, "rs_api: rejecting non-announce payload from %s\n",
						req.url.c_str() );
					s->fetchAnnounceResult.store( -1 );
					continue;
				}
				{
					std::lock_guard<std::mutex> lock( s->announceMutex );
					// Unchanged since the last swap: skip the signal — the
					// gametype would only re-parse the same list (same idea as
					// the MOTD compare).
					if( payload == s->announceRaw )
						continue;
					s->announceRaw.swap( payload );
				}
				s->fetchAnnounceResult.store( 1 );
				continue;
			}
			if( !current )
				continue; // superseded — do not burn retries on a stale fetch
			bool permanent = status >= 400 && status < 500;
			req.attempts++;
			if( permanent || req.attempts >= MAX_ATTEMPTS ) {
				if( status != 404 )
					fprintf( stderr, "rs_api: announce fetch failed for good, status %ld: %s\n",
						status, req.url.c_str() );
				s->fetchAnnounceResult.store( -1 );
				continue;
			}
			// transient: fall through to the requeue below
		} else if( req.type == REQ_GET_RANKS ) {
			// A fetch queued once shutdown is under way is worthless: nobody
			// will ever poll the result.
			if( s->stop.load() )
				continue;
			std::string payload;
			status = doGet( req, payload );
			bool current = req.gen == s->fetchRanksGen.load();
			if( status >= 200 && status < 300 ) {
				if( !current )
					continue; // superseded while in flight - drop silently
				// The ranks payload always starts with its "//ranks" header;
				// reject anything else (captive portal / proxy error page
				// answering 200) so the gametype never parses garbage into
				// player ranks.
				if( payload.compare( 0, 2, "//" ) != 0 ) {
					fprintf( stderr, "rs_api: rejecting non-ranks payload from %s\n",
						req.url.c_str() );
					s->fetchRanksResult.store( -1 );
					continue;
				}
				{
					std::lock_guard<std::mutex> lock( s->ranksMutex );
					// Unchanged since the last swap: skip the signal so the
					// gametype doesn't re-parse an identical blob every
					// interval (same idea as the topscores/motd compare).
					if( payload == s->ranksText )
						continue;
					s->ranksText.swap( payload );
				}
				s->fetchRanksResult.store( 1 );
				continue;
			}
			if( !current )
				continue; // superseded - do not burn retries on a stale fetch
			bool permanent = status >= 400 && status < 500;
			req.attempts++;
			if( permanent || req.attempts >= MAX_ATTEMPTS ) {
				// 404 is the expected "no central records for this map yet".
				if( status != 404 )
					fprintf( stderr, "rs_api: ranks fetch failed for good, status %ld: %s\n",
						status, req.url.c_str() );
				s->fetchRanksResult.store( -1 );
				continue;
			}
			// transient: fall through to the requeue below
		} else if( req.type == REQ_GET_MAPWEAPONS ) {
			// A fetch queued once shutdown is under way is worthless: nobody
			// will ever poll the result.
			if( s->stop.load() )
				continue;
			std::string payload;
			status = doGet( req, payload );
			bool current = req.gen == s->fetchMapWeaponsGen.load();
			if( status >= 200 && status < 300 ) {
				if( !current )
					continue; // superseded while in flight - drop silently
				// Plain text, one "<map> code code ..." line per map; an empty
				// body is valid. Reject an HTML body, though - a captive portal
				// / proxy error page answering 200 must never overwrite the good
				// table. Map lines never contain '<'.
				if( payload.find( '<' ) != std::string::npos ) {
					fprintf( stderr, "rs_api: rejecting non-mapweapons payload from %s\n",
						req.url.c_str() );
					s->fetchMapWeaponsResult.store( -1 );
					continue;
				}
				{
					std::lock_guard<std::mutex> lock( s->mapWeaponsMutex );
					// Unchanged since the last swap: skip the signal so the
					// gametype doesn't re-parse the (large) table every interval
					// (same idea as the motd/ranks compare).
					if( payload == s->mapWeaponsText )
						continue;
					s->mapWeaponsText.swap( payload );
				}
				s->fetchMapWeaponsResult.store( 1 );
				continue;
			}
			if( !current )
				continue; // superseded - do not burn retries on a stale fetch
			bool permanent = status >= 400 && status < 500;
			req.attempts++;
			if( permanent || req.attempts >= MAX_ATTEMPTS ) {
				if( status != 404 )
					fprintf( stderr, "rs_api: map-weapons fetch failed for good, status %ld: %s\n",
						status, req.url.c_str() );
				s->fetchMapWeaponsResult.store( -1 );
				continue;
			}
			// transient: fall through to the requeue below
		} else if( req.type == REQ_GET_LASTMAPS ) {
			// A fetch queued once shutdown is under way is worthless: nobody
			// will ever poll the result.
			if( s->stop.load() )
				continue;
			std::string payload;
			status = doGet( req, payload );
			bool current = req.gen == s->fetchLastMapsGen.load();
			if( status >= 200 && status < 300 ) {
				if( !current )
					continue; // superseded while in flight - drop silently
				// Plain text, one map name per line; an empty body is valid
				// (nothing finished yet). Reject an HTML body, though - a
				// captive portal / proxy error page answering 200 must never
				// overwrite the good list. Map names never contain '<'.
				if( payload.find( '<' ) != std::string::npos ) {
					fprintf( stderr, "rs_api: rejecting non-lastmaps payload from %s\n",
						req.url.c_str() );
					s->fetchLastMapsResult.store( -1 );
					continue;
				}
				{
					std::lock_guard<std::mutex> lock( s->lastMapsMutex );
					// Unchanged since the last swap: skip the signal so the
					// gametype doesn't re-parse an identical list every interval
					// (same idea as the motd/ranks/mapweapons compare).
					if( payload == s->lastMapsText )
						continue;
					s->lastMapsText.swap( payload );
				}
				s->fetchLastMapsResult.store( 1 );
				continue;
			}
			if( !current )
				continue; // superseded - do not burn retries on a stale fetch
			bool permanent = status >= 400 && status < 500;
			req.attempts++;
			if( permanent || req.attempts >= MAX_ATTEMPTS ) {
				if( status != 404 )
					fprintf( stderr, "rs_api: last-maps fetch failed for good, status %ld: %s\n",
						status, req.url.c_str() );
				s->fetchLastMapsResult.store( -1 );
				continue;
			}
			// transient: fall through to the requeue below
		} else if( req.type == REQ_GET_PLAYERREC ) {
			// Per-player PB fetch, keyed by req.slot. A fetch queued once
			// shutdown is under way is worthless: nobody will ever poll it.
			if( req.slot < 0 || req.slot >= ApiState::RS_PLAYERREC_MAX )
				continue;
			if( s->stop.load() )
				continue;
			std::string payload;
			status = doGet( req, payload );
			bool current = req.gen == s->fetchPlayerRecGen[req.slot].load();
			if( status >= 200 && status < 300 ) {
				if( !current )
					continue; // superseded (re-join / rename on this slot) - drop
				// The web leads a real record with a "//playerrec" header (an empty
				// body means "this player has no record here"), so anything not
				// "//..." is a captive portal / proxy error page and an empty body
				// is a fail-open "none" - both -> -1 so the gametype keeps the
				// player's existing board seed untouched.
				if( payload.empty() || payload.compare( 0, 2, "//" ) != 0 ) {
					s->fetchPlayerRecResult[req.slot].store( -1 );
					continue;
				}
				{
					std::lock_guard<std::mutex> lock( s->playerRecMutex );
					s->playerRecText[req.slot].swap( payload );
				}
				// Always signal 1 on a good body (no "skip if unchanged" dedup like
				// the map-wide fetches use): this is a ONE-SHOT fetch the script side
				// gates behind a per-player pendingRecordFetch flag it clears only on
				// a non-zero poll. Suppressing the signal for an identical payload
				// would strand that flag true and the gametype would poll forever.
				s->fetchPlayerRecResult[req.slot].store( 1 );
				continue;
			}
			if( !current )
				continue; // superseded - do not burn retries on a stale fetch
			bool permanent = status >= 400 && status < 500;
			req.attempts++;
			if( permanent || req.attempts >= MAX_ATTEMPTS ) {
				// 404 is the expected "this player has no record on this map".
				if( status != 404 )
					fprintf( stderr, "rs_api: player-record fetch failed for good, status %ld: %s\n",
						status, req.url.c_str() );
				s->fetchPlayerRecResult[req.slot].store( -1 );
				continue;
			}
			// transient: fall through to the requeue below
			} else if( req.type == REQ_GET_SAVEDSTART ) {
				// Per-player saved-START fetch, keyed by req.slot - same per-slot
				// handshake as REQ_GET_PLAYERREC above.
				if( req.slot < 0 || req.slot >= ApiState::RS_PLAYERREC_MAX )
					continue;
				if( s->stop.load() )
					continue;
				std::string payload;
				status = doGet( req, payload );
				bool current = req.gen == s->fetchSavedStartGen[req.slot].load();
				if( status >= 200 && status < 300 ) {
					if( !current )
						continue; // superseded (re-join on this slot) - drop
					// The web always leads with a "//starts" header (a bare header =
					// this player has no saved start). Anything not "//..." is a captive
					// portal / proxy error page -> fail-open -1 (stay at map default).
					if( payload.empty() || payload.compare( 0, 2, "//" ) != 0 ) {
						s->fetchSavedStartResult[req.slot].store( -1 );
						continue;
					}
					{
						std::lock_guard<std::mutex> lock( s->savedStartMutex );
						s->savedStartText[req.slot].swap( payload );
					}
					// One-shot fetch: always signal 1 on a good body (the script clears
					// its pendingSavedStartFetch only on a non-zero poll).
					s->fetchSavedStartResult[req.slot].store( 1 );
					continue;
				}
				if( !current )
					continue; // superseded - do not burn retries on a stale fetch
				bool permanent = status >= 400 && status < 500;
				req.attempts++;
				if( permanent || req.attempts >= MAX_ATTEMPTS ) {
					// 404 is the expected "unknown map / no saved start".
					if( status != 404 )
						fprintf( stderr, "rs_api: saved-start fetch failed for good, status %ld: %s\n",
							status, req.url.c_str() );
					s->fetchSavedStartResult[req.slot].store( -1 );
					continue;
				}
				// transient: fall through to the requeue below
		} else {
			if( s->stop.load() && stopDrainFailed ) {
				spoolReport( req );
				continue;
			}
			status = doPost( req );
			if( status >= 200 && status < 300 )
				continue;

			req.attempts++;
			if( status >= 400 && status < 500 ) {
				// The API rejected the body — retrying or spooling an
				// identical payload can never succeed. Log it whole.
				fprintf( stderr, "rs_api: dropping rejected report, status %ld: %s\n",
					status, req.body.c_str() );
				continue;
			}
			if( s->stop.load() ) {
				stopDrainFailed = true;
				spoolReport( req );
				continue;
			}
			// Transient failure with the server still running: retry without
			// an attempt cap — a report is delivered exactly once or spooled,
			// never dropped. The queue is bounded (QUEUE_MAX; overflow spools
			// the evictee) and the pause below keeps the loop cold. Log the
			// first failure, then sparingly.
			if( req.attempts == 1 || req.attempts % 30 == 0 )
				fprintf( stderr, "rs_api: report attempt %d failed, status %ld (will keep retrying): %s\n",
					req.attempts, status, req.url.c_str() );
		}

		// Brief pause, then requeue at the back. The pause is a cv wait so
		// rsApiShutdown's notify_all cuts it short instead of the join eating
		// the sleep remainder.
		{
			std::unique_lock<std::mutex> lock( s->mutex );
			s->cv.wait_for( lock, std::chrono::seconds( 2 ), [s] { return s->stop.load(); } );
			s->queue.push_back( std::move( req ) );
		}
	}
}

// Only ever called from the game's script thread, so plain-pointer init is
// race-free; the worker never touches g_state itself.
ApiState *ensureStarted()
{
	if( !g_state ) {
		curl_global_init( CURL_GLOBAL_DEFAULT );
		g_state = new ApiState();
		g_state->worker = std::thread( workerMain, g_state );
	}
	return g_state;
}

void jsonEscapeInto( std::string &out, const char *s )
{
	for( const unsigned char *p = (const unsigned char *)s; *p; p++ ) {
		unsigned char c = *p;
		switch( c ) {
			case '"': out += "\\\""; break;
			case '\\': out += "\\\\"; break;
			case '\b': out += "\\b"; break;
			case '\f': out += "\\f"; break;
			case '\n': out += "\\n"; break;
			case '\r': out += "\\r"; break;
			case '\t': out += "\\t"; break;
			default:
				if( c < 0x20 ) {
					char buf[8];
					snprintf( buf, sizeof( buf ), "\\u%04x", c );
					out += buf;
				} else {
					out += (char)c;
				}
		}
	}
}

// Stop and join the worker before the library is unloaded, draining whatever
// is still queued. The drain is bounded: fetches are skipped outright, and
// after one failed POST the rest go straight to the on-disk spool — so a dead
// API costs a single curl timeout, not one per queued report.
__attribute__(( destructor )) void rsApiShutdown()
{
	ApiState *s = g_state;
	if( !s )
		return;
	{
		// Set stop under the lock: setting it between the worker's predicate
		// check and its block-on-wait would otherwise lose the wakeup and
		// deadlock the join below.
		std::lock_guard<std::mutex> lock( s->mutex );
		s->stop.store( true );
	}
	s->cv.notify_all();
	if( s->worker.joinable() )
		s->worker.join();
	// s is intentionally leaked; see the ApiState comment.
}

} // namespace

// Enqueue any fire-and-forget POST (shared by all the report natives). When
// the queue is full, evict a fetch first — fetches are fully reproducible on
// the next refresh interval — and only then the oldest report, which goes to
// the on-disk spool instead of being silently dropped.
static void rsQueuePost( const char *url, const char *token, std::string &&body )
{
	ApiState *s = ensureStarted();
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		if( s->queue.size() >= QUEUE_MAX ) {
			bool evicted = false;
			for( std::deque<ApiRequest>::iterator it = s->queue.begin(); it != s->queue.end(); ++it ) {
				if( it->type != REQ_POST_REPORT ) {
					s->queue.erase( it );
					evicted = true;
					break;
				}
			}
			if( !evicted ) {
				fprintf( stderr, "rs_api: queue full, spooling oldest report\n" );
				spoolReport( s->queue.front() );
				s->queue.pop_front();
			}
		}
		s->queue.push_back( ApiRequest{ url, token ? token : "", std::move( body ), 0,
			REQ_POST_REPORT, "", 0, 0 } );
	}
	s->cv.notify_one();
}

/*
 * RS_ApiReportRace
 *
 * Queue one finished race for delivery to <url> (the central /api/ingest).
 * cpsCsv is the comma-separated absolute checkpoint times in milliseconds
 * (the finish time is not part of the list). attemptsSinceLast is the number
 * of race STARTS since this player's last flush, including the start that
 * produced this finish (pass a negative value to omit — the API then counts
 * the finish as a single attempt). strafeQuality is the run's average accel
 * efficiency in basis points (0..10000 = 0..100%; negative = omit). No-op when
 * url is empty.
 */
void RS_ApiReportRace( const char *url, const char *token, const char *version,
	const char *mapname, const char *player, const char *login,
	int timeMs, int attemptsSinceLast, const char *cpsCsv,
	int wallJumps, int dashes, int prejumpFails, int restarts,
	int strafeQuality )
{
	if( !url || !url[0] || !mapname || !mapname[0] || !player || !player[0] || timeMs <= 0 )
		return;

	std::string body;
	body.reserve( 256 );
	body += "{\"version\":\"";
	jsonEscapeInto( body, version && version[0] ? version : "wsw 2.1" );
	body += "\",\"map\":\"";
	jsonEscapeInto( body, mapname );
	body += "\",\"source\":\"racelog\",\"records\":[{\"name\":\"";
	jsonEscapeInto( body, player );
	body += "\",\"login\":\"";
	jsonEscapeInto( body, login ? login : "" );
	body += "\",\"time\":";
	body += std::to_string( timeMs );
	if( attemptsSinceLast >= 0 ) {
		body += ",\"attempts\":";
		body += std::to_string( attemptsSinceLast );
	}
	body += ",\"checkpoints\":[";

	// keep only well-formed integers from the csv
	bool first = true;
	const char *p = cpsCsv ? cpsCsv : "";
	while( *p ) {
		char *end = nullptr;
		long v = strtol( p, &end, 10 );
		if( end == p )
			break; // malformed; stop rather than guess
		if( !first )
			body += ',';
		body += std::to_string( v );
		first = false;
		p = ( *end == ',' ) ? end + 1 : end;
		if( *end != ',' )
			break;
	}
	body += "]"; // close the checkpoints array

	// Movement / behaviour metrics accumulated since this player's last flush
	// (negative = omit; the API treats a missing field as zero).
	if( wallJumps >= 0 ) { body += ",\"wall_jumps\":"; body += std::to_string( wallJumps ); }
	if( dashes >= 0 ) { body += ",\"dashes\":"; body += std::to_string( dashes ); }
	if( prejumpFails >= 0 ) { body += ",\"prejump_failures\":"; body += std::to_string( prejumpFails ); }
	if( restarts >= 0 ) { body += ",\"restarts\":"; body += std::to_string( restarts ); }
	// Per-run air-strafe quality (accel efficiency) as basis points 0..10000
	// (negative = omit; the API stores it per finish, never summed like the
	// counters above). Snapshot, not a monotonic tally.
	if( strafeQuality >= 0 ) { body += ",\"strafe_quality\":"; body += std::to_string( strafeQuality ); }
	body += "}]}";

	rsQueuePost( url, token, std::move( body ) );
}

/*
 * RS_ApiReportAttempts
 *
 * Queue a finish-less attempt flush: <count> race starts by <player> on
 * <mapname> that have no finish report to ride on (the player disconnected
 * or the map ended mid-run). Same idempotency posture as finish reports:
 * bounded retries, dropped on permanent failure.
 */
void RS_ApiReportAttempts( const char *url, const char *token, const char *version,
	const char *mapname, const char *player, const char *login, int count,
	int wallJumps, int dashes, int prejumpFails, int restarts )
{
	if( !url || !url[0] || !mapname || !mapname[0] || !player || !player[0] )
		return;
	// A flush is worth sending if there are starts to report OR any movement
	// metric to carry (a lone /kill leaves restarts with no accompanying start).
	if( count <= 0 && wallJumps <= 0 && dashes <= 0 && prejumpFails <= 0 && restarts <= 0 )
		return;

	std::string body;
	body.reserve( 192 );
	body += "{\"version\":\"";
	jsonEscapeInto( body, version && version[0] ? version : "wsw 2.1" );
	body += "\",\"map\":\"";
	jsonEscapeInto( body, mapname );
	body += "\",\"source\":\"racelog\",\"attempts\":[{\"name\":\"";
	jsonEscapeInto( body, player );
	body += "\",\"login\":\"";
	jsonEscapeInto( body, login ? login : "" );
	body += "\",\"count\":";
	body += std::to_string( count > 0 ? count : 0 );
	if( wallJumps >= 0 ) { body += ",\"wall_jumps\":"; body += std::to_string( wallJumps ); }
	if( dashes >= 0 ) { body += ",\"dashes\":"; body += std::to_string( dashes ); }
	if( prejumpFails >= 0 ) { body += ",\"prejump_failures\":"; body += std::to_string( prejumpFails ); }
	if( restarts >= 0 ) { body += ",\"restarts\":"; body += std::to_string( restarts ); }
	body += "}]}";

	rsQueuePost( url, token, std::move( body ) );
}

/*
 * RS_ApiFlag
 *
 * Queue an in-game "/flag": <player> flags <mapname> for review, POSTed to
 * <url> (the central /api/game/flag). <reason> is one of the API's flag reasons
 * (broken/offensive/wrong_name/duplicate/other); an unknown or empty reason is
 * accepted by the API and coerced to "other". Fire-and-forget, same posture as
 * the finish/attempt reports. No-op when url or mapname is empty.
 */
void RS_ApiFlag( const char *url, const char *token, const char *mapname,
	const char *reason, const char *player, const char *login )
{
	if( !url || !url[0] || !mapname || !mapname[0] )
		return;

	std::string body;
	body.reserve( 192 );
	body += "{\"map\":\"";
	jsonEscapeInto( body, mapname );
	body += "\",\"reason\":\"";
	jsonEscapeInto( body, reason ? reason : "" );
	body += "\",\"player\":\"";
	jsonEscapeInto( body, player ? player : "" );
	body += "\",\"login\":\"";
	jsonEscapeInto( body, login ? login : "" );
	body += "\"}";

	rsQueuePost( url, token, std::move( body ) );
}

/*
 * RS_ApiFetchTop
 *
 * Fetch the map's live top scores from <url> (the central
 * /api/game/topscores endpoint; ?map=<mapname> is appended) and swap the
 * payload — which is byte-format identical to a topscores file — into
 * topscores/race/<mapname>.txt under the mod's write directory. The gametype
 * polls RS_ApiPollTop() and re-runs its normal topscores loader when a fresh
 * payload has landed, so every in-game record display matches the central
 * database. Fire-and-forget; a newer fetch supersedes an in-flight one.
 *
 * The write directory comes from WARSOW_DIR/FS_GAME (set by the Docker
 * image; falls back to /warsow and racemod) because the engine's filesystem
 * API is not callable off the main thread.
 */
void RS_ApiFetchTop( const char *url, const char *token, const char *mapname )
{
	if( !url || !url[0] || !mapname || !mapname[0] )
		return;

	// The map name becomes a file name — accept the same character set the
	// stats API allows and refuse anything else outright.
	for( const char *p = mapname; *p; p++ ) {
		char c = *p;
		bool ok = ( c >= 'a' && c <= 'z' ) || ( c >= '0' && c <= '9' ) ||
			c == '_' || c == '.' || c == '-';
		if( !ok ) {
			fprintf( stderr, "rs_api: refusing top-scores fetch for unsafe map name\n" );
			return;
		}
	}

	const char *base = getenv( "WARSOW_DIR" );
	if( !base || !base[0] )
		base = "/warsow";
	const char *fsgame = getenv( "FS_GAME" );
	if( !fsgame || !fsgame[0] )
		fsgame = "racemod";

	std::string full = std::string( url ) + "?map=" + mapname;
	std::string path = std::string( base ) + "/" + fsgame + "/topscores/race/" + mapname + ".txt";

	ApiState *s = ensureStarted();
	unsigned gen = s->fetchGen.fetch_add( 1 ) + 1;
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		if( s->queue.size() >= QUEUE_MAX ) {
			// Prefer evicting another fetch (fully reproducible next interval)
			// over a race report (a finish is reported exactly once).
			bool evicted = false;
			for( std::deque<ApiRequest>::iterator it = s->queue.begin(); it != s->queue.end(); ++it ) {
				if( it->type == REQ_GET_TOPSCORES || it->type == REQ_GET_PLAYERREC ) {
					s->queue.erase( it );
					evicted = true;
					break;
				}
			}
			if( !evicted ) {
				// No fetch to evict: the whole queue is reports. Spool the
				// oldest instead of silently losing a finish.
				fprintf( stderr, "rs_api: queue full, spooling oldest report\n" );
				spoolReport( s->queue.front() );
				s->queue.pop_front();
			}
		}
		s->queue.push_back( ApiRequest{ std::move( full ), token ? token : "", "", 0,
			REQ_GET_TOPSCORES, std::move( path ), gen, 0 } );
	}
	s->cv.notify_one();
}

/*
 * RS_ApiPollTop
 *
 * Read-and-clear the fetch outcome: 1 = a fresh top-scores payload was
 * swapped into the map's topscores file (reload it now), -1 = the last fetch
 * failed for good (keep the local file), 0 = nothing new. Called from the
 * gametype's think loop.
 */
int RS_ApiPollTop( void )
{
	ApiState *s = g_state;
	if( !s )
		return 0;
	return s->fetchResult.exchange( 0 );
}

/*
 * RS_ApiReportWrDemo
 *
 * Tell the stats API that a new world record on <mapname> has a downloadable
 * .wd demo at <demoPath> (relative to the game host's demos/ dir; the web
 * builds a download URL from it). Posted to the same /api/ingest endpoint with
 * source "wr_demo"; does not touch the leaderboard. No-op when url is empty.
 */
void RS_ApiReportWrDemo( const char *url, const char *token, const char *version,
	const char *mapname, const char *player, const char *login, int timeMs, const char *demoPath )
{
	if( !url || !url[0] || !mapname || !mapname[0] || !player || !player[0] ||
		timeMs <= 0 || !demoPath || !demoPath[0] )
		return;

	std::string body;
	body.reserve( 256 );
	body += "{\"version\":\"";
	jsonEscapeInto( body, version && version[0] ? version : "wsw 2.1" );
	body += "\",\"map\":\"";
	jsonEscapeInto( body, mapname );
	body += "\",\"source\":\"wr_demo\",\"wr_demo\":{\"name\":\"";
	jsonEscapeInto( body, player );
	body += "\",\"login\":\"";
	jsonEscapeInto( body, login ? login : "" );
	body += "\",\"time\":";
	body += std::to_string( timeMs );
	body += ",\"demo\":\"";
	jsonEscapeInto( body, demoPath );
	body += "\"}}";

	rsQueuePost( url, token, std::move( body ) );
}

/*
 * RS_GhostBegin / RS_GhostFrame / RS_GhostEnd
 *
 * Build a WR ghost upload body incrementally on the script thread (one native
 * call per captured frame) so AngelScript never does an O(n^2) string concat
 * over thousands of frames. Begin resets the accumulator, Frame appends one
 * "[x,y,z,pitch,yaw,roll,vx,vy,vz]", End wraps it into the ingest body and
 * queues the POST to <url> (the central /api/ingest/ghost).
 */
void RS_GhostBegin( void )
{
	g_ghostBuild.clear();
	g_ghostBuild.reserve( 1u << 16 );
	g_ghostBuildFirst = true;
}

void RS_GhostFrame( int x, int y, int z, int pitch, int yaw, int roll, int vx, int vy, int vz, int keys )
{
	if( !g_ghostBuildFirst )
		g_ghostBuild += ',';
	g_ghostBuildFirst = false;
	char buf[112];
	snprintf( buf, sizeof( buf ), "[%d,%d,%d,%d,%d,%d,%d,%d,%d,%d]",
		x, y, z, pitch, yaw, roll, vx, vy, vz, keys );
	g_ghostBuild += buf;
}

void RS_GhostEnd( const char *url, const char *token, const char *version,
	const char *mapname, const char *player, const char *login,
	int timeMs, int hz, const char *cpsCsv )
{
	if( !url || !url[0] || !mapname || !mapname[0] || !player || !player[0] ||
		timeMs <= 0 || g_ghostBuild.empty() ) {
		g_ghostBuild.clear();
		return;
	}

	std::string body;
	body.reserve( g_ghostBuild.size() + 256 );
	body += "{\"version\":\"";
	jsonEscapeInto( body, version && version[0] ? version : "wsw 2.1" );
	body += "\",\"map\":\"";
	jsonEscapeInto( body, mapname );
	body += "\",\"name\":\"";
	jsonEscapeInto( body, player );
	body += "\",\"login\":\"";
	jsonEscapeInto( body, login ? login : "" );
	body += "\",\"time\":";
	body += std::to_string( timeMs );
	body += ",\"hz\":";
	body += std::to_string( hz > 0 ? hz : 25 );
	body += ",\"cps\":[";
	bool first = true;
	const char *p = cpsCsv ? cpsCsv : "";
	while( *p ) {
		char *end = nullptr;
		long v = strtol( p, &end, 10 );
		if( end == p )
			break;
		if( !first )
			body += ',';
		body += std::to_string( v );
		first = false;
		p = ( *end == ',' ) ? end + 1 : end;
		if( *end != ',' )
			break;
	}
	body += "],\"frames\":[";
	body += g_ghostBuild;
	body += "]}";
	g_ghostBuild.clear();

	rsQueuePost( url, token, std::move( body ) );
}

/*
 * RS_ApiFetchGhost / RS_ApiPollGhost
 *
 * Fetch the current WR ghost for <mapname> from <url> (the central
 * /api/game/ghost endpoint; ?map= appended), parse it in the worker, and make
 * it available to the gametype's in-game WR ghost racer. RS_ApiPollGhost()
 * returns 1 when a fresh ghost is loaded (copy it out via the getters below),
 * -1 when the last fetch failed for good (404 = no WR ghost yet), 0 otherwise.
 */
void RS_ApiFetchGhost( const char *url, const char *token, const char *mapname )
{
	if( !url || !url[0] || !mapname || !mapname[0] )
		return;
	for( const char *p = mapname; *p; p++ ) {
		char c = *p;
		bool ok = ( c >= 'a' && c <= 'z' ) || ( c >= '0' && c <= '9' ) ||
			c == '_' || c == '.' || c == '-';
		if( !ok ) {
			fprintf( stderr, "rs_api: refusing ghost fetch for unsafe map name\n" );
			return;
		}
	}

	std::string full = std::string( url ) + "?map=" + mapname;
	ApiState *s = ensureStarted();
	unsigned gen = s->fetchGhostGen.fetch_add( 1 ) + 1;
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		if( s->queue.size() >= QUEUE_MAX ) {
			// evict another fetch (reproducible) before a one-shot race report
			bool evicted = false;
			for( std::deque<ApiRequest>::iterator it = s->queue.begin(); it != s->queue.end(); ++it ) {
				if( it->type == REQ_GET_GHOST || it->type == REQ_GET_TOPSCORES || it->type == REQ_GET_PLAYERREC ) {
					s->queue.erase( it );
					evicted = true;
					break;
				}
			}
			if( !evicted ) {
				// No fetch to evict: the whole queue is reports. Spool the
				// oldest instead of silently losing a finish.
				fprintf( stderr, "rs_api: queue full, spooling oldest report\n" );
				spoolReport( s->queue.front() );
				s->queue.pop_front();
			}
		}
		s->queue.push_back( ApiRequest{ std::move( full ), token ? token : "", "", 0,
			REQ_GET_GHOST, "", gen, 0 } );
	}
	s->cv.notify_one();
}

int RS_ApiPollGhost( void )
{
	ApiState *s = g_state;
	if( !s )
		return 0;
	return s->fetchGhostResult.exchange( 0 );
}

// Getters for the loaded WR ghost. Called from the script thread after a poll
// of 1; each briefly locks ghostMutex and copies out. The string getters use a
// static buffer the AngelScript wrapper copies immediately (no reentrancy on
// the single script thread).
int RS_GhostLoadedFrames( void )
{
	ApiState *s = g_state;
	if( !s )
		return 0;
	std::lock_guard<std::mutex> lock( s->ghostMutex );
	return s->ghostFrameCount;
}

int RS_GhostLoadedHz( void )
{
	ApiState *s = g_state;
	if( !s )
		return 0;
	std::lock_guard<std::mutex> lock( s->ghostMutex );
	return s->ghostHz;
}

int RS_GhostLoadedTime( void )
{
	ApiState *s = g_state;
	if( !s )
		return 0;
	std::lock_guard<std::mutex> lock( s->ghostMutex );
	return s->ghostTime;
}

const char *RS_GhostLoadedName( void )
{
	static std::string buf;
	ApiState *s = g_state;
	if( !s ) {
		buf.clear();
		return buf.c_str();
	}
	std::lock_guard<std::mutex> lock( s->ghostMutex );
	buf = s->ghostName;
	return buf.c_str();
}

const char *RS_GhostLoadedCps( void )
{
	static std::string buf;
	ApiState *s = g_state;
	if( !s ) {
		buf.clear();
		return buf.c_str();
	}
	std::lock_guard<std::mutex> lock( s->ghostMutex );
	buf = s->ghostCps;
	return buf.c_str();
}

const char *RS_GhostFrameAt( int i )
{
	static char buf[128];
	buf[0] = '\0';
	ApiState *s = g_state;
	if( !s )
		return buf;
	std::lock_guard<std::mutex> lock( s->ghostMutex );
	if( i < 0 || i >= s->ghostFrameCount || (size_t)( i * 9 + 8 ) >= s->ghostFrames.size() )
		return buf;
	const int *f = &s->ghostFrames[(size_t)i * 9];
	snprintf( buf, sizeof( buf ), "%d %d %d %d %d %d %d %d %d",
		f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8] );
	return buf;
}

/*
 * RS_ApiFetchBlocked / RS_ApiPollBlocked / RS_BlockedListText
 *
 * Fetch the central map blocklist from <url> (the public
 * /api/game/blocked-maps endpoint: plain text, one lowercased map name per
 * line, empty body = nothing blocked) into memory. RS_ApiPollBlocked() returns
 * 1 when a fresh list has landed (read it with RS_BlockedListText and parse it),
 * -1 when the last fetch failed for good, 0 otherwise. The gametype refreshes
 * this every ~30s so a map blocked in the web admin drops out of the in-game
 * vote pool without a server restart. A newer fetch supersedes an in-flight one;
 * a failed fetch leaves the last good list in place. No-op when url is empty.
 */
void RS_ApiFetchBlocked( const char *url, const char *token )
{
	if( !url || !url[0] )
		return;

	ApiState *s = ensureStarted();
	unsigned gen = s->fetchBlockedGen.fetch_add( 1 ) + 1;
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		if( s->queue.size() >= QUEUE_MAX ) {
			// evict another fetch (fully reproducible next interval) before a
			// one-shot race report
			bool evicted = false;
			for( std::deque<ApiRequest>::iterator it = s->queue.begin(); it != s->queue.end(); ++it ) {
				if( it->type == REQ_GET_BLOCKED || it->type == REQ_GET_GHOST || it->type == REQ_GET_TOPSCORES || it->type == REQ_GET_PLAYERREC ) {
					s->queue.erase( it );
					evicted = true;
					break;
				}
			}
			if( !evicted ) {
				// No fetch to evict: the whole queue is reports. Spool the
				// oldest instead of silently losing a finish.
				fprintf( stderr, "rs_api: queue full, spooling oldest report\n" );
				spoolReport( s->queue.front() );
				s->queue.pop_front();
			}
		}
		s->queue.push_back( ApiRequest{ url, token ? token : "", "", 0,
			REQ_GET_BLOCKED, "", gen, 0 } );
	}
	s->cv.notify_one();
}

int RS_ApiPollBlocked( void )
{
	ApiState *s = g_state;
	if( !s )
		return 0;
	return s->fetchBlockedResult.exchange( 0 );
}

// Copy out the last-fetched blocklist text. Called from the script thread after
// a poll of 1; the AngelScript wrapper copies the static buffer immediately (no
// reentrancy on the single script thread).
const char *RS_BlockedListText( void )
{
	static std::string buf;
	ApiState *s = g_state;
	if( !s ) {
		buf.clear();
		return buf.c_str();
	}
	std::lock_guard<std::mutex> lock( s->blockedMutex );
	buf = s->blockedText;
	return buf.c_str();
}

/*
 * RS_ApiFetchMapWeapons / RS_ApiPollMapWeapons / RS_MapWeaponsText
 *
 * Fetch the per-map weapon table from <url> (the public /api/game/map-weapons
 * endpoint: plain text, one "<map> code code ..." line per map, a bare name =
 * strafe) into memory. RS_ApiPollMapWeapons() returns 1 when a CHANGED table has
 * landed (read it with RS_MapWeaponsText and parse it), -1 when the last fetch
 * failed for good, 0 otherwise. The gametype refreshes this rarely (the table
 * only moves when the maps are re-scanned) so `callvote randmap rl` / `randmap
 * strafe` can filter the vote pool by what a map plays like. A newer fetch
 * supersedes an in-flight one; a failed fetch leaves the last good table in
 * place. No-op when url is empty.
 */
void RS_ApiFetchMapWeapons( const char *url, const char *token )
{
	if( !url || !url[0] )
		return;

	ApiState *s = ensureStarted();
	unsigned gen = s->fetchMapWeaponsGen.fetch_add( 1 ) + 1;
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		if( s->queue.size() >= QUEUE_MAX ) {
			// evict another fetch (fully reproducible next interval) before a
			// one-shot race report
			bool evicted = false;
			for( std::deque<ApiRequest>::iterator it = s->queue.begin(); it != s->queue.end(); ++it ) {
				if( it->type == REQ_GET_MAPWEAPONS || it->type == REQ_GET_RANKS ||
					it->type == REQ_GET_MOTD || it->type == REQ_GET_ANNOUNCE || it->type == REQ_GET_BLOCKED ||
					it->type == REQ_GET_GHOST || it->type == REQ_GET_TOPSCORES || it->type == REQ_GET_PLAYERREC ) {
					s->queue.erase( it );
					evicted = true;
					break;
				}
			}
			if( !evicted ) {
				// No fetch to evict: the whole queue is reports. Spool the
				// oldest instead of silently losing a finish.
				fprintf( stderr, "rs_api: queue full, spooling oldest report\n" );
				spoolReport( s->queue.front() );
				s->queue.pop_front();
			}
		}
		s->queue.push_back( ApiRequest{ url, token ? token : "", "", 0,
			REQ_GET_MAPWEAPONS, "", gen, 0 } );
	}
	s->cv.notify_one();
}

int RS_ApiPollMapWeapons( void )
{
	ApiState *s = g_state;
	if( !s )
		return 0;
	return s->fetchMapWeaponsResult.exchange( 0 );
}

// Copy out the last-fetched map-weapons table. Called from the script thread
// after a poll of 1; the AngelScript wrapper copies the static buffer
// immediately (no reentrancy on the single script thread).
const char *RS_MapWeaponsText( void )
{
	static std::string buf;
	ApiState *s = g_state;
	if( !s ) {
		buf.clear();
		return buf.c_str();
	}
	std::lock_guard<std::mutex> lock( s->mapWeaponsMutex );
	buf = s->mapWeaponsText;
	return buf.c_str();
}

/*
 * RS_ApiFetchLastMaps / RS_ApiPollLastMaps / RS_LastMapsText
 *
 * Fetch the recently-played map list from <url> (the public /api/game/last-maps
 * endpoint: plain text, one lowercased map name per line, most-recent first,
 * empty body = nothing finished yet) into memory. RS_ApiPollLastMaps() returns 1
 * when a CHANGED list has landed (read it with RS_LastMapsText and parse it), -1
 * when the last fetch failed for good, 0 otherwise. The gametype (hrace/
 * lastmaps.as) refreshes this every ~60s so the in-game /lastmaps command answers
 * instantly from the cached list. A newer fetch supersedes an in-flight one; a
 * failed fetch leaves the last good list in place. No-op when url is empty.
 */
void RS_ApiFetchLastMaps( const char *url, const char *token )
{
	if( !url || !url[0] )
		return;

	ApiState *s = ensureStarted();
	unsigned gen = s->fetchLastMapsGen.fetch_add( 1 ) + 1;
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		if( s->queue.size() >= QUEUE_MAX ) {
			// evict another fetch (fully reproducible next interval) before a
			// one-shot race report
			bool evicted = false;
			for( std::deque<ApiRequest>::iterator it = s->queue.begin(); it != s->queue.end(); ++it ) {
				if( it->type == REQ_GET_LASTMAPS || it->type == REQ_GET_MAPWEAPONS ||
					it->type == REQ_GET_RANKS || it->type == REQ_GET_MOTD || it->type == REQ_GET_ANNOUNCE ||
					it->type == REQ_GET_BLOCKED || it->type == REQ_GET_GHOST ||
					it->type == REQ_GET_TOPSCORES || it->type == REQ_GET_PLAYERREC ) {
					s->queue.erase( it );
					evicted = true;
					break;
				}
			}
			if( !evicted ) {
				// No fetch to evict: the whole queue is reports. Spool the
				// oldest instead of silently losing a finish.
				fprintf( stderr, "rs_api: queue full, spooling oldest report\n" );
				spoolReport( s->queue.front() );
				s->queue.pop_front();
			}
		}
		s->queue.push_back( ApiRequest{ url, token ? token : "", "", 0,
			REQ_GET_LASTMAPS, "", gen, 0 } );
	}
	s->cv.notify_one();
}

int RS_ApiPollLastMaps( void )
{
	ApiState *s = g_state;
	if( !s )
		return 0;
	return s->fetchLastMapsResult.exchange( 0 );
}

// Copy out the last-fetched recently-played list. Called from the script thread
// after a poll of 1; the AngelScript wrapper copies the static buffer immediately
// (no reentrancy on the single script thread).
const char *RS_LastMapsText( void )
{
	static std::string buf;
	ApiState *s = g_state;
	if( !s ) {
		buf.clear();
		return buf.c_str();
	}
	std::lock_guard<std::mutex> lock( s->lastMapsMutex );
	buf = s->lastMapsText;
	return buf.c_str();
}

/*
 * RS_ApiFetchMotd / RS_ApiPollMotd / RS_MotdText
 *
 * Fetch the central message of the day from <url> (the public /api/game/motd
 * endpoint: an "RSMOTD" header line, then the text verbatim — possibly empty,
 * meaning "show no MOTD") into memory. RS_ApiPollMotd() returns 1 when a
 * CHANGED payload has landed (read it with RS_MotdText and set sv_MOTDString),
 * -1 when the last fetch failed for good, 0 otherwise. The gametype refreshes
 * this every ~60s so an MOTD edited in the web admin shows to newly connecting
 * players without a server restart. A newer fetch supersedes an in-flight one;
 * a failed fetch leaves the last good text (and thus the cvar) in place.
 * No-op when url is empty.
 */
void RS_ApiFetchMotd( const char *url, const char *token )
{
	if( !url || !url[0] )
		return;

	ApiState *s = ensureStarted();
	unsigned gen = s->fetchMotdGen.fetch_add( 1 ) + 1;
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		if( s->queue.size() >= QUEUE_MAX ) {
			// evict another fetch (fully reproducible next interval) before a
			// one-shot race report
			bool evicted = false;
			for( std::deque<ApiRequest>::iterator it = s->queue.begin(); it != s->queue.end(); ++it ) {
				if( it->type == REQ_GET_MOTD || it->type == REQ_GET_ANNOUNCE || it->type == REQ_GET_BLOCKED ||
					it->type == REQ_GET_GHOST || it->type == REQ_GET_TOPSCORES || it->type == REQ_GET_PLAYERREC ) {
					s->queue.erase( it );
					evicted = true;
					break;
				}
			}
			if( !evicted ) {
				// No fetch to evict: the whole queue is reports. Spool the
				// oldest instead of silently losing a finish.
				fprintf( stderr, "rs_api: queue full, spooling oldest report\n" );
				spoolReport( s->queue.front() );
				s->queue.pop_front();
			}
		}
		s->queue.push_back( ApiRequest{ url, token ? token : "", "", 0,
			REQ_GET_MOTD, "", gen, 0 } );
	}
	s->cv.notify_one();
}

int RS_ApiPollMotd( void )
{
	ApiState *s = g_state;
	if( !s )
		return 0;
	return s->fetchMotdResult.exchange( 0 );
}

// Copy out the last-fetched MOTD text (header stripped). Called from the script
// thread after a poll of 1; the AngelScript wrapper copies the static buffer
// immediately (no reentrancy on the single script thread). The web already
// sanitizes on save, but the text ends up inside the quoted argument of the
// engine's `motd 1 "<text>"` game command, so defend here too: a double quote
// becomes a single quote and control characters other than newline are
// dropped. The engine itself truncates at MAX_MOTD_LEN (1024).
const char *RS_MotdText( void )
{
	static std::string buf;
	buf.clear();
	ApiState *s = g_state;
	if( !s )
		return buf.c_str();
	std::lock_guard<std::mutex> lock( s->motdMutex );
	if( s->motdRaw.compare( 0, 7, "RSMOTD\n" ) != 0 )
		return buf.c_str(); // never fetched
	buf.reserve( s->motdRaw.size() );
	for( size_t i = 7; i < s->motdRaw.size(); i++ ) {
		unsigned char c = (unsigned char)s->motdRaw[i];
		if( c == '"' )
			buf += '\'';
		else if( c == '\n' || c >= 0x20 )
			buf += (char)c;
	}
	return buf.c_str();
}

/*
 * RS_ApiFetchAnnounce / RS_ApiPollAnnounce / RS_AnnounceText
 *
 * Fetch the rotating in-game announcements from <url> (the public
 * /api/game/announcements endpoint: an "RSANN" header line, then one message
 * per following line — possibly none, meaning "no announcements") into memory.
 * RS_ApiPollAnnounce() returns 1 when a CHANGED payload has landed (read it
 * with RS_AnnounceText, split on newlines and rotate), -1 when the last fetch
 * failed for good, 0 otherwise. The gametype refreshes this every ~60s so a
 * message edited in the web admin rotates in without a server restart. A newer
 * fetch supersedes an in-flight one; a failed fetch leaves the last good list
 * in place. No-op when url is empty. Same handshake as RS_ApiFetchMotd.
 */
void RS_ApiFetchAnnounce( const char *url, const char *token )
{
	if( !url || !url[0] )
		return;

	ApiState *s = ensureStarted();
	unsigned gen = s->fetchAnnounceGen.fetch_add( 1 ) + 1;
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		if( s->queue.size() >= QUEUE_MAX ) {
			// evict another fetch (fully reproducible next interval) before a
			// one-shot race report
			bool evicted = false;
			for( std::deque<ApiRequest>::iterator it = s->queue.begin(); it != s->queue.end(); ++it ) {
				if( it->type == REQ_GET_MOTD || it->type == REQ_GET_ANNOUNCE || it->type == REQ_GET_BLOCKED ||
					it->type == REQ_GET_GHOST || it->type == REQ_GET_TOPSCORES || it->type == REQ_GET_PLAYERREC ) {
					s->queue.erase( it );
					evicted = true;
					break;
				}
			}
			if( !evicted ) {
				// No fetch to evict: the whole queue is reports. Spool the
				// oldest instead of silently losing a finish.
				fprintf( stderr, "rs_api: queue full, spooling oldest report\n" );
				spoolReport( s->queue.front() );
				s->queue.pop_front();
			}
		}
		s->queue.push_back( ApiRequest{ url, token ? token : "", "", 0,
			REQ_GET_ANNOUNCE, "", gen, 0 } );
	}
	s->cv.notify_one();
}

int RS_ApiPollAnnounce( void )
{
	ApiState *s = g_state;
	if( !s )
		return 0;
	return s->fetchAnnounceResult.exchange( 0 );
}

// Copy out the last-fetched announcement list (header stripped). Called from the
// script thread after a poll of 1; the AngelScript wrapper copies the static
// buffer immediately (no reentrancy on the single script thread). Newlines are
// KEPT — they separate the individual messages the gametype rotates through —
// while other control characters are dropped. Quotes are left intact: the text
// goes straight to G_PrintMsg, not into a quoted game command.
const char *RS_AnnounceText( void )
{
	static std::string buf;
	buf.clear();
	ApiState *s = g_state;
	if( !s )
		return buf.c_str();
	std::lock_guard<std::mutex> lock( s->announceMutex );
	if( s->announceRaw.compare( 0, 6, "RSANN\n" ) != 0 )
		return buf.c_str(); // never fetched
	buf.reserve( s->announceRaw.size() );
	for( size_t i = 6; i < s->announceRaw.size(); i++ ) {
		unsigned char c = (unsigned char)s->announceRaw[i];
		if( c == '\n' || c >= 0x20 )
			buf += (char)c;
	}
	return buf.c_str();
}

/*
 * RS_ApiFetchRanks / RS_ApiPollRanks / RS_RanksText
 *
 * Fetch the map's live global ranks from <url> (the central /api/game/ranks
 * endpoint; ?map=<mapname> is appended) into memory. Unlike topscores (top-50),
 * this lists EVERY finisher so the in-game scoreboard can show a true rank for
 * players ranked past 50. RS_ApiPollRanks() returns 1 when a CHANGED payload has
 * landed (read it with RS_RanksText and re-apply it to the connected players),
 * -1 when the last fetch failed for good (404 = no records for this map yet), 0
 * otherwise. The gametype (hrace/ranks.as) refreshes this ~60s. A newer fetch
 * supersedes an in-flight one; a failed fetch leaves the last good blob in
 * place. No-op when url is empty.
 */
void RS_ApiFetchRanks( const char *url, const char *token, const char *mapname )
{
	if( !url || !url[0] || !mapname || !mapname[0] )
		return;

	// The map name rides in the query string - accept the same character set the
	// stats API allows and refuse anything else outright.
	for( const char *p = mapname; *p; p++ ) {
		char c = *p;
		bool ok = ( c >= 'a' && c <= 'z' ) || ( c >= '0' && c <= '9' ) ||
			c == '_' || c == '.' || c == '-';
		if( !ok ) {
			fprintf( stderr, "rs_api: refusing ranks fetch for unsafe map name\n" );
			return;
		}
	}

	std::string full = std::string( url ) + "?map=" + mapname;
	ApiState *s = ensureStarted();
	unsigned gen = s->fetchRanksGen.fetch_add( 1 ) + 1;
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		if( s->queue.size() >= QUEUE_MAX ) {
			// evict another fetch (fully reproducible next interval) before a
			// one-shot race report
			bool evicted = false;
			for( std::deque<ApiRequest>::iterator it = s->queue.begin(); it != s->queue.end(); ++it ) {
				if( it->type == REQ_GET_RANKS || it->type == REQ_GET_MOTD || it->type == REQ_GET_ANNOUNCE ||
					it->type == REQ_GET_BLOCKED || it->type == REQ_GET_GHOST ||
					it->type == REQ_GET_TOPSCORES || it->type == REQ_GET_PLAYERREC ) {
					s->queue.erase( it );
					evicted = true;
					break;
				}
			}
			if( !evicted ) {
				// No fetch to evict: the whole queue is reports. Spool the
				// oldest instead of silently losing a finish.
				fprintf( stderr, "rs_api: queue full, spooling oldest report\n" );
				spoolReport( s->queue.front() );
				s->queue.pop_front();
			}
		}
		s->queue.push_back( ApiRequest{ std::move( full ), token ? token : "", "", 0,
			REQ_GET_RANKS, "", gen, 0 } );
	}
	s->cv.notify_one();
}

int RS_ApiPollRanks( void )
{
	ApiState *s = g_state;
	if( !s )
		return 0;
	return s->fetchRanksResult.exchange( 0 );
}

// Copy out the last-fetched ranks blob. Called from the script thread after a
// poll of 1; the AngelScript wrapper copies the static buffer immediately (no
// reentrancy on the single script thread).
const char *RS_RanksText( void )
{
	static std::string buf;
	ApiState *s = g_state;
	if( !s ) {
		buf.clear();
		return buf.c_str();
	}
	std::lock_guard<std::mutex> lock( s->ranksMutex );
	buf = s->ranksText;
	return buf.c_str();
}


/*
 * RS_ApiFetchPlayerRecord / RS_ApiPollPlayerRecord / RS_PlayerRecordText
 *
 * Fetch ONE player's personal best on <mapname> from <url> (the central
 * /api/game/player-record endpoint; ?map=<map>&name=<urlencoded cleanName> is
 * appended) into a PER-PLAYER slot (keyed by playerNum), so the gametype
 * (hrace/playerrecord.as) can seed that player's best_recordTime - rank, finish
 * time AND checkpoint splits - the moment they join. Unlike the map-wide fetches
 * above (one shared slot), several joining players can be in flight at once.
 * RS_ApiPollPlayerRecord(playerNum) returns 1 when a fresh payload has landed for
 * that slot (read it with RS_PlayerRecordText(playerNum) and parse it), -1 when
 * the last fetch failed for good OR the player has no record here (404 / empty
 * body - both fail-open: keep the board seed), 0 otherwise. A newer fetch on the
 * same slot (re-join / rename) supersedes an in-flight one. No-op when url is
 * empty. The player name is URL-encoded (it can carry spaces / '&' / UTF-8).
 */
void RS_ApiFetchPlayerRecord( const char *url, const char *token, const char *mapname,
	const char *cleanName, int playerNum )
{
	if( !url || !url[0] || !mapname || !mapname[0] || !cleanName )
		return;
	if( playerNum < 0 || playerNum >= ApiState::RS_PLAYERREC_MAX )
		return;

	// The map name rides in the query string - accept the same character set the
	// stats API allows and refuse anything else outright. (The name is encoded
	// instead of charset-guarded.)
	for( const char *p = mapname; *p; p++ ) {
		char c = *p;
		bool ok = ( c >= 'a' && c <= 'z' ) || ( c >= '0' && c <= '9' ) ||
			c == '_' || c == '.' || c == '-';
		if( !ok ) {
			fprintf( stderr, "rs_api: refusing player-record fetch for unsafe map name\n" );
			return;
		}
	}

	std::string full = std::string( url ) + "?map=" + mapname + "&name=" + urlEncode( cleanName );
	ApiState *s = ensureStarted();
	// Bump the slot's generation (supersedes any in-flight fetch), THEN clear any
	// stale result still sitting in the slot. This matters because slots are
	// REUSED across players: if the previous occupant's fetch completed but they
	// left before their poll consumed the result, the new occupant's first poll
	// would otherwise read that stale 1 and apply the PREVIOUS player's record.
	// Clearing here (after the gen bump, so a concurrent completion of the old
	// fetch sees the new gen and drops) guarantees the poller returns 0 until THIS
	// fetch lands. Order is load-bearing: gen first, result second.
	unsigned gen = s->fetchPlayerRecGen[playerNum].fetch_add( 1 ) + 1;
	s->fetchPlayerRecResult[playerNum].store( 0 );
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		if( s->queue.size() >= QUEUE_MAX ) {
			// evict another fetch (fully reproducible on the next join) before a
			// one-shot race report
			bool evicted = false;
			for( std::deque<ApiRequest>::iterator it = s->queue.begin(); it != s->queue.end(); ++it ) {
				if( it->type == REQ_GET_PLAYERREC || it->type == REQ_GET_RANKS ||
					it->type == REQ_GET_MOTD || it->type == REQ_GET_ANNOUNCE || it->type == REQ_GET_BLOCKED ||
					it->type == REQ_GET_GHOST || it->type == REQ_GET_TOPSCORES ) {
					s->queue.erase( it );
					evicted = true;
					break;
				}
			}
			if( !evicted ) {
				// No fetch to evict: the whole queue is reports. Spool the
				// oldest instead of silently losing a finish.
				fprintf( stderr, "rs_api: queue full, spooling oldest report\n" );
				spoolReport( s->queue.front() );
				s->queue.pop_front();
			}
		}
		s->queue.push_back( ApiRequest{ std::move( full ), token ? token : "", "", 0,
			REQ_GET_PLAYERREC, "", gen, playerNum } );
	}
	s->cv.notify_one();
}

int RS_ApiPollPlayerRecord( int playerNum )
{
	ApiState *s = g_state;
	if( !s || playerNum < 0 || playerNum >= ApiState::RS_PLAYERREC_MAX )
		return 0;
	return s->fetchPlayerRecResult[playerNum].exchange( 0 );
}

// Copy out the last-fetched per-player record payload for a slot. Called from
// the script thread after a poll of 1; the AngelScript wrapper copies the static
// buffer immediately (no reentrancy on the single script thread).
const char *RS_PlayerRecordText( int playerNum )
{
	static std::string buf;
	ApiState *s = g_state;
	if( !s || playerNum < 0 || playerNum >= ApiState::RS_PLAYERREC_MAX ) {
		buf.clear();
		return buf.c_str();
	}
	std::lock_guard<std::mutex> lock( s->playerRecMutex );
	buf = s->playerRecText[playerNum];
	return buf.c_str();
}


/*
 * RS_ApiFetchSavedStart / RS_ApiPollSavedStart / RS_SavedStartText
 *
 * Per-player fetch of ONE player's saved start(s) on <mapname> from <url> (the
 * central /api/game/saved-start endpoint; ?map=<map>&name=<urlencoded name> is
 * appended), keyed by playerNum into a per-slot buffer - the exact shape of the
 * player-record trio above, so several joiners can be in flight at once. The
 * gametype (hrace/savedstarts.as) parses the "//starts" payload and teleports
 * the player to their saved spot. RS_ApiPollSavedStart(playerNum) returns 1 when
 * a fresh payload landed, -1 on a hard failure / unknown map (fail-open), else 0.
 */
void RS_ApiFetchSavedStart( const char *url, const char *token, const char *mapname,
	const char *cleanName, int playerNum )
{
	if( !url || !url[0] || !mapname || !mapname[0] || !cleanName )
		return;
	if( playerNum < 0 || playerNum >= ApiState::RS_PLAYERREC_MAX )
		return;

	// Map name rides in the query string - same charset guard as the other map
	// fetches; the player name is percent-encoded instead.
	for( const char *p = mapname; *p; p++ ) {
		char c = *p;
		bool ok = ( c >= 'a' && c <= 'z' ) || ( c >= '0' && c <= '9' ) ||
			c == '_' || c == '.' || c == '-';
		if( !ok ) {
			fprintf( stderr, "rs_api: refusing saved-start fetch for unsafe map name\n" );
			return;
		}
	}

	std::string full = std::string( url ) + "?map=" + mapname + "&name=" + urlEncode( cleanName );
	ApiState *s = ensureStarted();
	// gen first, result second (see RS_ApiFetchPlayerRecord): slots are reused
	// across players, so clear any stale result the previous occupant left behind.
	unsigned gen = s->fetchSavedStartGen[playerNum].fetch_add( 1 ) + 1;
	s->fetchSavedStartResult[playerNum].store( 0 );
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		if( s->queue.size() >= QUEUE_MAX ) {
			bool evicted = false;
			for( std::deque<ApiRequest>::iterator it = s->queue.begin(); it != s->queue.end(); ++it ) {
				if( it->type == REQ_GET_SAVEDSTART || it->type == REQ_GET_PLAYERREC ||
					it->type == REQ_GET_RANKS || it->type == REQ_GET_MOTD || it->type == REQ_GET_ANNOUNCE ||
					it->type == REQ_GET_BLOCKED || it->type == REQ_GET_GHOST ||
					it->type == REQ_GET_TOPSCORES ) {
					s->queue.erase( it );
					evicted = true;
					break;
				}
			}
			if( !evicted ) {
				fprintf( stderr, "rs_api: queue full, spooling oldest report\n" );
				spoolReport( s->queue.front() );
				s->queue.pop_front();
			}
		}
		s->queue.push_back( ApiRequest{ std::move( full ), token ? token : "", "", 0,
			REQ_GET_SAVEDSTART, "", gen, playerNum } );
	}
	s->cv.notify_one();
}

int RS_ApiPollSavedStart( int playerNum )
{
	ApiState *s = g_state;
	if( !s || playerNum < 0 || playerNum >= ApiState::RS_PLAYERREC_MAX )
		return 0;
	return s->fetchSavedStartResult[playerNum].exchange( 0 );
}

const char *RS_SavedStartText( int playerNum )
{
	static std::string buf;
	ApiState *s = g_state;
	if( !s || playerNum < 0 || playerNum >= ApiState::RS_PLAYERREC_MAX ) {
		buf.clear();
		return buf.c_str();
	}
	std::lock_guard<std::mutex> lock( s->savedStartMutex );
	buf = s->savedStartText[playerNum];
	return buf.c_str();
}

/*
 * RS_ApiSaveStart - fire-and-forget POST of a player's saved start to <url>
 * (/api/ingest/saved-start), or a DELETE of that direction when coords is empty.
 * Same queued-POST path as RS_ApiFlag. `coords` is a pre-formatted, purely
 * numeric "x y z pitch yaw roll" string built by the gametype.
 */
void RS_ApiSaveStart( const char *url, const char *token, const char *mapname,
	const char *player, const char *login, const char *mode, const char *coords )
{
	if( !url || !url[0] || !mapname || !mapname[0] || !player || !player[0] )
		return;

	std::string body;
	body.reserve( 192 );
	body += "{\"map\":\"";
	jsonEscapeInto( body, mapname );
	body += "\",\"name\":\"";
	jsonEscapeInto( body, player );
	body += "\",\"login\":\"";
	jsonEscapeInto( body, login ? login : "" );
	body += "\",\"mode\":\"";
	jsonEscapeInto( body, mode ? mode : "" );
	body += "\",\"coords\":\"";
	jsonEscapeInto( body, coords ? coords : "" );
	body += "\"}";

	rsQueuePost( url, token, std::move( body ) );
}
