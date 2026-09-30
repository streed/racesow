// The meta map: a course that builds itself in front of the player.
//
// Only ever active on the map named META_MAP_NAME. Everywhere else every
// function here returns immediately, so the rest of hrace is untouched.
//
// How it works
// ------------
// The engine cannot make geometry after a map loads. What tools/mapgen/tiles.py
// compiles instead is a DECK: a sealed, empty arena plus ~80 inline brush
// models, one per course piece, that nothing references. A submodel nobody
// references is invisible and non-solid, so the map a player loads is bare.
// This file is the dealer. It spawns an entity per piece, points it at an
// inline model with setupModel("*N") and puts it where the route needs it:
//
//   * GClip_SetBrushModel resolves the model and takes its bounds, and
//     GClip_LinkEntity stamps s.solid = SOLID_BMODEL (game/g_clip.cpp:552-557,
//     :981-1017), so the tile is solid to the server.
//   * The client PREDICTS it: CG_ClipMoveToEntities traces against the inline
//     model at the entity's origin AND angles (cgame/cg_predict.cpp:261-280).
//     Strafing on a dealt tile feels exactly like strafing on the world.
//   * Brush models are not PVS-culled when drawn (pvsCull = false,
//     ref_gl/r_surf.c:443), so a tile renders wherever it is put.
//   * tiles.py gives every tile an "origin" key, so the compiler bakes its
//     brushes RELATIVE to the tile's own entry point. That is what makes
//     ent.angles turn a tile about its entry instead of about the far-away
//     point it happened to be compiled at.
//
// One route, one seed, everyone on it
// -----------------------------------
// The server deals ONE route and every player races that same route, so a seed
// names a course other people can go and run — which is the only thing that
// makes a board of times on random maps worth keeping. The route is dealt
// progressively, a few tiles ahead of whoever is furthest along, so it really
// does build itself in front of the player; it is never recycled, so it is
// still there to run again, and for anyone who joins or respawns mid-route.
//
// The clock, and why this map has no leaderboard
// ----------------------------------------------
// The deck carries no target_starttimer or target_stoptimer — a map-placed
// timer would fire for whichever lane happened to be built over it. The dealer
// owns the clock: it puts a start gate at the end of the start tile and a
// finish gate at the front of the finish tile, both trigger entities wearing
// the deck's one gate model. A run here is never comparable to a run on a
// fixed map, so completeRace() skips the record path entirely (player.as) and
// reports to the seed board instead: player, time, and the seed that produced
// the route, so anyone can run the same one.

const String META_MAP_NAME = "random_map";
const String META_DECK_EXT = ".deck";

// Tile flags. Mirrors tiles.py's F_* — keep the two in step.
const int META_F_OPEN = 1;        // no side walls: leaving it sideways is possible
const int META_F_DASH = 2;        // needs the dash
const int META_F_WALLJUMP = 4;    // needs a wall jump
const int META_F_START = 8;
const int META_F_FINISH = 16;

// Every tile turns by a whole number of 45-degree steps (spec.TURN_ANGLES), so
// a heading is an index into an exact table rather than an accumulated float.
// Tiles mate face to face; a fraction of a degree of drift per tile would show
// as a seam a player can catch.
const int META_STEPS = 8;
const float META_STEP_DEG = 45.0f;

// How much route is dealt ahead of the player, and how much is kept behind
// them before it is recycled. META_AHEAD is what "the map builds itself in
// front of you" means in practice; it is small enough that the snapshot stays
// far under the ~64-entity budget the server's client_entities ring implies
// (server/server.h:210, sv_init.c:360) and large enough that the next piece is
// always already there to be read.
const int META_AHEAD = 6;
// ...and the ceiling on a whole route, whatever rs_meta_distance says. Nothing
// is recycled, so this is also the entity budget: the route plus two gates has
// to stay well under the ~64 entities a client snapshot can carry before the
// server's client_entities ring starts overwriting frames still inside the
// delta window (server/server.h:210, sv_init.c:360).
const int META_MAX_TILES = 44;
// How many placements the dealer may undo when it runs out of room.
// It can only ever undo tiles nobody has reached, so the real ceiling is
// META_AHEAD; past that this stops mattering.
const int META_REWIND_BUDGET = 16;

// A dealt tile may pass over an earlier one, but only with room to run under
// it: the lower tile's walls plus a player's height.
const float META_OVERPASS_CLEAR = 96.0f;
// Slack on the fence, so a tile never touches the sky shell.
const float META_FENCE_MARGIN = 384.0f;
// Room a tile's exit must leave inside the fence for the tile after it.
const float META_EXIT_ROOM = 640.0f;

class MetaTile
{
    int model;
    int flags;
    int weight;
    float fwd, lat, rise;   // exit, in the tile's own entry frame
    int turn;               // exit heading, in 45-degree steps
    Vec3 mins, maxs;        // local bounds, for the overlap test
    float route;            // centre-line length
    String kind;
    String name;
}

MetaTile@[] metaDeck;
int metaStartTile = -1;
int[] metaFinishTiles;
int metaGateModel = 0;
float metaGateDepth = 32.0f;
float metaGateHalf = 208.0f;
float metaGateHeight = 192.0f;

float metaPlayHalf = 0.0f;      // the play box, from its centre
float metaPlayUp = 0.0f;
float metaPlayDown = 0.0f;

bool metaIsMetaMap = false;
bool metaReady = false;
String metaLoadError = "";

