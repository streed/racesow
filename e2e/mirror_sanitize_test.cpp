/*
 * Unit tests for the mesh receive path's two input gates
 * (server/enginepatches/g_rs_mirror.cpp):
 *
 *   - processStateLine's coordinate guard. A mirrored position is driven
 *     straight onto an entity and through GClip_LinkEntity and the snapshot
 *     coord quantisation, so "finite" is not a strong enough test — see
 *     COORD_ABS_MAX.
 *   - sanitizeName vs sanitizeField. A mirrored NAME becomes an info-string
 *     value (Info_SetValueForKey in g_rs_mirrorbots.cpp) and so cannot carry
 *     the info string's own delimiters; mirrored CHAT is only ever printed and
 *     must keep the punctuation players actually type.
 *
 * e2e/mirror_fuzz_run.sh already proves the parser does not crash on hostile
 * input. That is a different question from whether it accepts the right input,
 * which is what these pin.
 *
 * Both functions live in the module's anonymous namespace, so this TU #includes
 * it rather than linking. MirrorState's constructor binds no socket and starts
 * no thread, so a stack instance is enough.
 *
 *   g++ -std=c++11 -o /tmp/ms e2e/mirror_sanitize_test.cpp -pthread && /tmp/ms
 */
#include "../server/enginepatches/g_rs_mirror.cpp"

#include <cstdio>
#include <string>

static int failures = 0;

static void check( bool ok, const char *what )
{
	printf( "%s %s\n", ok ? "ok  " : "FAIL", what );
	if( !ok )
		failures++;
}

// Feed one "PS ..." body line and report whether it produced a row.
static bool accepts( const char *line )
{
	MirrorState s;
	processStateLine( &s, "PEER", 1, line );
	return !s.rows.empty();
}

static std::string stateLine( const char *coords, const char *name )
{
	return std::string( "PS 0 0 " ) + coords + " " + name;
}

int main()
{
	// --- coordinate guard ----------------------------------------------------
	check( accepts( stateLine( "10.0 20.0 30.0 0.0 90.0 0.0 100.0 0.0 0.0", "racer" ).c_str() ),
		"an ordinary position is accepted" );
	check( accepts( stateLine( "-131072 131072 4000 0 359 0 -2500 2500 900", "racer" ).c_str() ),
		"the far corners of a legal Quake world are accepted" );

	check( !accepts( stateLine( "1e30 0 0 0 0 0 0 0 0", "racer" ).c_str() ),
		"1e30 is rejected (finite, but float->int of it is UB)" );
	check( !accepts( stateLine( "0 0 0 0 0 0 -1e30 0 0", "racer" ).c_str() ),
		"a wild VELOCITY is rejected too, not just a position" );
	check( !accepts( stateLine( "nan 0 0 0 0 0 0 0 0", "racer" ).c_str() ), "NaN is rejected" );
	check( !accepts( stateLine( "inf 0 0 0 0 0 0 0 0", "racer" ).c_str() ), "inf is rejected" );
	check( !accepts( stateLine( "-inf 0 0 0 0 0 0 0 0", "racer" ).c_str() ), "-inf is rejected" );

	// Just inside and just outside the cap, so the boundary is pinned and not
	// merely "some big number fails".
	check( accepts( stateLine( "999999 0 0 0 0 0 0 0 0", "racer" ).c_str() ),
		"just inside COORD_ABS_MAX is accepted" );
	check( !accepts( stateLine( "1000001 0 0 0 0 0 0 0 0", "racer" ).c_str() ),
		"just outside COORD_ABS_MAX is rejected" );

	// --- sanitizeName: info-string safety ------------------------------------
	{
		std::string n = sanitizeName( "ev\\il\"guy;drop", NAME_MAX );
		check( n.find( '\\' ) == std::string::npos, "a name loses backslashes" );
		check( n.find( '"' ) == std::string::npos, "a name loses double quotes" );
		check( n.find( ';' ) == std::string::npos, "a name loses semicolons" );
		check( n == "ev il guy drop", "and keeps everything else, one char per char" );
	}
	check( sanitizeName( "^1red^7name", NAME_MAX ) == "^1red^7name",
		"a name keeps its Warsow colour codes" );
	check( sanitizeName( "\xc3\xa9l\xc3\xa8ve", NAME_MAX ) == "\xc3\xa9l\xc3\xa8ve",
		"a name keeps UTF-8 bytes" );
	check( sanitizeName( "a\x7f" "b", NAME_MAX ) == "ab", "a name drops DEL" );
	check( sanitizeName( "a\tb\nc", NAME_MAX ) == "a b c",
		"a name's wire delimiters become spaces" );

	// --- sanitizeField: chat keeps what players type -------------------------
	check( sanitizeField( "he said \"gg\"; nice \\o/", TEXT_MAX ) == "he said \"gg\"; nice \\o/",
		"chat keeps quotes, semicolons and backslashes" );
	check( sanitizeField( "a\tb\r\nc", TEXT_MAX ) == "a b  c",
		"chat's wire delimiters become spaces" );
	check( sanitizeField( "a\x7f" "b", TEXT_MAX ) == "ab", "chat drops DEL" );
	check( sanitizeField( "^2gg^7 \xe2\x9c\x93", TEXT_MAX ) == "^2gg^7 \xe2\x9c\x93",
		"chat keeps colour codes and UTF-8" );

	// --- both truncate to their cap -----------------------------------------
	check( sanitizeName( std::string( 200, 'x' ).c_str(), NAME_MAX ).size() == NAME_MAX,
		"a name is capped at NAME_MAX" );
	check( sanitizeField( std::string( 900, 'x' ).c_str(), TEXT_MAX ).size() == TEXT_MAX,
		"chat is capped at TEXT_MAX" );

	if( failures ) {
		printf( "\n%d check(s) FAILED\n", failures );
		return 1;
	}
	printf( "\nmesh input gates: all checks passed\n" );
	return 0;
}
