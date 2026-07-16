/*
 * racesow-docker: cross-server player mirroring over a UDP mesh.
 *
 * Every server broadcasts its OWN local players (positions at ~10Hz) and
 * locally-originated chat/join/leave events to a static list of peers, and
 * receives the same from them. Hop limit is 1 by construction: received data
 * lands in read-only tables handed to the gametype script and is never
 * serialized back out, so nothing a peer sends can propagate further.
 *
 * This file is copied into source/game/ of the DenMSC racemod_2.1 tree at
 * image build time (the game CMakeLists globs *.cpp) and exposed to the
 * hrace AngelScript gametype as the RS_Mirror* natives via a patch to
 * g_ascript.cpp (see patch-mirror-natives.py, which also hooks Cmd_Say_f in
 * g_cmds.cpp to feed RS_MirrorLocalChat).
 *
 * Wire protocol "RSM1", one text datagram per message, <= 1200 bytes:
 *
 *   RSM1 <mac> <ts> <seq> <type> <tag> <map>\n
 *   <body lines>
 *
 *   mac   32 hex chars: HMAC-SHA256(secret, everything from <ts> to the end
 *         of the datagram) truncated to 128 bits — or "-" when no secret is
 *         configured, in which case the receiver falls back to a source-IP
 *         allowlist built from the resolved peer list (LAN/testing only).
 *   type  S = player state (body: "P <flags> <x y z> <pitch yaw roll>
 *         <vx vy vz> <name>" per player; name last, it may contain spaces),
 *         E = events (body: "<C|J|L> <eventseq>\t<name>\t<text>").
 *
 * State ticks double as keepalive + map advertisement and are sent even with
 * zero players. Events are sent immediately and re-sent once with the next
 * state flush; receivers dedup on a per-peer eventseq window. Everything is
 * fire-and-forget: no acks, no retries, unreachable peers cost nothing.
 *
 * Design constraints:
 *  - The game frame must never block or touch the network: a single worker
 *    thread owns the socket (bind, getaddrinfo, sendto, recvfrom). Natives
 *    called from the game thread only swap data under a briefly-held mutex.
 *  - Same lifetime discipline as g_rs_api.cpp: all state heap-allocated
 *    behind a raw pointer (static C++ destructors run before
 *    __attribute__((destructor)) and would std::terminate on a joinable
 *    thread), worker joined from the destructor, state deliberately leaked.
 *  - Logging from the worker uses stderr only (engine Com_Printf is not
 *    safe off the main thread).
 */

#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/ip.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#include <atomic>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr size_t DGRAM_MAX_SEND = 1200; // stay under a 1500-MTU IPv4 payload
constexpr size_t DGRAM_MAX_RECV = 1400;
constexpr long long STATE_MIN_INTERVAL_MS = 14; // flood guard under the script's ~16ms (60Hz) cadence
constexpr long long PLAYER_TTL_MS = 3000;
constexpr long long PEER_TTL_MS = 15000;
constexpr long long RESOLVE_INTERVAL_MS = 60000; // re-resolve peers (containers change IPs)
constexpr long long STATS_INTERVAL_MS = 30000;   // periodic tx/rx/peers log line
constexpr int POLL_MS = 25;
constexpr int RECV_BATCH = 64;
constexpr long long TS_WINDOW_S = 60;
constexpr size_t MAX_TAGS = 16;
constexpr size_t MAX_PLAYERS_PER_TAG = 32;
constexpr size_t IN_EVENTQ_MAX = 64;
constexpr size_t OUT_EVENTQ_MAX = 32;
constexpr size_t EVENT_DEDUP_WINDOW = 128;
constexpr size_t RESEND_MAX = 32;
constexpr size_t NAME_MAX = 64;
constexpr size_t TEXT_MAX = 256;
constexpr size_t TAG_MAX = 16;

// ---------------------------------------------------------------------------
// Minimal SHA-256 + HMAC (vendored so the module gains no new dependencies).
// ---------------------------------------------------------------------------