// How much route a run is before the finish tile is dealt, and the ceiling on
// how long one may take. Both are cvars so a server can run short sprints or
// long marathons without a new deck.
Cvar rsMetaDistance( "rs_meta_distance", "16000", 0 );
Cvar rsMetaMaxSeconds( "rs_meta_max_seconds", "600", 0 );
// Where a finished run is reported (the seed board). Empty = report nothing.
Cvar rsMetaReportUrl( "rs_api_random_url", "", 0 );

float META_COS( int step )
{
    switch ( step & 7 )
    {
    case 0: return 1.0f;
    case 1: return 0.70710678f;
    case 2: return 0.0f;
    case 3: return -0.70710678f;
    case 4: return -1.0f;
    case 5: return -0.70710678f;
    case 6: return 0.0f;
    }
    return 0.70710678f;
}

float META_SIN( int step )
{
    return META_COS( ( step + 6 ) & 7 );
}

bool RACE_IsMetaMap()
{
    return metaIsMetaMap;
}

// Is this map NAME the meta map? Answered without loading anything, because the
// map-pool walks ask it about every installed map on a server that is not
// running it. Expects an already colour-stripped, lowercased key, like
// RACE_IsMapBlockedClean.
bool RACE_IsMetaMapName( const String &in key )
{
    return key == META_MAP_NAME;
}

// --- the deck manifest ------------------------------------------------------
// maps/<map>.deck, packed beside the .bsp and read through the engine FS
// (G_LoadFile -> trap_FS_FOpenFile), so a file inside the .pk3 is readable.
// Whitespace-separated tokens with // comments, which is exactly what
// String::getToken (COM_Parse) understands.
//
// getToken( i ) re-parses from the start of the string, so it is used on ONE
// LINE at a time rather than on the whole file: over a thousand tokens that is
// the difference between a linear read and a quadratic one.

int RACE_MetaParseYaw( float deg, const String &in where )
{
    float steps = deg / META_STEP_DEG;
    int whole = int( steps + ( steps < 0 ? -0.5f : 0.5f ) );
    if ( abs( double( steps - float( whole ) ) ) > 0.01 )
    {
        metaLoadError = where + ": turn of " + deg + " degrees is not a multiple of "
                + int( META_STEP_DEG ) + " (tiles must mate face to face)";
        return 0;
    }
    return ( ( whole % META_STEPS ) + META_STEPS ) % META_STEPS;
}

void RACE_MetaLoadDeck()
{
    metaDeck.resize( 0 );
    metaFinishTiles.resize( 0 );
    metaStartTile = -1;
    metaReady = false;
    metaLoadError = "";

    String path = "maps/" + META_MAP_NAME + META_DECK_EXT;
    String text = G_LoadFile( path );
    if ( text.length() == 0 )
    {
        metaLoadError = "no deck manifest at " + path;
        return;
    }

    // String::locate's second argument is how many matches to SKIP, not where
    // to start, so walking the file means counting newlines rather than
    // carrying a byte offset. Lines are sliced out first and getToken is only
    // ever used within one: getToken re-parses from the start of whatever it is
    // given, so handing it the whole file would make this quadratic in tokens.
    // COM_Parse (which is what getToken is) drops // to end of line by itself,
    // so a comment line simply yields no first token.
    uint at = 0;
    uint newlines = 0;
    while ( at < text.length() )
    {
        uint nl = text.locate( "\n", newlines );
        String line = ( nl >= text.length() ) ? text.substr( at )
                                              : text.substr( at, nl - at );
        at = nl + 1;
        newlines++;

        String head = line.getToken( 0 );
        if ( head == "" )
            continue;

        if ( head == "deck" )
        {
            if ( line.getToken( 1 ).toInt() != 1 )
            {
                metaLoadError = "deck manifest version " + line.getToken( 1 )
                        + " (this build reads version 1)";
                return;
            }
        }
        else if ( head == "play" )
        {
            metaPlayHalf = line.getToken( 1 ).toFloat();
            metaPlayUp = line.getToken( 2 ).toFloat();
            metaPlayDown = line.getToken( 3 ).toFloat();
        }
        else if ( head == "gate" )
        {
            metaGateModel = line.getToken( 1 ).toInt();
            metaGateDepth = line.getToken( 2 ).toFloat();
            metaGateHalf = line.getToken( 3 ).toFloat();
            metaGateHeight = line.getToken( 4 ).toFloat();
        }
        else if ( head == "tile" )
        {
            MetaTile tile;
            tile.model = line.getToken( 1 ).toInt();
            tile.flags = line.getToken( 2 ).toInt();
            tile.weight = line.getToken( 3 ).toInt();
            tile.fwd = line.getToken( 4 ).toFloat();
            tile.lat = line.getToken( 5 ).toFloat();
            tile.rise = line.getToken( 6 ).toFloat();
            tile.mins = Vec3( line.getToken( 8 ).toFloat(), line.getToken( 9 ).toFloat(),
                              line.getToken( 10 ).toFloat() );
            tile.maxs = Vec3( line.getToken( 11 ).toFloat(), line.getToken( 12 ).toFloat(),
                              line.getToken( 13 ).toFloat() );
            tile.route = line.getToken( 14 ).toFloat();
            tile.kind = line.getToken( 15 );
            tile.name = line.getToken( 16 );
            tile.turn = RACE_MetaParseYaw( line.getToken( 7 ).toFloat(), "tile " + tile.name );
            if ( metaLoadError != "" )
                return;
            if ( ( tile.flags & META_F_START ) != 0 )
                metaStartTile = metaDeck.length();
            if ( ( tile.flags & META_F_FINISH ) != 0 )
                metaFinishTiles.insertLast( metaDeck.length() );
            metaDeck.insertLast( @tile );
        }
    }

    if ( metaDeck.length() == 0 )
        metaLoadError = "the deck manifest holds no tiles";
    else if ( metaStartTile < 0 || metaFinishTiles.length() == 0 )
        metaLoadError = "the deck has no start tile or no finish tile";
    else if ( metaGateModel <= 0 )
        metaLoadError = "the deck has no gate model";
    else if ( metaPlayHalf <= 0.0f )
        metaLoadError = "the deck declares no play box";

    // Roomiest finish first. The dealer walks the list, so a route that has
    // painted itself into a corner can still end on the small one.
    for ( uint i = 1; i < metaFinishTiles.length(); i++ )
    {
        for ( uint j = i; j > 0; j-- )
        {
            if ( metaDeck[metaFinishTiles[j]].route <= metaDeck[metaFinishTiles[j - 1]].route )
                break;
            int swap = metaFinishTiles[j];
            metaFinishTiles[j] = metaFinishTiles[j - 1];
            metaFinishTiles[j - 1] = swap;
        }
    }

    metaReady = ( metaLoadError == "" );
}


