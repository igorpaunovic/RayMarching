#version 330 core

// Optimized variant of clouds.frag (same look, less work):
//  - slab clipping: rays only march inside the two cloud height bands,
//    computed analytically, instead of stepping through empty sky;
//  - empty-space skipping: strides ~3x farther while outside cloud,
//    fine steps only inside;
//  - octave LOD: full 5-octave noise near the camera, fewer octaves
//    for far samples and for the sunward lighting sample;
//  - band-local evaluation: cumulus and cirrus noise are only computed
//    for points inside their own band, plus a coarse weather early-out.

out vec4 FragColor;

uniform vec2  uResolution; // framebuffer size in pixels
uniform float uTime;       // seconds since startup
uniform vec3  uCamPos;     // camera position, world space
uniform mat3  uCamRot;     // camera basis: columns = (right, up, forward)

const float FOCAL_LENGTH = 1.5; // ~67 degrees vertical FOV
const int   MARCH_STEPS  = 128;
const float MAX_DISTANCE = 300.0;

const vec3 SUN_DIR = normalize(vec3(0.6, 0.3, -0.7));

// Menu-controlled effects: "shadows" is the cloud self-shading sample,
// "fog" the aerial dissolve of distant clouds into the sky.
uniform bool uEnableShadows = true;
uniform bool uEnableFog     = true;

// Cloud band extents (slightly padded past the density smoothsteps so
// the soft edges are not clipped).
const float CUMULUS_MIN = -78.0;
const float CUMULUS_MAX = -2.0;
const float CIRRUS_MIN  = 88.0;
const float CIRRUS_MAX  = 152.0;

// ---------------------------------------------------------------------------
// Value noise and fractal Brownian motion
// ---------------------------------------------------------------------------

float hash(vec3 p)
{
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise(vec3 x)
{
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f); // smoothstep fade

    return mix(
        mix(mix(hash(i + vec3(0, 0, 0)), hash(i + vec3(1, 0, 0)), f.x),
            mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x),
            f.y),
        mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
            mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x),
            f.y),
        f.z
    );
}

// Octave count is a parameter so callers can trade detail for speed.
float fbm(vec3 p, int octaves)
{
    float value = 0.0;
    float amplitude = 0.5;

    for (int i = 0; i < octaves; ++i)
    {
        value += amplitude * noise(p);
        p = p * 2.02;
        amplitude *= 0.5;
    }

    return value;
}

// ---------------------------------------------------------------------------
// Cloud density field
// ---------------------------------------------------------------------------