const uint32_t SHA_K[64] = {
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

struct Sha256 {
	uint32_t h[8];
	uint64_t bytes;
	unsigned char buf[64];
	size_t fill;
};

inline uint32_t rotr32( uint32_t x, int n ) { return ( x >> n ) | ( x << ( 32 - n ) ); }

void shaInit( Sha256 &c )
{
	static const uint32_t H0[8] = {
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	};
	memcpy( c.h, H0, sizeof( H0 ) );
	c.bytes = 0;
	c.fill = 0;
}

void shaBlock( Sha256 &c, const unsigned char *p )
{
	uint32_t w[64];
	for( int i = 0; i < 16; i++ )
		w[i] = ( (uint32_t)p[i * 4] << 24 ) | ( (uint32_t)p[i * 4 + 1] << 16 ) | ( (uint32_t)p[i * 4 + 2] << 8 ) | p[i * 4 + 3];
	for( int i = 16; i < 64; i++ ) {
		uint32_t s0 = rotr32( w[i - 15], 7 ) ^ rotr32( w[i - 15], 18 ) ^ ( w[i - 15] >> 3 );
		uint32_t s1 = rotr32( w[i - 2], 17 ) ^ rotr32( w[i - 2], 19 ) ^ ( w[i - 2] >> 10 );
		w[i] = w[i - 16] + s0 + w[i - 7] + s1;
	}
	uint32_t a = c.h[0], b = c.h[1], cc = c.h[2], d = c.h[3], e = c.h[4], f = c.h[5], g = c.h[6], hh = c.h[7];
	for( int i = 0; i < 64; i++ ) {
		uint32_t S1 = rotr32( e, 6 ) ^ rotr32( e, 11 ) ^ rotr32( e, 25 );
		uint32_t ch = ( e & f ) ^ ( ~e & g );
		uint32_t t1 = hh + S1 + ch + SHA_K[i] + w[i];
		uint32_t S0 = rotr32( a, 2 ) ^ rotr32( a, 13 ) ^ rotr32( a, 22 );
		uint32_t mj = ( a & b ) ^ ( a & cc ) ^ ( b & cc );
		uint32_t t2 = S0 + mj;
		hh = g; g = f; f = e; e = d + t1; d = cc; cc = b; b = a; a = t1 + t2;
	}
	c.h[0] += a; c.h[1] += b; c.h[2] += cc; c.h[3] += d;
	c.h[4] += e; c.h[5] += f; c.h[6] += g; c.h[7] += hh;
}

void shaUpdate( Sha256 &c, const void *data, size_t n )
{
	const unsigned char *p = (const unsigned char *)data;
	c.bytes += n;
	while( n > 0 ) {
		size_t take = 64 - c.fill;
		if( take > n )
			take = n;
		memcpy( c.buf + c.fill, p, take );
		c.fill += take;
		p += take;
		n -= take;
		if( c.fill == 64 ) {
			shaBlock( c, c.buf );
			c.fill = 0;
		}
	}
}

void shaFinal( Sha256 &c, unsigned char out[32] )
{
	uint64_t bits = c.bytes * 8;
	unsigned char pad = 0x80;
	shaUpdate( c, &pad, 1 );
	unsigned char zero = 0;
	while( c.fill != 56 )
		shaUpdate( c, &zero, 1 );
	unsigned char len[8];
	for( int i = 0; i < 8; i++ )
		len[i] = (unsigned char)( bits >> ( 56 - i * 8 ) );
	shaUpdate( c, len, 8 );
	for( int i = 0; i < 8; i++ ) {
		out[i * 4] = (unsigned char)( c.h[i] >> 24 );
		out[i * 4 + 1] = (unsigned char)( c.h[i] >> 16 );
		out[i * 4 + 2] = (unsigned char)( c.h[i] >> 8 );
		out[i * 4 + 3] = (unsigned char)c.h[i];
	}
}

void hmacSha256( const std::string &key, const char *msg, size_t msglen, unsigned char out[32] )
{
	unsigned char kbuf[64];
	memset( kbuf, 0, sizeof( kbuf ) );
	if( key.size() > 64 ) {
		Sha256 c;
		shaInit( c );
		shaUpdate( c, key.data(), key.size() );
		shaFinal( c, kbuf ); // only fills 32; rest stays zero
	} else {
		memcpy( kbuf, key.data(), key.size() );
	}
	unsigned char ipad[64], opad[64];
	for( int i = 0; i < 64; i++ ) {
		ipad[i] = kbuf[i] ^ 0x36;
		opad[i] = kbuf[i] ^ 0x5c;
	}
	unsigned char inner[32];
	Sha256 c;
	shaInit( c );
	shaUpdate( c, ipad, 64 );
	shaUpdate( c, msg, msglen );
	shaFinal( c, inner );
	shaInit( c );
	shaUpdate( c, opad, 64 );
	shaUpdate( c, inner, 32 );
	shaFinal( c, out );
}

// HMAC truncated to 128 bits as 32 lowercase hex chars.
std::string macHex( const std::string &secret, const char *msg, size_t msglen )
{
	unsigned char full[32];
	hmacSha256( secret, msg, msglen, full );
	static const char hexd[] = "0123456789abcdef";
	std::string out;
	out.resize( 32 );
	for( int i = 0; i < 16; i++ ) {
		out[i * 2] = hexd[full[i] >> 4];
		out[i * 2 + 1] = hexd[full[i] & 0xf];
	}
	return out;
}

bool macEqual( const std::string &a, const std::string &b )
{
	if( a.size() != b.size() )
		return false;
	volatile unsigned char diff = 0;
	for( size_t i = 0; i < a.size(); i++ )
		diff |= (unsigned char)( a[i] ^ b[i] );
	return diff == 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

long long steadyMs()
{
	return std::chrono::duration_cast<std::chrono::milliseconds>(
		std::chrono::steady_clock::now().time_since_epoch() ).count();
}

long long unixNow() { return (long long)time( nullptr ); }

// Tags travel as single space-delimited tokens: restrict to a safe charset.
std::string sanitizeTag( const char *s )
{
	std::string out;
	for( const char *p = s ? s : ""; *p && out.size() < TAG_MAX; p++ ) {
		char c = *p;
		if( ( c >= 'A' && c <= 'Z' ) || ( c >= 'a' && c <= 'z' ) || ( c >= '0' && c <= '9' ) || c == '_' || c == '-' )
			out += c;
	}
	return out;
}

// Map names are single tokens too (quake map names have no spaces).
std::string sanitizeToken( const char *s, size_t maxlen )
{
	std::string out;
	for( const char *p = s ? s : ""; *p && out.size() < maxlen; p++ ) {
		unsigned char c = (unsigned char)*p;
		if( c > 0x20 && c != 0x7f )
			out += (char)tolower( c );
	}
	return out;
}

// Free-text fields (names, chat): kill the protocol delimiters, keep the rest
// (including Warsow ^-color codes).
std::string sanitizeField( const char *s, size_t maxlen )
{
	std::string out;
	for( const char *p = s ? s : ""; *p && out.size() < maxlen; p++ ) {
		unsigned char c = (unsigned char)*p;
		if( c == '\t' || c == '\r' || c == '\n' )
			out += ' ';
		else if( c >= 0x20 || c >= 0x80 )
			out += (char)c;
	}
	return out;
}

uint32_t randomSeed()
{
	uint32_t v = 0;
	FILE *f = fopen( "/dev/urandom", "rb" );
	if( f ) {
		if( fread( &v, sizeof( v ), 1, f ) != 1 )
			v = 0;
		fclose( f );
	}
	if( !v )
		v = (uint32_t)( unixNow() * 2654435761u ) ^ (uint32_t)getpid();
	return v;
}

// Wrap-safe "a is newer than b" for uint32 sequence numbers.
inline bool seqNewer( uint32_t a, uint32_t b ) { return (int32_t)( a - b ) > 0; }

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct Peer {
	std::string host;
	int port;
	sockaddr_in addr;
	bool resolved;
};

struct OutEvent {
	char kind; // 'C' chat, 'J' join, 'L' leave
	std::string name;
	std::string text;
};

struct RemoteRow {
	std::string tag;
	std::string name;
	float pos[3];
	float ang[3]; // pitch yaw roll
	float vel[3];
	int flags;
	long long lastMs;
	uint32_t lastSeq;
};

struct PeerRt {
	std::string map;
	long long lastMs;
	std::deque<uint32_t> seenEvents; // dedup window for eventseq
};

struct InEvent {
	int type; // 1 chat, 2 join, 3 leave
	std::string tag;
	std::string name;
	std::string text;
};

struct SnapRow {
	std::string name;
	std::string tag;
	std::string map;
	std::string state; // "x y z pitch yaw roll vx vy vz flags ageMs"
};

struct PeerSnap {
	std::string tag;
	std::string map;
	int ageMs;         // ms since this peer was last heard from
};

// All mutable state on the heap behind a raw pointer — same rationale as
// ApiState in g_rs_api.cpp: a static object's destructor would run before
// rsMirrorShutdown and std::terminate on the still-joinable worker.
struct MirrorState {
	std::mutex mutex;
	std::condition_variable cv; // wakes the worker from its unconfigured idle wait
	std::thread worker;
	std::atomic<bool> stop;

	// -- config, game thread writes / worker applies (guarded by mutex) --
	bool cfgDirty;
	std::string cfgTag, cfgSecret, cfgPeers, cfgMap;
	int cfgPort;

	// -- outbound game -> worker (guarded by mutex) --
	bool statePending;
	std::string stateRows; // latest wins; worker takes the whole batch
	std::deque<OutEvent> outEvents;

	// -- inbound worker -> game (guarded by mutex) --
	std::map<std::string, RemoteRow> rows;   // key: tag + '\x1f' + name
	std::map<std::string, PeerRt> peersRt;   // key: tag
	std::deque<InEvent> inEvents;
	unsigned long long dropped;
	unsigned long long rxAccepted;           // authenticated datagrams consumed

	// -- game thread only --
	std::string buildRows;
	size_t buildCount;
	std::vector<SnapRow> snapshot;
	std::vector<PeerSnap> peerSnapshot; // heard peers, rebuilt each RS_MirrorRefresh
	InEvent cur;

	// -- worker thread only --
	int fd;
	std::string tag, secret, map, peersRaw;
	int port;
	std::vector<Peer> peers;
	uint32_t seq, eventSeq;
	long long lastFlushMs, lastResolveMs, lastStatsMs;
	unsigned long long txDatagrams;       // sendto() calls (wire datagrams)
	std::vector<std::string> resendLines; // event body lines, re-sent once with the next flush

	MirrorState() :
		stop( false ), cfgDirty( false ), cfgPort( 0 ), statePending( false ), dropped( 0 ),
		rxAccepted( 0 ), buildCount( 0 ), fd( -1 ), port( 0 ), seq( randomSeed() ),
		eventSeq( randomSeed() ), lastFlushMs( 0 ), lastResolveMs( 0 ), lastStatsMs( 0 ),
		txDatagrams( 0 )
	{
		cur.type = 0;
	}
};

MirrorState *g_mirror = nullptr;

// ---------------------------------------------------------------------------
// Worker: socket lifecycle
// ---------------------------------------------------------------------------

void workerBind( MirrorState *s )
{
	if( s->fd >= 0 ) {
		close( s->fd );
		s->fd = -1;
	}
	if( s->port <= 0 )
		return;

	int fd = socket( AF_INET, SOCK_DGRAM | SOCK_NONBLOCK, 0 );
	if( fd < 0 ) {
		fprintf( stderr, "rs_mirror: socket(): %s\n", strerror( errno ) );
		return;
	}
	int one = 1;
	setsockopt( fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof( one ) );
	// Mirror traffic is explicitly low priority (CS1 / "lower effort").
	int tos = 0x20;
	setsockopt( fd, IPPROTO_IP, IP_TOS, &tos, sizeof( tos ) );

	sockaddr_in addr;
	memset( &addr, 0, sizeof( addr ) );
	addr.sin_family = AF_INET;
	addr.sin_addr.s_addr = htonl( INADDR_ANY );
	addr.sin_port = htons( (uint16_t)s->port );
	if( bind( fd, (sockaddr *)&addr, sizeof( addr ) ) != 0 ) {
		fprintf( stderr, "rs_mirror: bind port %d: %s (mirroring idle until reconfigure)\n",
			s->port, strerror( errno ) );
		close( fd );
		return;
	}
	s->fd = fd;
}

// Parse "host:port host:port" (spaces and/or commas) and resolve each peer.
// Resolution happens on the worker so slow/broken DNS can never stall a game
// frame, and is retried periodically because compose containers change IPs.
void resolvePeers( MirrorState *s, const std::string &raw )
{
	std::vector<Peer> fresh;
	size_t i = 0;
	while( i < raw.size() ) {
		while( i < raw.size() && ( raw[i] == ' ' || raw[i] == ',' ) )
			i++;
		size_t start = i;
		while( i < raw.size() && raw[i] != ' ' && raw[i] != ',' )
			i++;
		if( i == start )
			continue;
		std::string spec = raw.substr( start, i - start );
		size_t colon = spec.rfind( ':' );
		Peer p;
		p.host = colon == std::string::npos ? spec : spec.substr( 0, colon );
		p.port = colon == std::string::npos ? s->port : atoi( spec.c_str() + colon + 1 );
		p.resolved = false;
		memset( &p.addr, 0, sizeof( p.addr ) );
		if( !p.host.empty() && p.port > 0 )
			fresh.push_back( p );
	}

	for( size_t n = 0; n < fresh.size(); n++ ) {
		// getaddrinfo blocks (up to ~10s per name on a dead resolver); bail out
		// early if a shutdown is pending so the dlclose join isn't held up for
		// N_peers × the DNS timeout.
		if( s->stop.load() )
			return;

		Peer &p = fresh[n];
		addrinfo hints, *res = nullptr;
		memset( &hints, 0, sizeof( hints ) );
		hints.ai_family = AF_INET;
		hints.ai_socktype = SOCK_DGRAM;
		char portstr[16];
		snprintf( portstr, sizeof( portstr ), "%d", p.port );
		if( getaddrinfo( p.host.c_str(), portstr, &hints, &res ) == 0 && res ) {
			memcpy( &p.addr, res->ai_addr, sizeof( p.addr ) );
			p.resolved = true;
			freeaddrinfo( res );
		} else {
			// Peer may simply not be up yet (compose start order), or DNS is
			// briefly unreachable. Carry forward the previous resolved address
			// if we had one, so a transient lookup failure doesn't silence an
			// already-working peer for a whole resolve cycle.
			for( size_t o = 0; o < s->peers.size(); o++ ) {
				if( s->peers[o].resolved && s->peers[o].host == p.host && s->peers[o].port == p.port ) {
					p.addr = s->peers[o].addr;
					p.resolved = true;
					break;
				}
			}
			if( !p.resolved )
				fprintf( stderr, "rs_mirror: cannot resolve peer %s:%d (will retry)\n", p.host.c_str(), p.port );
		}
	}
	s->peers = fresh;
	s->lastResolveMs = steadyMs();
}

// ---------------------------------------------------------------------------
// Worker: send path
// ---------------------------------------------------------------------------

void sendDatagram( MirrorState *s, char type, const std::string &body )
{
	if( s->fd < 0 || s->tag.empty() )
		return;

	char header[160];
	int hn = snprintf( header, sizeof( header ), "%lld %u %c %s %s\n",
		unixNow(), s->seq++, type, s->tag.c_str(), s->map.empty() ? "-" : s->map.c_str() );
	if( hn <= 0 )
		return;

	std::string canonical;
	canonical.reserve( hn + body.size() );
	canonical.append( header, hn );
	canonical += body;

	std::string mac = s->secret.empty() ? "-" : macHex( s->secret, canonical.data(), canonical.size() );

	std::string dgram;
	dgram.reserve( 5 + mac.size() + 1 + canonical.size() );
	dgram += "RSM1 ";
	dgram += mac;
	dgram += ' ';
	dgram += canonical;

	for( size_t i = 0; i < s->peers.size(); i++ ) {
		if( !s->peers[i].resolved )
			continue;
		// Fire-and-forget: with no mesh up these just go into the void.
		sendto( s->fd, dgram.data(), dgram.size(), 0,
			(const sockaddr *)&s->peers[i].addr, sizeof( s->peers[i].addr ) );
		s->txDatagrams++;
	}
}

// Periodic one-line health report: proves broadcast is flowing (or not)
// without needing game clients — tx counts our datagrams to peers, rx counts
// authenticated datagrams accepted from them, and each heard peer is listed
// with its advertised map and silence age.
void workerStats( MirrorState *s )
{
	long long now = steadyMs();
	if( now - s->lastStatsMs < STATS_INTERVAL_MS )
		return;
	s->lastStatsMs = now;

	std::string peersHeard;
	unsigned long long rx, drop;
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		rx = s->rxAccepted;
		drop = s->dropped;
		for( std::map<std::string, PeerRt>::iterator it = s->peersRt.begin(); it != s->peersRt.end(); ++it ) {
			char buf[128];
			snprintf( buf, sizeof( buf ), "%s%s(%s %.1fs)", peersHeard.empty() ? "" : " ",
				it->first.c_str(), it->second.map.c_str(), ( now - it->second.lastMs ) / 1000.0 );
			peersHeard += buf;
		}
	}
	fprintf( stderr, "rs_mirror: stats tx=%llu rx=%llu drop=%llu heard=[%s]\n",
		s->txDatagrams, rx, drop, peersHeard.c_str() );
}

// Send body lines split into datagrams at line boundaries.
void sendChunked( MirrorState *s, char type, const std::string &lines, bool alwaysSendEmpty )
{
	const size_t budget = DGRAM_MAX_SEND - 160; // header + mac headroom
	if( lines.empty() ) {
		if( alwaysSendEmpty )
			sendDatagram( s, type, lines );
		return;
	}
	size_t pos = 0;
	std::string chunk;
	while( pos < lines.size() ) {
		size_t nl = lines.find( '\n', pos );
		if( nl == std::string::npos )
			nl = lines.size() - 1;
		size_t linelen = nl - pos + 1;
		if( !chunk.empty() && chunk.size() + linelen > budget ) {
			sendDatagram( s, type, chunk );
			chunk.clear();
		}
		chunk.append( lines, pos, linelen );
		pos = nl + 1;
	}
	if( !chunk.empty() )
		sendDatagram( s, type, chunk );
}

void workerSendPass( MirrorState *s )
{
	long long now = steadyMs();

	std::deque<OutEvent> evs;
	std::string state;
	bool flush = false;
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		evs.swap( s->outEvents );
		if( s->statePending && now - s->lastFlushMs >= STATE_MIN_INTERVAL_MS ) {
			state.swap( s->stateRows );
			s->statePending = false;
			flush = true;
		}
	}

	if( !evs.empty() ) {
		std::string lines;
		for( size_t i = 0; i < evs.size(); i++ ) {
			char line[NAME_MAX + TEXT_MAX + 48];
			int n = snprintf( line, sizeof( line ), "%c %u\t%s\t%s\n",
				evs[i].kind, s->eventSeq++, evs[i].name.c_str(), evs[i].text.c_str() );
			if( n <= 0 || (size_t)n >= sizeof( line ) )
				continue;
			lines.append( line, n );
			if( s->resendLines.size() < RESEND_MAX )
				s->resendLines.push_back( std::string( line, n ) );
		}
		sendChunked( s, 'E', lines, false );
	}

	if( flush ) {
		// One state tick even with zero players: keepalive + map advertisement.
		sendChunked( s, 'S', state, true );
		// Loss insurance for events: one re-send with a fresh eventseq-window hit
		// on the receiver deduping the copy that already arrived.
		if( !s->resendLines.empty() ) {
			std::string lines;
			for( size_t i = 0; i < s->resendLines.size(); i++ )
				lines += s->resendLines[i];
			s->resendLines.clear();
			sendChunked( s, 'E', lines, false );
		}
		s->lastFlushMs = now;
	}
}