// --- the route --------------------------------------------------------------

uint metaSeed = 0;              // the seed the route on the ground came from
uint metaRng = 0;               // the generator's running state
Vec3 metaCursor;                // where the NEXT tile's entry goes
int metaHeading = 0;            // ...and which way it faces, in 45-degree steps
float metaDealtRoute = 0.0f;    // centre-line units dealt so far
bool metaFinishDealt = false;
int metaProgress = 0;           // furthest tile any racer has reached

Entity@[] metaPlaced;           // the route, in the order it was dealt
Vec3[] metaBoxLo;               // each tile's world bounds, for the overlap test
Vec3[] metaBoxHi;
// The cursor as it stood BEFORE each placement, so a placement can be undone.
Vec3[] metaPreCursor;
int[] metaPreHeading;
float[] metaPreRoute;
bool metaBareFinish = false;    // the route ended on a gate with no run-out
// Players owing a trip to the start pad, applied from the think loop.
bool[] metaStartPending( maxClients );
Entity@ metaStartGate;
Entity@ metaFinishGate;

uint RACE_MetaNextRandom()
{
    // xorshift32. The same seed has to produce the same course on every server
    // and every build, which is the whole point of putting one on a board.
    uint x = metaRng;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    metaRng = x;
    return x;
}

uint RACE_MetaSeed()
{
    return metaSeed;
}

// Where the tile's local (fwd, lat) lands once the tile is turned to `step`.
Vec3 RACE_MetaRotate( float fwd, float lat, int step )
{
    float c = META_COS( step );
    float s = META_SIN( step );
    return Vec3( fwd * c - lat * s, fwd * s + lat * c, 0.0f );
}

// The world box a tile would occupy if it were placed at `at` facing `step`.
void RACE_MetaTileBox( MetaTile @tile, const Vec3 &in at, int step, Vec3 &out lo, Vec3 &out hi )
{
    float c = META_COS( step );
    float s = META_SIN( step );
    float lox = 0.0f, hix = 0.0f, loy = 0.0f, hiy = 0.0f;
    for ( int i = 0; i < 4; i++ )
    {
        float px = ( i == 0 || i == 3 ) ? tile.mins.x : tile.maxs.x;
        float py = ( i < 2 ) ? tile.mins.y : tile.maxs.y;
        float rx = px * c - py * s;
        float ry = px * s + py * c;
        if ( i == 0 || rx < lox ) lox = rx;
        if ( i == 0 || rx > hix ) hix = rx;
        if ( i == 0 || ry < loy ) loy = ry;
        if ( i == 0 || ry > hiy ) hiy = ry;
    }
    lo = Vec3( at.x + lox, at.y + loy, at.z + tile.mins.z );
    hi = Vec3( at.x + hix, at.y + hiy, at.z + tile.maxs.z );
}

// Does this box clash with route already on the ground?
//
// The tile being mated to is skipped and nothing else: its box touches the new
// one by construction, and a turn's box legitimately contains the piece that
// leaves it. Skipping two — which is what this did first — leaves a blind spot
// exactly one tile wide, and a simulation of 600 dealt routes found a clash in
// 60% of them. Boxes are coarse, so this now errs towards rejecting a placement
// that would have been fine: the right way round, because the deck always has
// another tile to offer and an overlap is a route nobody can run.
bool RACE_MetaBoxClear( const Vec3 &in lo, const Vec3 &in hi )
{
    int last = int( metaPlaced.length() ) - 1;
    for ( int i = 0; i < last; i++ )
    {
        Vec3 a = metaBoxLo[i];
        Vec3 b = metaBoxHi[i];
        if ( hi.x <= a.x || lo.x >= b.x || hi.y <= a.y || lo.y >= b.y )
            continue;                       // clear in plan
        if ( lo.z >= b.z + META_OVERPASS_CLEAR || hi.z + META_OVERPASS_CLEAR <= a.z )
            continue;                       // one passes cleanly over the other
        return false;
    }
    return true;
}

bool RACE_MetaInsideBox( const Vec3 &in lo, const Vec3 &in hi )
{
    float half = metaPlayHalf - META_FENCE_MARGIN;
    if ( lo.x < -half || hi.x > half ) return false;
    if ( lo.y < -half || hi.y > half ) return false;
    if ( lo.z < -metaPlayDown || hi.z > metaPlayUp ) return false;
    return true;
}