float cloudDensity(vec3 p, int octaves)
{
    // Wind: the whole field drifts.
    vec3 q = p - vec3(6.0, 0.0, 3.0) * uTime * 0.4;

    float den = 0.0;

    if (p.y < CUMULUS_MAX)
    {
        // Vertical profile of the cumulus deck: soft floor and ceiling.
        float band =
            smoothstep(-75.0, -45.0, p.y) * smoothstep(-4.0, -25.0, p.y);

        if (band > 0.001)
        {
            // Weather is very low frequency; 3 octaves carry its shape.
            float weather = fbm(q * 0.007 + vec3(0.0, 0.0, 100.0), 3);

            // Coarse early-out: detail noise realistically tops out
            // around 0.85, so regions with weak weather can never
            // produce positive density; skip the expensive fbm there.
            if (weather * 1.2 - 0.96 + 0.85 > 0.0)
            {
                float shape = fbm(q * 0.035, octaves);
                den = (shape + weather * 1.2 - 0.96) * band;
            }
        }
    }
    else if (p.y > CIRRUS_MIN)
    {
        // Cirrus: stretched domain -> long wispy streaks, thin band.
        float band =
            smoothstep(90.0, 110.0, p.y) * smoothstep(150.0, 125.0, p.y);

        if (band > 0.001)
        {
            vec3 c = q * vec3(0.010, 0.15, 0.022);
            den = (fbm(c, octaves) - 0.55) * band * 0.6;
        }
    }

    return clamp(den * 2.2, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Sky background
// ---------------------------------------------------------------------------

vec3 skyColor(vec3 rd)
{
    // Blue gradient, hazier toward and below the horizon.
    vec3 sky = mix(
        vec3(0.62, 0.72, 0.90),
        vec3(0.22, 0.40, 0.75),
        clamp(rd.y, 0.0, 1.0)
    );
    sky = mix(sky, vec3(0.70, 0.74, 0.80), smoothstep(0.1, -0.4, rd.y));

    float sun = clamp(dot(rd, SUN_DIR), 0.0, 1.0);
    sky += vec3(1.0, 0.75, 0.45) * pow(sun, 220.0) * 2.0; // disk
    sky += vec3(1.0, 0.80, 0.50) * pow(sun, 6.0) * 0.20;  // haze glow

    return sky;
}

// ---------------------------------------------------------------------------
// Volumetric integration
// ---------------------------------------------------------------------------

// Intersects the ray with a horizontal slab [yMin, yMax]. Returns the
// (near, far) parametric range clipped to the march distance; an empty
// interval (near > far) means the slab is missed entirely.
vec2 slabInterval(vec3 ro, vec3 rd, float yMin, float yMax)
{
    if (abs(rd.y) < 1e-4)
    {
        return (ro.y >= yMin && ro.y <= yMax)
            ? vec2(0.0, MAX_DISTANCE)
            : vec2(1.0, 0.0); // empty
    }

    float t0 = (yMin - ro.y) / rd.y;
    float t1 = (yMax - ro.y) / rd.y;

    if (t0 > t1)
    {
        float tmp = t0;
        t0 = t1;
        t1 = tmp;
    }

    return vec2(max(t0, 0.0), min(t1, MAX_DISTANCE));
}

// Marches one band interval, accumulating premultiplied color and
// opacity front-to-back into sum.
void marchInterval(vec3 ro, vec3 rd, vec2 range, vec3 bg, inout vec4 sum)
{
    float t = range.x + 0.05;

    for (int i = 0; i < MARCH_STEPS; ++i)
    {
        if (t > range.y || sum.a > 0.99)
            break;

        vec3 pos = ro + rd * t;

        // Octave LOD: full detail near, coarser far away where the
        // extra octaves are smaller than a pixel anyway.
        int octaves = (t < 60.0) ? 5 : (t < 150.0) ? 4 : 3;

        float den = cloudDensity(pos, octaves);

        if (den > 0.01)
        {
            // Sunward sample only feeds a soft lighting term; low
            // detail is indistinguishable there. Flat value when
            // self-shading is disabled (also skips the extra sample).
            float dif = 0.25;
            if (uEnableShadows)
            {
                float sunward = cloudDensity(pos + SUN_DIR * 5.0, 3);
                dif = clamp((den - sunward) * 1.6, 0.0, 1.0);
            }

            // Ambient sky light plus warm directional sun.
            vec3 lin = vec3(0.62, 0.68, 0.80) * 1.15
                     + vec3(1.0, 0.75, 0.55) * dif * 1.6;

            // Dense cores go gray, edges stay bright.
            vec3 cloudColor = mix(
                vec3(1.05, 1.0, 0.95),
                vec3(0.35, 0.38, 0.43),
                den
            );

            vec4 col = vec4(cloudColor * lin, den);

            // Distant clouds dissolve into the sky for aerial depth.
            if (uEnableFog)
                col.rgb = mix(col.rgb, bg, 1.0 - exp(-0.003 * t));

            // Premultiply and accumulate front-to-back.
            col.a *= 0.42;
            col.rgb *= col.a;
            sum += col * (1.0 - sum.a);

            // Fine steps while inside cloud.
            t += max(0.3, 0.04 * t);
        }
        else
        {
            // Empty space: stride ~3x farther until cloud is found.
            t += max(1.0, 0.10 * t);
        }
    }
}

vec4 marchClouds(vec3 ro, vec3 rd, vec3 bg)
{
    vec2 cumulus = slabInterval(ro, rd, CUMULUS_MIN, CUMULUS_MAX);
    vec2 cirrus = slabInterval(ro, rd, CIRRUS_MIN, CIRRUS_MAX);

    vec4 sum = vec4(0.0);

    // March in order of entry so front-to-back compositing stays valid.
    if (cumulus.x <= cirrus.x)
    {
        if (cumulus.x < cumulus.y)
            marchInterval(ro, rd, cumulus, bg, sum);
        if (cirrus.x < cirrus.y)
            marchInterval(ro, rd, cirrus, bg, sum);
    }
    else
    {
        if (cirrus.x < cirrus.y)
            marchInterval(ro, rd, cirrus, bg, sum);
        if (cumulus.x < cumulus.y)
            marchInterval(ro, rd, cumulus, bg, sum);
    }

    return clamp(sum, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

void main()
{
    vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

    vec3 ro = uCamPos;
    vec3 rd = normalize(uCamRot * vec3(uv, FOCAL_LENGTH));

    vec3 sky = skyColor(rd);
    vec4 clouds = marchClouds(ro, rd, sky);

    vec3 color = sky * (1.0 - clouds.a) + clouds.rgb;

    // No gamma here: cloud and sky values are tuned in display space,
    // as is conventional for this style of shader.
    FragColor = vec4(color, 1.0);
}