// ---------------------------------------------------------------------------
// Worker: receive path
// ---------------------------------------------------------------------------

void noteDrop( MirrorState *s )
{
	// Snapshot the counter under the lock, then log OUTSIDE it: fprintf to the
	// container's stderr pipe can block if the log consumer stalls, and the
	// game thread takes this same mutex every frame — logging under it would
	// let a stuck pipe freeze server frames (workerStats already does this).
	unsigned long long d;
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		d = ++s->dropped;
	}
	if( d == 1 || d % 500 == 0 )
		fprintf( stderr, "rs_mirror: dropped %llu unauthenticated/malformed datagram(s)\n", d );
}

void processStateLine( MirrorState *s, const std::string &tag, uint32_t seq, const char *line )
{
	int flags = 0, off = 0;
	float f[9];
	if( sscanf( line, "P %d %f %f %f %f %f %f %f %f %f %n", &flags,
			&f[0], &f[1], &f[2], &f[3], &f[4], &f[5], &f[6], &f[7], &f[8], &off ) < 10 || off <= 0 )
		return;
	// %f parses "nan"/"inf"; reject non-finite coords so they never reach the
	// ghost origin/velocity, the snapshot formatter, or the /watch trace math.
	for( int i = 0; i < 9; i++ )
		if( !std::isfinite( f[i] ) )
			return;
	std::string name = sanitizeField( line + off, NAME_MAX );
	if( name.empty() )
		return;

	std::string key = tag + '\x1f' + name;
	std::map<std::string, RemoteRow>::iterator it = s->rows.find( key );
	if( it == s->rows.end() ) {
		size_t tagRows = 0;
		std::string prefix = tag + '\x1f';
		for( std::map<std::string, RemoteRow>::iterator r = s->rows.lower_bound( prefix );
				r != s->rows.end() && r->first.compare( 0, prefix.size(), prefix ) == 0; ++r )
			tagRows++;
		if( tagRows >= MAX_PLAYERS_PER_TAG )
			return;
		RemoteRow row;
		row.tag = tag;
		row.name = name;
		row.lastSeq = seq;
		it = s->rows.insert( std::make_pair( key, row ) ).first;
	} else if( !seqNewer( seq, it->second.lastSeq ) && seq != it->second.lastSeq ) {
		return; // out-of-order chunk; keep the newer position
	}

	RemoteRow &row = it->second;
	row.pos[0] = f[0]; row.pos[1] = f[1]; row.pos[2] = f[2];
	row.ang[0] = f[3]; row.ang[1] = f[4]; row.ang[2] = f[5];
	row.vel[0] = f[6]; row.vel[1] = f[7]; row.vel[2] = f[8];
	row.flags = flags;
	row.lastMs = steadyMs();
	row.lastSeq = seq;
}