// How far out of the middle a point is, as a fraction of the room there is:
// 0 at the centre, 1 at the wall.
float RACE_MetaOutward( const Vec3 &in p )
{
    float half = metaPlayHalf - META_FENCE_MARGIN;
    float dx = float( abs( double( p.x ) ) );
    float dy = float( abs( double( p.y ) ) );
    float d = dx > dy ? dx : dy;
    return half > 0.0f ? d / half : 1.0f;
}

// Pick the next tile.
//
// Every tile that would fit is scored, and one is drawn at random in proportion
// to its score, so the route stays surprising rather than settling into the one
// "best" continuation. All the steering is in the score: out near the wall a
// tile that turns back inwards outscores one that runs on, and near the top or
// the bottom of the box a climb or a dive is damped the same way. Nothing here
// forbids a shape — it only makes the route bend before it has to.
int RACE_MetaPick()
{
    float away = RACE_MetaOutward( metaCursor );

    int[] pick;
    float[] score;
    float total = 0.0f;

    for ( uint i = 0; i < metaDeck.length(); i++ )
    {
        MetaTile @tile = metaDeck[i];
        if ( tile.weight <= 0 )
            continue;                       // the start and finish are placed by hand

        Vec3 lo, hi;
        RACE_MetaTileBox( tile, metaCursor, metaHeading, lo, hi );
        if ( !RACE_MetaInsideBox( lo, hi ) || !RACE_MetaBoxClear( lo, hi ) )
            continue;

        Vec3 step = RACE_MetaRotate( tile.fwd, tile.lat, metaHeading );
        Vec3 exit = Vec3( metaCursor.x + step.x, metaCursor.y + step.y,
                          metaCursor.z + tile.rise );
        // Leave room for whatever comes next: an exit hard against the wall is
        // a corner the dealer would have to paint itself out of.
        if ( !RACE_MetaInsideBox(
                Vec3( exit.x - META_EXIT_ROOM, exit.y - META_EXIT_ROOM, exit.z ),
                Vec3( exit.x + META_EXIT_ROOM, exit.y + META_EXIT_ROOM, exit.z ) ) )
            continue;

        float s = float( tile.weight );

        // Pull back towards the middle, in proportion to how far out we are.
        if ( away > 0.45f )
        {
            float pull = ( away - 0.45f ) / 0.55f;
            float inward = 0.15f + ( away - RACE_MetaOutward( exit ) ) * 6.0f;
            if ( inward < 0.05f ) inward = 0.05f;
            if ( inward > 3.0f ) inward = 3.0f;
            s = s * ( ( 1.0f - pull ) + pull * inward );
        }

        // The same idea vertically. A route that only ever falls runs out of
        // box long before it runs out of tiles.
        if ( tile.rise > 0.0f && metaCursor.z > metaPlayUp * 0.5f )
            s = s * 0.25f;
        else if ( tile.rise < 0.0f && metaCursor.z < -metaPlayDown * 0.5f )
            s = s * 0.25f;
        else if ( tile.rise > 0.0f && metaCursor.z < -metaPlayDown * 0.4f )
            s = s * 2.0f;
        else if ( tile.rise < 0.0f && metaCursor.z > metaPlayUp * 0.4f )
            s = s * 2.0f;

        if ( s <= 0.0f )
            continue;
        pick.insertLast( int( i ) );
        score.insertLast( s );
        total += s;
    }

    if ( pick.length() == 0 )
        return -1;

    float roll = float( RACE_MetaNextRandom() % 100000 ) / 100000.0f * total;
    for ( uint i = 0; i < pick.length(); i++ )
    {
        roll -= score[i];
        if ( roll <= 0.0f )
            return pick[i];
    }
    return pick[pick.length() - 1];
}


// --- putting a tile on the ground -------------------------------------------

Entity@ RACE_MetaSpawnPiece( int model, const Vec3 &in at, int step )
{
    Entity @ent = G_SpawnEntity( "mg_piece" );
    ent.setupModel( "*" + model );
    if ( !ent.isBrushModel() )
    {
        // ISBRUSHMODEL only accepts 0 < index < CM_NumInlineModels
        // (game/g_local.h:680). A manifest that does not match the .bsp it was
        // packed with fails here, rather than linking an entity with no hull —
        // which the engine would do without complaint.
        ent.freeEntity();
        return null;
    }
    ent.origin = at;
    ent.angles = Vec3( 0.0f, float( step ) * META_STEP_DEG, 0.0f );
    ent.moveType = MOVETYPE_NONE;
    ent.solid = SOLID_YES;
    ent.linkEntity();
    return ent;
}

void meta_gate_touch( Entity @ent, Entity @other, const Vec3 planeNormal, int surfFlags )
{
    if ( @other == null || @other.client == null )
        return;

    Player @player = RACE_GetPlayer( other.client );
    if ( @player == null )
        return;

    if ( ent.style == 0 )
    {
        if ( player.inRace )
            return;
        if ( player.startRace() )
        {
            int speed = int( HorizontalSpeed( other.velocity ) );
            other.client.setHUDStat( STAT_PROGRESS_OTHER, speed );
            other.client.printMessage( S_COLOR_ORANGE + "Starting speed: "
                    + S_COLOR_WHITE + speed + "\n" );
        }
        return;
    }

    if ( !player.inRace && !player.practicing )
        return;
    player.completeRace();
}

