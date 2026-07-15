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
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>

namespace {

enum RequestType {
	REQ_POST_REPORT,  // fire-and-forget race finish -> /api/ingest
	REQ_GET_TOPSCORES // live top scores -> swapped into the local topscores file
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
	unsigned gen;         // REQ_GET_TOPSCORES: fetch generation (stale = discard)
};

constexpr size_t QUEUE_MAX = 256;
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

	ApiState() : stop( false ), fetchGen( 0 ), fetchResult( 0 ) {}
};

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

void workerMain( ApiState *s )
{
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
		if( req.type == REQ_GET_TOPSCORES ) {
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
		} else {
			status = doPost( req );
			if( status >= 200 && status < 300 )
				continue;

			bool permanent = status >= 400 && status < 500;
			req.attempts++;
			// During shutdown a report gets exactly the attempt it just had:
			// endless retry rounds against a dead API would stall the drain
			// far past any container stop grace, losing the reports anyway.
			if( permanent || req.attempts >= MAX_ATTEMPTS || s->stop.load() ) {
				fprintf( stderr, "rs_api: dropping report after %d attempt(s), status %ld: %s\n",
					req.attempts, status, req.body.c_str() );
				continue;
			}
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
// is still queued (bounded by MAX_ATTEMPTS, so this cannot hang forever).
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

/*
 * RS_ApiReportRace
 *
 * Queue one finished race for delivery to <url> (the central /api/ingest).
 * cpsCsv is the comma-separated absolute checkpoint times in milliseconds
 * (the finish time is not part of the list). attemptsSinceLast is the number
 * of race STARTS since this player's last flush, including the start that
 * produced this finish (pass a negative value to omit — the API then counts
 * the finish as a single attempt). No-op when url is empty.
 */
void RS_ApiReportRace( const char *url, const char *token, const char *version,
	const char *mapname, const char *player, const char *login,
	int timeMs, int attemptsSinceLast, const char *cpsCsv )
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
	body += "]}]}";

	ApiState *s = ensureStarted();
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		if( s->queue.size() >= QUEUE_MAX ) {
			fprintf( stderr, "rs_api: queue full, dropping oldest report\n" );
			s->queue.pop_front();
		}
		s->queue.push_back( ApiRequest{ url, token ? token : "", std::move( body ), 0,
			REQ_POST_REPORT, "", 0 } );
	}
	s->cv.notify_one();
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
	const char *mapname, const char *player, const char *login, int count )
{
	if( !url || !url[0] || !mapname || !mapname[0] || !player || !player[0] || count <= 0 )
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
	body += std::to_string( count );
	body += "}]}";

	ApiState *s = ensureStarted();
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		if( s->queue.size() >= QUEUE_MAX ) {
			fprintf( stderr, "rs_api: queue full, dropping oldest report\n" );
			s->queue.pop_front();
		}
		s->queue.push_back( ApiRequest{ url, token ? token : "", std::move( body ), 0,
			REQ_POST_REPORT, "", 0 } );
	}
	s->cv.notify_one();
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
				if( it->type == REQ_GET_TOPSCORES ) {
					s->queue.erase( it );
					evicted = true;
					break;
				}
			}
			if( !evicted ) {
				fprintf( stderr, "rs_api: queue full, dropping oldest report\n" );
				s->queue.pop_front();
			}
		}
		s->queue.push_back( ApiRequest{ std::move( full ), token ? token : "", "", 0,
			REQ_GET_TOPSCORES, std::move( path ), gen } );
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