void processEventLine( MirrorState *s, PeerRt &rt, const std::string &tag, const char *line )
{
	// C chat, J join, L leave; O vote-open, T vote-tally, R vote-result,
	// M map-changed — all ride the same event channel (dedup + re-send-once).
	char kind = line[0];
	if( kind == 0 || strchr( "CJLOTRM", kind ) == nullptr || line[1] != ' ' )
		return;
	char *end = nullptr;
	unsigned long eseq = strtoul( line + 2, &end, 10 );
	if( !end || *end != '\t' )
		return;
	const char *nameStart = end + 1;
	const char *tab2 = strchr( nameStart, '\t' );
	if( !tab2 )
		return;

	for( size_t i = 0; i < rt.seenEvents.size(); i++ )
		if( rt.seenEvents[i] == (uint32_t)eseq )
			return; // duplicate (the redundancy re-send)
	rt.seenEvents.push_back( (uint32_t)eseq );
	if( rt.seenEvents.size() > EVENT_DEDUP_WINDOW )
		rt.seenEvents.pop_front();

	InEvent ev;
	switch( kind ) {
		case 'C': ev.type = 1; break;
		case 'J': ev.type = 2; break;
		case 'L': ev.type = 3; break;
		case 'O': ev.type = 4; break; // vote open
		case 'T': ev.type = 5; break; // vote tally (a server's subtotal)
		case 'R': ev.type = 6; break; // vote result
		case 'M': ev.type = 7; break; // map changed
		default: return;
	}
	ev.tag = tag;
	ev.name = sanitizeField( std::string( nameStart, tab2 - nameStart ).c_str(), NAME_MAX );
	ev.text = sanitizeField( tab2 + 1, TEXT_MAX );
	if( ev.name.empty() )
		return;

	if( ev.type == 3 )
		s->rows.erase( tag + '\x1f' + ev.name ); // instant removal beats the 3s age-out

	if( s->inEvents.size() >= IN_EVENTQ_MAX )
		s->inEvents.pop_front();
	s->inEvents.push_back( ev );
}