Entity@ RACE_MetaSpawnGate( const Vec3 &in at, int step, int kind )
{
    Entity @ent = G_SpawnEntity( "mg_gate" );
    ent.setupModel( "*" + metaGateModel );
    if ( !ent.isBrushModel() )
    {
        ent.freeEntity();
        return null;
    }
    ent.origin = at;
    ent.angles = Vec3( 0.0f, float( step ) * META_STEP_DEG, 0.0f );
    ent.moveType = MOVETYPE_NONE;
    // A SOLID_TRIGGER brush entity is not networked as solid at all
    // (g_clip.cpp:552-557), so a gate costs nothing on the wire and lives
    // entirely on the server, where its touch is dispatched.
    ent.solid = SOLID_TRIGGER;
    ent.style = kind;                       // 0 start, 1 finish
    @ent.touch = meta_gate_touch;
    ent.linkEntity();
    return ent;
}

// The classnames the compiled deck carries. The dealer wants none of them —
// the tiles are a dormant library and the gate is only a shape — but they have
// to EXIST as script spawn functions: an entity whose classname has neither a C
// nor a script spawn function is freed with a console warning on every load
// (g_spawn.cpp:289-295), and a deck would print 78 of them.
void mg_tile( Entity @ent ) { ent.freeEntity(); }
void mg_piece( Entity @ent ) { }
void mg_gate( Entity @ent ) { }


// --- dealing ----------------------------------------------------------------

void RACE_MetaClearRoute()
{
    for ( uint i = 0; i < metaPlaced.length(); i++ )
    {
        if ( @metaPlaced[i] != null )
            metaPlaced[i].freeEntity();
    }
    metaPlaced.resize( 0 );
    metaBoxLo.resize( 0 );
    metaBoxHi.resize( 0 );
    metaPreCursor.resize( 0 );
    metaPreHeading.resize( 0 );
    metaPreRoute.resize( 0 );
    metaBareFinish = false;
    if ( @metaStartGate != null )
    {
        metaStartGate.freeEntity();
        @metaStartGate = null;
    }
    if ( @metaFinishGate != null )
    {
        metaFinishGate.freeEntity();
        @metaFinishGate = null;
    }
    metaProgress = 0;
    metaDealtRoute = 0.0f;
    metaFinishDealt = false;
}

bool RACE_MetaDealTile( int index )
{
    MetaTile @tile = metaDeck[index];
    Entity @ent = RACE_MetaSpawnPiece( tile.model, metaCursor, metaHeading );
    if ( @ent == null )
        return false;

    Vec3 lo, hi;
    RACE_MetaTileBox( tile, metaCursor, metaHeading, lo, hi );
    metaPlaced.insertLast( @ent );
    metaBoxLo.insertLast( lo );
    metaBoxHi.insertLast( hi );
    metaPreCursor.insertLast( metaCursor );
    metaPreHeading.insertLast( metaHeading );
    metaPreRoute.insertLast( metaDealtRoute );

    Vec3 step = RACE_MetaRotate( tile.fwd, tile.lat, metaHeading );
    metaCursor = Vec3( metaCursor.x + step.x, metaCursor.y + step.y,
                       metaCursor.z + tile.rise );
    metaHeading = ( metaHeading + tile.turn ) % META_STEPS;
    metaDealtRoute += tile.route;
    return true;
}

// Undo the last placement — but only ever one no player has reached, so the
// floor is never taken out from under anyone.
bool RACE_MetaRewind()
{
    int n = int( metaPlaced.length() );
    if ( n - 1 <= metaProgress + 1 )
        return false;
    if ( @metaPlaced[n - 1] != null )
        metaPlaced[n - 1].freeEntity();
    metaPlaced.removeLast();
    metaBoxLo.removeLast();
    metaBoxHi.removeLast();
    metaCursor = metaPreCursor[n - 1];
    metaHeading = metaPreHeading[n - 1];
    metaDealtRoute = metaPreRoute[n - 1];
    metaPreCursor.removeLast();
    metaPreHeading.removeLast();
    metaPreRoute.removeLast();
    return true;
}

// End the route here, if there is room to. The finish gate goes at the front of
// whichever run-out fits, so the clock stops as the player arrives and the tile
// catches them.
bool RACE_MetaTryFinish()
{
    for ( uint i = 0; i < metaFinishTiles.length(); i++ )
    {
        MetaTile @tile = metaDeck[metaFinishTiles[i]];
        Vec3 lo, hi;
        RACE_MetaTileBox( tile, metaCursor, metaHeading, lo, hi );
        if ( !RACE_MetaInsideBox( lo, hi ) || !RACE_MetaBoxClear( lo, hi ) )
            continue;
        @metaFinishGate = RACE_MetaSpawnGate( metaCursor, metaHeading, 1 );
        if ( !RACE_MetaDealTile( metaFinishTiles[i] ) )
            return false;
        metaFinishDealt = true;
        return true;
    }
    return false;
}

// Keep META_AHEAD tiles in front of whoever is furthest along. This is the
// whole "it builds itself as you go" effect: a piece appears a few tiles
// before anyone reaches it, and stays for everyone behind them.
//
// When nothing in the deck fits the cursor the dealer backs up and tries a
// different line rather than giving up — a route folded into a box paints
// itself into a corner often enough to matter. Over 600 simulated routes that
// took dead ends from 31% to 7%, and those last few end on a gate with no
// run-out rather than by driving a finish corridor through an earlier one.
void RACE_MetaExtend()
{
    int budget = META_REWIND_BUDGET;

    while ( !metaFinishDealt
            && int( metaPlaced.length() ) - 1 - metaProgress < META_AHEAD )
    {
        bool ending = ( metaDealtRoute >= rsMetaDistance.value
                || int( metaPlaced.length() ) >= META_MAX_TILES - 1 );

        if ( !ending )
        {
            int index = RACE_MetaPick();
            if ( index >= 0 )
            {
                if ( !RACE_MetaDealTile( index ) )
                    return;
                continue;
            }
            ending = true;              // nothing fits: the route ends here
        }

        if ( RACE_MetaTryFinish() )
            return;
        if ( budget > 0 && RACE_MetaRewind() )
        {
            budget--;
            continue;
        }

        // Walled in, with nowhere to put a run-out. The gate alone still ends
        // the run properly: the player crosses it, the clock stops and they
        // drop into the pit, which respawns them — and completeRace was going
        // to respawn them in five seconds anyway. Driving a finish corridor
        // through a corridor already on the ground is the worse answer.
        @metaFinishGate = RACE_MetaSpawnGate( metaCursor, metaHeading, 1 );
        metaFinishDealt = true;
        metaBareFinish = true;
        return;
    }
}

