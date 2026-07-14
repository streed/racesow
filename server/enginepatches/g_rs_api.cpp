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

// note: no default member initializers — the game module builds as C++11,
// where they would make this a non-aggregate and break brace-initialization
struct ApiRequest {
	std::string url;
	std::string token;
	std::string body;
	int attempts;
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

	ApiState() : stop( false ) {}
};

ApiState *g_state = nullptr;

// Swallow the response body; we only care about the status code.
size_t discardBody( void *, size_t size, size_t nmemb, void * )
{
	return size * nmemb;
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

		long status = doPost( req );
		if( status >= 200 && status < 300 )
			continue;

		bool permanent = status >= 400 && status < 500;
		req.attempts++;
		if( permanent || req.attempts >= MAX_ATTEMPTS ) {
			fprintf( stderr, "rs_api: dropping report after %d attempt(s), status %ld: %s\n",
				req.attempts, status, req.body.c_str() );
			continue;
		}

		// brief pause, then requeue at the back
		if( !s->stop.load() )
			std::this_thread::sleep_for( std::chrono::seconds( 2 ) );
		{
			std::lock_guard<std::mutex> lock( s->mutex );
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
 * (the finish time is not part of the list). No-op when url is empty.
 */
void RS_ApiReportRace( const char *url, const char *token, const char *version,
	const char *mapname, const char *player, const char *login,
	int timeMs, const char *cpsCsv )
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
		s->queue.push_back( ApiRequest{ url, token ? token : "", std::move( body ), 0 } );
	}
	s->cv.notify_one();
}