void processDatagram( MirrorState *s, const char *buf, size_t n, const sockaddr_in &from )
{
	if( n < 8 || strncmp( buf, "RSM1 ", 5 ) != 0 ) {
		noteDrop( s );
		return;
	}
	const char *macStart = buf + 5;
	const char *macEnd = (const char *)memchr( macStart, ' ', n - 5 );
	if( !macEnd ) {
		noteDrop( s );
		return;
	}
	std::string mac( macStart, macEnd - macStart );
	const char *canonical = macEnd + 1;
	size_t canonLen = n - ( canonical - buf );

	if( !s->secret.empty() ) {
		if( mac.size() != 32 || !macEqual( mac, macHex( s->secret, canonical, canonLen ) ) ) {
			noteDrop( s );
			return;
		}
	} else {
		// No secret: source-IP allowlist against the resolved peers (LAN/test).
		bool known = false;
		for( size_t i = 0; i < s->peers.size(); i++ )
			if( s->peers[i].resolved && s->peers[i].addr.sin_addr.s_addr == from.sin_addr.s_addr )
				known = true;
		if( !known ) {
			noteDrop( s );
			return;
		}
	}

	// Header line: <ts> <seq> <type> <tag> <map>\n
	std::string canon( canonical, canonLen );
	size_t nl = canon.find( '\n' );
	if( nl == std::string::npos ) {
		noteDrop( s );
		return;
	}
	long long ts = 0;
	uint32_t seq = 0;
	char type = 0;
	char tagBuf[TAG_MAX + 1] = { 0 };
	char mapBuf[NAME_MAX + 1] = { 0 };
	if( sscanf( canon.c_str(), "%lld %u %c %16s %64s", &ts, &seq, &type, tagBuf, mapBuf ) != 5 ) {
		noteDrop( s );
		return;
	}
	std::string tag = sanitizeTag( tagBuf );
	if( tag.empty() || tag == s->tag || ( type != 'S' && type != 'E' ) ) {
		noteDrop( s ); // includes own-tag packets: a peer list containing self must not echo
		return;
	}
	long long skew = unixNow() - ts;
	if( skew < -TS_WINDOW_S || skew > TS_WINDOW_S ) {
		// counter under the lock, log after releasing it (see noteDrop)
		unsigned long long d;
		{
			std::lock_guard<std::mutex> lock( s->mutex );
			d = ++s->dropped;
		}
		if( d % 200 == 1 )
			fprintf( stderr, "rs_mirror: dropping packets from '%s': clock skew %llds (fix NTP)\n",
				tag.c_str(), skew );
		return;
	}
	std::string map = sanitizeToken( mapBuf, NAME_MAX );

	std::lock_guard<std::mutex> lock( s->mutex );

	std::map<std::string, PeerRt>::iterator rtIt = s->peersRt.find( tag );
	if( rtIt == s->peersRt.end() ) {
		if( s->peersRt.size() >= MAX_TAGS )
			return;
		rtIt = s->peersRt.insert( std::make_pair( tag, PeerRt() ) ).first;
	}
	s->rxAccepted++;

	PeerRt &rt = rtIt->second;
	if( rt.map != map ) {
		// Peer changed maps: its old positions are meaningless, clear them now.
		std::string prefix = tag + '\x1f';
		std::map<std::string, RemoteRow>::iterator r = s->rows.lower_bound( prefix );
		while( r != s->rows.end() && r->first.compare( 0, prefix.size(), prefix ) == 0 )
			s->rows.erase( r++ );
		rt.map = map;
	}
	rt.lastMs = steadyMs();

	// Body lines.
	size_t pos = nl + 1;
	while( pos < canon.size() ) {
		size_t lineEnd = canon.find( '\n', pos );
		if( lineEnd == std::string::npos )
			lineEnd = canon.size();
		std::string line = canon.substr( pos, lineEnd - pos );
		pos = lineEnd + 1;
		if( line.empty() )
			continue;
		if( type == 'S' )
			processStateLine( s, tag, seq, line.c_str() );
		else
			processEventLine( s, rt, tag, line.c_str() );
	}
}