// Which dealt tile is this player on? Searched from the front, so a route that
// folds back over itself reports the furthest match rather than the first.
void RACE_MetaTrackProgress( Entity @ent )
{
    Vec3 p = ent.origin;
    for ( int i = int( metaPlaced.length() ) - 1; i > metaProgress; i-- )
    {
        Vec3 lo = metaBoxLo[i];
        Vec3 hi = metaBoxHi[i];
        if ( p.x < lo.x - 64.0f || p.x > hi.x + 64.0f ) continue;
        if ( p.y < lo.y - 64.0f || p.y > hi.y + 64.0f ) continue;
        if ( p.z < lo.z - 256.0f || p.z > hi.z + 256.0f ) continue;
        metaProgress = i;
        return;
    }
}

uint RACE_MetaDrawSeed()
{
    // Seeds are shown to players and typed back in, so they are kept to six
    // digits rather than being a full 32-bit word.
    uint s = uint( levelTime ) * 1103515245 + uint( rand() ) * 12345;
    return ( s % 999983 ) + 1;
}

// Throw the route away and deal a new one from `seed`.
void RACE_MetaNewRoute( uint seed )
{
    RACE_MetaClearRoute();

    metaSeed = seed != 0 ? seed : RACE_MetaDrawSeed();
    metaRng = metaSeed;
    // A few turns of the generator first: xorshift32 started from a small word
    // — 1, 2, 3, the seeds people actually type — takes a handful of rounds
    // before its output stops looking like its seed.
    for ( int i = 0; i < 8; i++ )
        RACE_MetaNextRandom();

    metaCursor = Vec3( 0.0f, 0.0f, 0.0f );
    metaHeading = 0;
    metaProgress = 0;

    if ( !RACE_MetaDealTile( metaStartTile ) )
    {
        metaLoadError = "the start tile has no inline model in this .bsp";
        metaReady = false;
        return;
    }
    // The start gate sits at the END of the start pad, so the clock starts as
    // the player leaves it with a full pad of run-up behind them.
    @metaStartGate = RACE_MetaSpawnGate( metaCursor, metaHeading, 0 );
    RACE_MetaExtend();
}

// Where a player begins: on the start pad, facing down it. The route always
// starts at the play box's origin running along +X with its walking surface at
// z = 0, and a player's origin sits 24 units above their feet. Kept in step
// with tiles.SPAWN, which is where the map's own spawn point is placed.
Vec3 RACE_MetaSpawnSpot()
{
    return Vec3( 96.0f, 0.0f, 32.0f );
}


// --- hooks ------------------------------------------------------------------

void RACE_MetaInit()
{
    Cvar mapNameVar( "mapname", "", 0 );
    metaIsMetaMap = ( mapNameVar.string.tolower() == META_MAP_NAME );
    if ( !metaIsMetaMap )
        return;

    RACE_MetaLoadDeck();
    if ( !metaReady )
    {
        G_Print( "^1metamap: " + metaLoadError + " — " + META_MAP_NAME
                + " will have no route.\n" );
        RACE_MetaSetStatus( "FAIL_no_deck" );
        return;
    }

    // rs_meta_seed pins the course a server runs, so a box can be stood up on
    // a known route (and a bug reproduced) without anyone typing /seed.
    Cvar pinned( "rs_meta_seed", "0", 0 );
    RACE_MetaNewRoute( uint( pinned.integer ) );
    G_Print( "^2metamap: " + metaDeck.length() + " tiles loaded; seed "
            + metaSeed + ", " + metaPlaced.length() + " pieces dealt.\n" );
    RACE_MetaCheckStartPad();
}

// Publish this map's one interesting fact where it can actually be read back.
//
// A log line is not enough here. The engine floods the console during a map
// load and the log shipper drops lines inside that burst — which is precisely
// when this prints, so the answer to "did the route come up correctly?" was
// reliably missing from the logs while being present in a direct rcon reply.
// A cvar survives the burst and answers in one short read:
//
//     rcon rs_meta_status   ->   "ok seed=4242 pieces=7 pad=7 spawn=96,0,32"
//
// Values are kept to letters, digits and , = _ - so the set command can never
// be broken by its own argument.
void RACE_MetaSetStatus( const String &in value )
{
    G_CmdExecute( "set rs_meta_status \"" + value + "\"\n" );
}

