#version 330 core

// Large fractal world: a Mandelbox scaled up into a structure hundreds
// of units across, lit by a low sun with glow, height-tinted haze and
// an exposure curve for drama.

#define MAX_STEPS      220
#define MAX_DISTANCE   260.0
#define HIT_EPSILON    0.0006
#define STEP_SCALE     0.85
#define NORMAL_EPSILON 0.0006
#define FOG_DENSITY    0.004
#define SHADOW_STEPS   40
#define SHADOW_STEP_MIN 0.02
#define SHADOW_STEP_MAX 2.0
#define AO_STEP        0.1
#define AO_STRENGTH    2.5
#define AO_FALLOFF     0.65
#define EXPOSURE       1.2

#include "worldlib.glsl"

// Fractal parameters. A negative-scale Mandelbox produces huge curved
// halls and arches instead of the cubic grids of positive scales.
const float BOX_SCALE      = -1.77;
const int   ITERATIONS     = 13;
const float MIN_RADIUS_2   = 0.25;
const float FIXED_RADIUS_2 = 1.0;

// Uniform world scale: the raw Mandelbox spans a few units, this blows
// it up into a structure hundreds of units across.
const float WORLD_SCALE = 12.0;

// Material IDs
const float MAT_FRACTAL = 1.0;

// ---------------------------------------------------------------------------
// Distance estimator
// ---------------------------------------------------------------------------

// Mandelbox: alternately fold space with a box fold (mirror at +-1)
// and a sphere fold (inversion), then scale and translate back by the
// original point. dr tracks the running derivative for the DE bound.
float mandelboxDE(vec3 p)
{
    vec3 z = p;
    float dr = 1.0;
    float trap = 1e9;

    for (int i = 0; i < ITERATIONS; ++i)
    {
        // Box fold.
        z = clamp(z, -1.0, 1.0) * 2.0 - z;

        // Sphere fold.
        float r2 = dot(z, z);
        if (r2 < MIN_RADIUS_2)
        {
            float f = FIXED_RADIUS_2 / MIN_RADIUS_2;
            z *= f;
            dr *= f;
        }
        else if (r2 < FIXED_RADIUS_2)
        {
            float f = FIXED_RADIUS_2 / r2;
            z *= f;
            dr *= f;
        }

        z = z * BOX_SCALE + p;
        dr = dr * abs(BOX_SCALE) + 1.0;

        trap = min(trap, length(z));
    }

    gOrbitTrap = trap;
    return length(z) / abs(dr);
}

// ---------------------------------------------------------------------------
// Scene description
// ---------------------------------------------------------------------------

// The fractal is evaluated in unit space and the distance is scaled
// back up, which is how you enlarge an SDF without distorting it.
// The structure is pushed ahead of the spawn point so the camera
// starts outside it with a full view instead of embedded in mass.
vec2 map(vec3 p)
{
    vec3 q = p - vec3(0.0, 0.0, 100.0);
    float d = mandelboxDE(q / WORLD_SCALE) * WORLD_SCALE;
    return vec2(d, MAT_FRACTAL);
}

// ---------------------------------------------------------------------------
// Shading
// ---------------------------------------------------------------------------

const vec3 SUN_DIR = normalize(vec3(0.55, 0.35, -0.75));

vec3 skyColor(vec3 rd)
{
    // Deep space-blue gradient with a hot sun disk and halo.
    vec3 sky = mix(
        vec3(0.03, 0.04, 0.10),
        vec3(0.01, 0.01, 0.03),
        clamp(rd.y * 0.5 + 0.5, 0.0, 1.0)
    );

    float sun = clamp(dot(rd, SUN_DIR), 0.0, 1.0);
    sky += vec3(1.0, 0.75, 0.45) * pow(sun, 256.0) * 4.0; // disk
    sky += vec3(1.0, 0.55, 0.25) * pow(sun, 8.0) * 0.25;  // halo

    return sky;
}

vec3 missColor(vec3 rd)
{
    vec3 color = skyColor(rd);

    // Rays that grazed the structure pick up a warm glow, so the
    // fractal appears to radiate light against the dark sky.
    float glow = exp(-0.20 * gClosest);
    color += vec3(1.0, 0.5, 0.2) * glow * 0.6;

    return color;
}

vec3 shade(vec3 ro, vec3 rd, float t, float mat)
{
    // Capture the orbit trap of the primary-ray hit before any other
    // map() evaluation (normals, shadows, AO) overwrites it.
    float trap = gOrbitTrap;

    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p, t);

    // Gold, copper and deep teal driven by the orbit trap.
    vec3 albedo = cosinePalette(
        clamp(trap * 0.35, 0.0, 1.0),
        vec3(0.9, 1.0, 1.1),
        vec3(0.05, 0.30, 0.55)
    );

    vec3 sunColor = vec3(1.0, 0.82, 0.6);

    float diffuse = max(dot(n, SUN_DIR), 0.0);
    vec3 halfway = normalize(SUN_DIR - rd);
    float specular = pow(max(dot(n, halfway), 0.0), 64.0);

    float shadow = softShadow(p + n * 0.05, SUN_DIR, 0.1, 60.0, 16.0);
    float ao = ambientOcclusion(p, n);

    // Fake bounce light from below in the opposite hue, a common trick
    // to keep giant interiors from going pitch black.
    float bounce = max(dot(n, vec3(0.0, -1.0, 0.0)), 0.0);

    vec3 color = vec3(0.0);
    color += albedo * sunColor * diffuse * shadow * 1.4;
    color += sunColor * specular * shadow * 0.8;
    color += albedo * vec3(0.10, 0.14, 0.25) * ao * 2.0;    // cool ambient
    color += albedo * vec3(0.25, 0.10, 0.05) * bounce * ao; // warm bounce

    // Height-tinted haze: warm below, cold above, for a sense of scale.
    vec3 haze = mix(
        vec3(0.30, 0.15, 0.10),
        vec3(0.05, 0.07, 0.15),
        clamp(rd.y * 0.5 + 0.5, 0.0, 1.0)
    );

    return applyFog(color, haze, t);
}