// ---------------------------------------------------------------------------
// Worker main loop
// ---------------------------------------------------------------------------

void workerMain( MirrorState *s )
{
	s->lastStatsMs = steadyMs(); // first stats line ~30s after boot

	while( !s->stop.load() ) {
		// Apply any pending config. Copy under the lock, act outside it
		// (bind and getaddrinfo must not hold the mutex the game thread uses).
		bool dirty = false;
		std::string nTag, nSecret, nPeers, nMap;
		int nPort = 0;
		{
			std::lock_guard<std::mutex> lock( s->mutex );
			if( s->cfgDirty ) {
				dirty = true;
				nTag = s->cfgTag;
				nSecret = s->cfgSecret;
				nPeers = s->cfgPeers;
				nMap = s->cfgMap;
				nPort = s->cfgPort;
				s->cfgDirty = false;
			}
		}
		if( dirty ) {
			s->tag = nTag;
			s->secret = nSecret;
			s->map = nMap;
			bool rebind = nPort != s->port || s->fd < 0;
			bool reresolve = nPeers != s->peersRaw;
			s->port = nPort;
			s->peersRaw = nPeers;
			if( rebind )
				workerBind( s );
			if( reresolve || s->peers.empty() )
				resolvePeers( s, s->peersRaw );
		}

		if( s->fd < 0 ) {
			// Unconfigured or bind failed: idle until a config change or stop.
			std::unique_lock<std::mutex> lock( s->mutex );
			s->cv.wait_for( lock, std::chrono::milliseconds( 250 ) );
			continue;
		}

		// Containers get new IPs across restarts; refresh stale resolutions.
		if( steadyMs() - s->lastResolveMs > RESOLVE_INTERVAL_MS )
			resolvePeers( s, s->peersRaw );

		pollfd pfd;
		pfd.fd = s->fd;
		pfd.events = POLLIN;
		pfd.revents = 0;
		int pr = poll( &pfd, 1, POLL_MS );
		if( pr > 0 && ( pfd.revents & POLLIN ) ) {
			char buf[2048];
			for( int i = 0; i < RECV_BATCH; i++ ) {
				sockaddr_in from;
				socklen_t flen = sizeof( from );
				ssize_t n = recvfrom( s->fd, buf, sizeof( buf ), 0, (sockaddr *)&from, &flen );
				if( n <= 0 )
					break;
				if( (size_t)n > DGRAM_MAX_RECV ) {
					noteDrop( s );
					continue;
				}
				buf[n] = 0;
				processDatagram( s, buf, (size_t)n, from );
			}
		}

		workerSendPass( s );
		workerStats( s );
	}

	if( s->fd >= 0 ) {
		close( s->fd );
		s->fd = -1;
	}
}