// Ask the ENGINE whether the start pad is actually under the spawn point — and
// trace from the spawn ENTITY, not from where we think it is.
//
// The first version of this traced from RACE_MetaSpawnSpot(), a constant, and
// so it cheerfully confirmed the pad while the spawn itself had been moved out
// from under it: SP_info_player_deathmatch runs G_DropSpawnpointToFloor
// (g_utils.cpp:1927), which traces 16,000 units down and relocates the spawn
// onto whatever it finds. That runs during entity spawn, before the route
// exists, so it dropped the spawn to the sky shell ~3,300 units below the pad.
// tiles.py sets spawnflags 1 to stop it; this is what notices if that ever
// stops working.
//
// Between them these are the two things that can be wrong — the pad is not
// where the dealer thinks, or the spawn is not where the map put it — and
// neither is visible to any amount of reasoning about the manifest.
void RACE_MetaCheckStartPad()
{
    Vec3 want = RACE_MetaSpawnSpot();
    Vec3 from = want;
    bool found = false;

    for ( int i = 0; i < numEntities; i++ )
    {
        Entity @ent = G_GetEntity( i );
        if ( @ent == null || !ent.inuse )
            continue;
        if ( ent.classname != "info_player_deathmatch" && ent.classname != "info_player_start" )
            continue;
        from = ent.origin;
        found = true;
        break;
    }

    if ( !found )
    {
        G_Print( "^1metamap: the map has no spawn point at all.\n" );
        RACE_MetaSetStatus( "FAIL_no_spawn_point" );
        return;
    }

    float drift = float( abs( double( from.x - want.x ) ) )
            + float( abs( double( from.y - want.y ) ) )
            + float( abs( double( from.z - want.z ) ) );
    bool moved = drift > 8.0f;
    if ( moved )
    {
        G_Print( "^1metamap: the spawn point has been MOVED to "
                + int( from.x ) + " " + int( from.y ) + " " + int( from.z )
                + ", away from the start pad at "
                + int( want.x ) + " " + int( want.y ) + " " + int( want.z )
                + " — something dropped it to the floor before the route was "
                + "dealt. The deck's spawn needs spawnflags 1 "
                + "(tools/mapgen/tiles.py).\n" );
    }

    Vec3 to = from;
    to.z -= 256.0f;
    Trace tr;
    bool hit = tr.doTrace( from, playerMins, playerMaxs, to, 0, MASK_DEADSOLID );
    if ( hit && !tr.startSolid )
    {
        // Only call it the start pad when the spawn is still where the map put
        // it. A spawn that has drifted is standing on whatever it was dropped
        // onto — the sky shell, usually — and saying "start pad" about that is
        // how the first version of this check managed to report success on a
        // map nobody could play.
        G_Print( ( moved ? "^1metamap: solid ground is " : "^2metamap: start pad is " )
                + int( from.z - tr.endPos.z ) + " units under the spawn at "
                + int( from.x ) + " " + int( from.y ) + " " + int( from.z ) + ".\n" );
        RACE_MetaSetStatus( ( moved ? "FAIL_spawn_moved" : "ok" )
                + " seed=" + metaSeed + " pieces=" + metaPlaced.length()
                + " pad=" + int( from.z - tr.endPos.z )
                + " spawn=" + int( from.x ) + "," + int( from.y ) + "," + int( from.z ) );
        return;
    }

    G_Print( "^1metamap: NOTHING SOLID under the spawn point at "
            + int( from.x ) + " " + int( from.y ) + " " + int( from.z )
            + ( tr.startSolid ? " (spawn is inside solid)" : " (open air)" )
            + " — players will fall on spawn. Check that every deck piece "
            + "compiled with an ORIGIN BRUSH (tools/mapgen/tiles.py _place).\n" );
    RACE_MetaSetStatus( "FAIL_no_floor seed=" + metaSeed
            + " pieces=" + metaPlaced.length()
            + " spawn=" + int( from.x ) + "," + int( from.y ) + "," + int( from.z ) );
}

void RACE_MetaThink()
{
    if ( !metaIsMetaMap || !metaReady )
        return;

    for ( int i = 0; i < maxClients; i++ )
    {
        Client @client = G_GetClient( i );
        if ( @client == null || client.state() < CS_SPAWNED )
            continue;
        Entity @ent = client.getEnt();
        if ( @ent == null )
            continue;
        RACE_MetaApplyStart( RACE_GetPlayer( client ) );
        if ( client.team == TEAM_SPECTATOR )
            continue;
        RACE_MetaTrackProgress( ent );
    }

    RACE_MetaExtend();
}

// Mark a spawning player as owing a trip to the start pad.
//
// Nothing is moved here. GT_PlayerRespawn runs at the END of G_ClientRespawn,
// and Entity.origin only writes a client's pmove origin once that client has
// reached CS_SPAWNED (objectGameEntity_SetOrigin, g_ascript.cpp) — which it has
// not on the first spawn after a map change. So the move is deferred to the
// think loop, exactly as racemod already defers a player's saved start
// ("applied from the think loop once they are a live prerace body",
// hrace.as / savedstarts.as).
//
// The map's own spawn point already sits on the pad, so on a normal spawn this
// has nothing to correct. It earns its keep after a re-deal (/seed), and it is
// what puts the pad in the player's prerace slot so every later /kill and
// /racerestart comes back here too.
void RACE_MetaPlayerSpawn( Player @player )
{
    if ( !metaIsMetaMap || !metaReady || @player == null )
        return;
    Client @client = player.client;
    if ( @client == null )
        return;
    metaStartPending[client.playerNum] = true;
}

