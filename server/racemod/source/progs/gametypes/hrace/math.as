float Lerp( float a, float t, float b )
{
    return a * ( 1.0 - t ) + b * t;
}

uint Lerp( uint a, float t, uint b )
{
    return uint( Lerp( float( a ), t, float( b ) ) );
}

Vec3 Lerp( Vec3 a, float t, Vec3 b )
{
    return a * ( 1.0 - t ) + b * t;
}

float LerpAngle( float a, float t, float b )
{
    if ( b - a > 180 )
        b -= 360;
    if ( b - a < -180 )
        b += 360;
    return Lerp( a, t, b );
}

Vec3 LerpAngles( Vec3 a, float t, Vec3 b )
{
    return Vec3(
        LerpAngle( a.x, t, b.x ),
        LerpAngle( a.y, t, b.y ),
        LerpAngle( a.z, t, b.z )
    );
}

Position Lerp( Position a, float t, Position b )
{
    Position p;
    p.copy( t < 0.5 ? a : b );
    p.location = Lerp( a.location, t, b.location );
    p.angles = LerpAngles( a.angles, t, b.angles );
    p.velocity = Lerp( a.velocity, t, b.velocity );
    p.currentTime = Lerp( a.currentTime, t, b.currentTime );
    return p;
}

// Cubic Hermite interpolation of a position between two captured keyframes,
// using the per-frame recorded velocities as tangents. Unlike a straight Lerp
// (which chords across the interior of a curve), this hugs the actual strafe
// arc, because the endpoints' velocities bend the path the way the runner moved.
// p0/p1 are the keyframe origins, v0/v1 the keyframe velocities (units/sec),
// t in [0,1] the fraction between them, dtSec the keyframe interval in seconds
// (so v*dtSec is the tangent expressed in the same units as the positions).
Vec3 HermitePos( Vec3 p0, Vec3 v0, Vec3 p1, Vec3 v1, float t, float dtSec )
{
    float t2 = t * t;
    float t3 = t2 * t;
    float h00 = 2.0f * t3 - 3.0f * t2 + 1.0f;
    float h10 = t3 - 2.0f * t2 + t;
    float h01 = -2.0f * t3 + 3.0f * t2;
    float h11 = t3 - t2;
    return p0 * h00 + ( v0 * dtSec ) * h10 + p1 * h01 + ( v1 * dtSec ) * h11;
}

Vec3 HorizontalVelocity( Vec3 vel )
{
    vel.z = 0;
    return vel;
}

float HorizontalSpeed( Vec3 vel )
{
    return HorizontalVelocity( vel ).length();
}

uint randrange(uint n)
{
    uint64 r = 0;
    for ( int i = 0; i < 32; i++ )
        r = ( r << 1 ) | ( ( rand() ^ ( realTime >> i ) ) & 1 );
    return uint( ( r * uint64( n ) ) >> 32 );
}