// Only ever called from the game thread; plain-pointer init is race-free.
MirrorState *ensureStarted()
{
	if( !g_mirror ) {
		g_mirror = new MirrorState();
		g_mirror->worker = std::thread( workerMain, g_mirror );
	}
	return g_mirror;
}

// Stop and join the worker before the library is unloaded. The state is
// intentionally leaked (see MirrorState comment).
__attribute__(( destructor )) void rsMirrorShutdown()
{
	MirrorState *s = g_mirror;
	if( !s )
		return;
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		s->stop.store( true );
	}
	s->cv.notify_all();
	if( s->worker.joinable() )
		s->worker.join();
}

} // namespace

// ---------------------------------------------------------------------------
// Natives (called from g_ascript.cpp wrappers and the g_cmds.cpp chat hook,
// always on the game thread; every call is a short queue/snapshot exchange)
// ---------------------------------------------------------------------------

/*
 * RS_MirrorConfigure
 *
 * (Re)configure the mesh; called from the gametype on every map load, so it
 * is idempotent: the worker only rebinds on a port change and only
 * re-resolves on a peer-list change, but always picks up the current map.
 */
void RS_MirrorConfigure( const char *tag, const char *secret, int port, const char *peers, const char *map )
{
	std::string cleanTag = sanitizeTag( tag );
	if( cleanTag.empty() || port <= 0 || port > 65535 )
		return;

	MirrorState *s = ensureStarted();
	int npeers = 0;
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		s->cfgTag = cleanTag;
		s->cfgSecret = secret ? secret : "";
		s->cfgPeers = peers ? peers : "";
		s->cfgMap = sanitizeToken( map, NAME_MAX );
		s->cfgPort = port;
		s->cfgDirty = true;
		bool inTok = false;
		for( const char *p = s->cfgPeers.c_str(); *p; p++ ) {
			bool sep = *p == ' ' || *p == ',';
			if( !sep && !inTok )
				npeers++;
			inTok = !sep;
		}
	}
	s->cv.notify_all();
	fprintf( stderr, "rs_mirror: configured tag=%s port=%d peers=%d (secret: %s)\n",
		cleanTag.c_str(), port, npeers, secret && secret[0] ? "yes" : "NO - source-IP allowlist mode" );
}

// Begin/Player/End build one outgoing state tick; called at ~10Hz.
void RS_MirrorBegin( void )
{
	if( !g_mirror )
		return;
	g_mirror->buildRows.clear();
	g_mirror->buildCount = 0;
}

void RS_MirrorPlayer( const char *name, const float *origin, const float *angles, const float *velocity, int flags )
{
	MirrorState *s = g_mirror;
	if( !s || s->buildCount >= MAX_PLAYERS_PER_TAG )
		return;
	std::string cleanName = sanitizeField( name, NAME_MAX );
	if( cleanName.empty() )
		return;
	char line[NAME_MAX + 160];
	int n = snprintf( line, sizeof( line ), "P %d %.1f %.1f %.1f %.1f %.1f %.1f %.1f %.1f %.1f %s\n",
		flags, origin[0], origin[1], origin[2], angles[0], angles[1], angles[2],
		velocity[0], velocity[1], velocity[2], cleanName.c_str() );
	if( n <= 0 || (size_t)n >= sizeof( line ) )
		return;
	s->buildRows.append( line, n );
	s->buildCount++;
}

void RS_MirrorEnd( void )
{
	MirrorState *s = g_mirror;
	if( !s )
		return;
	std::lock_guard<std::mutex> lock( s->mutex );
	s->stateRows.swap( s->buildRows );
	s->statePending = true;
	s->buildRows.clear();
}

/*
 * RS_MirrorEvent — queue a locally-originated join ("J") / leave ("L") /
 * chat ("C") event for the mesh. Only ever fed local data (hop limit 1).
 */
void RS_MirrorEvent( const char *kind, const char *name, const char *text )
{
	MirrorState *s = g_mirror;
	if( !s || !kind || !kind[0] )
		return;
	char k = kind[0];
	if( strchr( "CJLOTRM", k ) == nullptr )
		return;
	OutEvent ev;
	ev.kind = k;
	ev.name = sanitizeField( name, NAME_MAX );
	ev.text = sanitizeField( text, TEXT_MAX );
	if( ev.name.empty() )
		return;
	{
		std::lock_guard<std::mutex> lock( s->mutex );
		if( s->outEvents.size() >= OUT_EVENTQ_MAX )
			s->outEvents.pop_front();
		s->outEvents.push_back( ev );
	}
}

/*
 * RS_MirrorLocalChat — called from the Cmd_Say_f hook in g_cmds.cpp for
 * every locally-originated public chat message. Mirrored chat is printed by
 * the gametype via G_PrintMsg and never re-enters Cmd_Say_f, so this cannot
 * loop. No-op until the gametype configures mirroring.
 */
void RS_MirrorLocalChat( const char *name, const char *text )
{
	if( !g_mirror || !text || !text[0] )
		return;
	RS_MirrorEvent( "C", name, text );
}

/*
 * RS_MirrorRefresh — swap in the latest received remote-player table and
 * age out stale players/peers. Returns the snapshot size; rows are then read
 * with RS_MirrorPlayer{Name,Server,Map,State}(i), valid until the next call.
 */