// The deferred half: put the player on the start pad once they are a live
// prerace body. One-shot per respawn.
void RACE_MetaApplyStart( Player @player )
{
    Client @client = player.client;
    int pn = client.playerNum;
    if ( !metaStartPending[pn] )
        return;
    if ( client.team == TEAM_SPECTATOR || !player.preRace() )
        return;                             // not a clean prerace body (yet)

    Entity @ent = client.getEnt();
    if ( @ent == null || ent.health <= 0 || ent.isGhosting() )
        return;                             // wait for a live body

    // Built from currentPosition() so the fresh spawn's health, armour and
    // weapons survive: this is a relocation, not a stored loadout. Writing it
    // into prerace slot 0 is what makes every later /kill return to the pad.
    Position p = player.currentPosition();
    p.location = RACE_MetaSpawnSpot();
    p.angles = Vec3( 0.0f, 0.0f, 0.0f );
    p.velocity = Vec3( 0.0f, 0.0f, 0.0f );
    p.saved = true;
    p.recalled = false;
    p.skipWeapons = false;
    player.preRacePositionStore.set( "", p );
    player.applyPosition( p );
    metaStartPending[pn] = false;
}

bool RACE_MetaSomeoneRacing( Client @except )
{
    for ( int i = 0; i < maxClients; i++ )
    {
        Client @client = G_GetClient( i );
        if ( @client == null || client.state() < CS_SPAWNED )
            continue;
        if ( @except != null && client.playerNum == except.playerNum )
            continue;
        Player @player = RACE_GetPlayer( client );
        if ( @player != null && player.inRace )
            return true;
    }
    return false;
}

// "/seed" — what course is this, and how do I run it again?
// "/seed <n>" — deal that course, for everyone.
//
// Changing the seed changes the ground under every player, so it is refused
// while anyone else is mid-run rather than pulling the floor out from under
// them. Nothing here is a vote: a route is cheap to re-deal and any seed can
// be dealt again at any time, which is what makes the board's seed column
// useful in the first place.
bool RACE_MetaCommand( Client @client, const String &cmdString, const String &argsString, int argc )
{
    if ( cmdString != "seed" && cmdString != "newseed" )
        return false;
    if ( !metaIsMetaMap )
    {
        client.printMessage( S_COLOR_ORANGE + "seed: only on " + META_MAP_NAME + ".\n" );
        return true;
    }
    if ( !metaReady )
    {
        client.printMessage( S_COLOR_RED + "seed: no deck loaded (" + metaLoadError + ").\n" );
        return true;
    }

    // The argument is read off argsString rather than counted off argc: every
    // other command here does the same, and nothing in the codebase pins down
    // whether argc includes the command word.
    String arg = argsString.getToken( 0 );
    uint want = 0;
    if ( cmdString == "newseed" )
        want = RACE_MetaDrawSeed();
    else if ( arg.length() > 0 )
    {
        int n = arg.toInt();
        if ( n <= 0 )
        {
            client.printMessage( S_COLOR_ORANGE + "seed: a seed is a positive number.\n" );
            return true;
        }
        want = uint( n );
    }

    if ( want == 0 )
    {
        client.printMessage( S_COLOR_ORANGE + "Seed " + S_COLOR_WHITE + metaSeed
                + S_COLOR_ORANGE + " — " + metaPlaced.length() + " pieces, "
                + int( metaDealtRoute ) + " units"
                + ( metaFinishDealt ? "" : " so far" ) + ".\n"
                + S_COLOR_ORANGE + "Use " + S_COLOR_WHITE + "seed <number>"
                + S_COLOR_ORANGE + " to run someone else's, or "
                + S_COLOR_WHITE + "newseed" + S_COLOR_ORANGE + " for a fresh one.\n" );
        return true;
    }

    if ( want == metaSeed )
    {
        client.printMessage( S_COLOR_ORANGE + "seed: already running " + metaSeed + ".\n" );
        return true;
    }
    if ( RACE_MetaSomeoneRacing( client ) )
    {
        client.printMessage( S_COLOR_ORANGE
                + "seed: someone is mid-run — the course would change under them. "
                + "Try again in a moment.\n" );
        return true;
    }

    RACE_MetaNewRoute( want );
    G_PrintMsg( null, S_COLOR_ORANGE + client.name + S_COLOR_ORANGE
            + " dealt a new course: seed " + S_COLOR_WHITE + metaSeed + "\n" );
    for ( int i = 0; i < maxClients; i++ )
    {
        Client @other = G_GetClient( i );
        if ( @other == null || other.state() < CS_SPAWNED || other.team == TEAM_SPECTATOR )
            continue;
        RACE_MetaPlayerSpawn( RACE_GetPlayer( other ) );
    }
    return true;
}

// A finished run on the meta map.
//
// Deliberately NOT a record: player.as keeps this map out of the top-scores
// board, out of the demo and ghost uploads and out of /api/ingest, because a
// time is only a time against a course and this course was invented a minute
// ago. What it is worth keeping is the pair — the time and the seed that
// produced the route — so the board can say "beat this, here is the course".
void RACE_MetaFinish( Player @player, uint timeMs )
{
    if ( !metaIsMetaMap || @player == null )
        return;

    Client @client = player.client;
    client.printMessage( S_COLOR_ORANGE + "Seed " + S_COLOR_WHITE + metaSeed
            + S_COLOR_ORANGE + " — " + metaPlaced.length() + " pieces, "
            + int( metaDealtRoute ) + " units. Share it: "
            + S_COLOR_WHITE + "seed " + metaSeed + "\n" );

    if ( rsMetaReportUrl.string.length() == 0 )
        return;

    Cvar rsApiToken( "rs_api_token", "", 0 );
    Cvar rsApiVersion( "rs_api_version", "wsw 2.1", 0 );
    RS_ApiReportRandomRun( rsMetaReportUrl.string, rsApiToken.string, rsApiVersion.string,
            int( metaSeed ), int( timeMs ),
            client.name, client.getMMLogin(),
            int( metaPlaced.length() ), int( metaDealtRoute ) );
}