int RS_MirrorRefresh( void )
{
	MirrorState *s = g_mirror;
	if( !s )
		return 0;
	long long now = steadyMs();

	std::lock_guard<std::mutex> lock( s->mutex );

	std::map<std::string, PeerRt>::iterator rt = s->peersRt.begin();
	while( rt != s->peersRt.end() ) {
		if( now - rt->second.lastMs > PEER_TTL_MS )
			s->peersRt.erase( rt++ );
		else
			++rt;
	}

	// Peer-liveness snapshot for the RS_MirrorPeer* natives (game thread only,
	// same discipline as the player snapshot below). Includes EMPTY peers —
	// keepalive state carries the map — so the gametype can publish mesh status
	// that shows the mesh as connected even when no players are streaming.
	s->peerSnapshot.clear();
	for( std::map<std::string, PeerRt>::iterator pit = s->peersRt.begin(); pit != s->peersRt.end(); ++pit ) {
		PeerSnap ps;
		ps.tag = pit->first;
		ps.map = pit->second.map;
		ps.ageMs = (int)( now - pit->second.lastMs );
		s->peerSnapshot.push_back( ps );
	}

	s->snapshot.clear();
	std::map<std::string, RemoteRow>::iterator it = s->rows.begin();
	while( it != s->rows.end() ) {
		RemoteRow &row = it->second;
		std::map<std::string, PeerRt>::iterator prt = s->peersRt.find( row.tag );
		if( now - row.lastMs > PLAYER_TTL_MS || prt == s->peersRt.end() ) {
			s->rows.erase( it++ );
			continue;
		}
		SnapRow snap;
		snap.name = row.name;
		snap.tag = row.tag;
		snap.map = prt->second.map;
		char state[224];
		int n = snprintf( state, sizeof( state ), "%.1f %.1f %.1f %.1f %.1f %.1f %.1f %.1f %.1f %d %d",
			row.pos[0], row.pos[1], row.pos[2], row.ang[0], row.ang[1], row.ang[2],
			row.vel[0], row.vel[1], row.vel[2], row.flags, (int)( now - row.lastMs ) );
		// snprintf returns the UNTRUNCATED length; clamp before assign() so a
		// pathological row can never make assign() read past the stack buffer
		// (coords are finite-checked upstream, so this is belt-and-suspenders).
		if( n > 0 ) {
			if( (size_t)n >= sizeof( state ) )
				n = (int)sizeof( state ) - 1;
			snap.state.assign( state, n );
		}
		s->snapshot.push_back( snap );
		++it;
	}
	return (int)s->snapshot.size();
}

const char *RS_MirrorPlayerName( int i )
{
	MirrorState *s = g_mirror;
	if( !s || i < 0 || (size_t)i >= s->snapshot.size() )
		return "";
	return s->snapshot[i].name.c_str();
}

const char *RS_MirrorPlayerServer( int i )
{
	MirrorState *s = g_mirror;
	if( !s || i < 0 || (size_t)i >= s->snapshot.size() )
		return "";
	return s->snapshot[i].tag.c_str();
}

const char *RS_MirrorPlayerMap( int i )
{
	MirrorState *s = g_mirror;
	if( !s || i < 0 || (size_t)i >= s->snapshot.size() )
		return "";
	return s->snapshot[i].map.c_str();
}

const char *RS_MirrorPlayerState( int i )
{
	MirrorState *s = g_mirror;
	if( !s || i < 0 || (size_t)i >= s->snapshot.size() )
		return "";
	return s->snapshot[i].state.c_str();
}

/*
 * RS_MirrorPeer{Count,Tag,Map,Age} — the heard-peer snapshot rebuilt by
 * RS_MirrorRefresh (game thread only, like the player snapshot). Lets the
 * gametype publish mesh status — which peers this server currently hears and
 * their maps — even when those peers have no players streaming. Age is ms
 * since the peer was last heard (its keepalive interval, ~100ms when healthy).
 */
int RS_MirrorPeerCount( void )
{
	MirrorState *s = g_mirror;
	return s ? (int)s->peerSnapshot.size() : 0;
}

const char *RS_MirrorPeerTag( int i )
{
	MirrorState *s = g_mirror;
	if( !s || i < 0 || (size_t)i >= s->peerSnapshot.size() )
		return "";
	return s->peerSnapshot[i].tag.c_str();
}

const char *RS_MirrorPeerMap( int i )
{
	MirrorState *s = g_mirror;
	if( !s || i < 0 || (size_t)i >= s->peerSnapshot.size() )
		return "";
	return s->peerSnapshot[i].map.c_str();
}

int RS_MirrorPeerAge( int i )
{
	MirrorState *s = g_mirror;
	if( !s || i < 0 || (size_t)i >= s->peerSnapshot.size() )
		return -1;
	return s->peerSnapshot[i].ageMs;
}

/*
 * RS_MirrorNextEvent — pop the next received chat/join/leave event into the
 * "current event" slot. Returns 0 when drained, else 1 chat / 2 join /
 * 3 leave; fields are then read with RS_MirrorEvent{Server,Name,Text}().
 */
int RS_MirrorNextEvent( void )
{
	MirrorState *s = g_mirror;
	if( !s )
		return 0;
	std::lock_guard<std::mutex> lock( s->mutex );
	if( s->inEvents.empty() )
		return 0;
	s->cur = s->inEvents.front();
	s->inEvents.pop_front();
	return s->cur.type;
}

const char *RS_MirrorEventServer( void )
{
	return g_mirror ? g_mirror->cur.tag.c_str() : "";
}

const char *RS_MirrorEventName( void )
{
	return g_mirror ? g_mirror->cur.name.c_str() : "";
}

const char *RS_MirrorEventText( void )
{
	return g_mirror ? g_mirror->cur.text.c_str() : "";
}
