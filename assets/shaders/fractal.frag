#version 330 core

// Mandelbulb world: a power-8 bulb slowly rotating above a dim floor,
// colored by orbit trap through a cosine palette.

#define MAX_STEPS      160
#define MAX_DISTANCE   60.0
#define HIT_EPSILON    0.0008
#define STEP_SCALE     0.9
#define NORMAL_EPSILON 0.0005
#define FOG_DENSITY    0.05
#define SHADOW_STEPS   48
#define SHADOW_STEP_MAX 0.4
#define AO_STEP        0.02
#define AO_STRENGTH    12.0

#include "worldlib.glsl"

// Fractal parameters
const float POWER      = 8.0;  // classic power-8 Mandelbulb
const int   ITERATIONS = 12;
const float BAILOUT    = 2.0;

// Material IDs
const float MAT_GROUND  = 0.0;
const float MAT_FRACTAL = 1.0;

// ---------------------------------------------------------------------------
// Distance estimator
// ---------------------------------------------------------------------------

// Mandelbulb distance estimate: iterate z -> z^POWER + c in spherical
// coordinates, tracking the running derivative dr for the distance
// bound 0.5 * |z| * log|z| / dr.
float mandelbulbDE(vec3 p)
{
    vec3 z = p;
    float dr = 1.0;
    float r = length(z);
    float trap = r;

    for (int i = 0; i < ITERATIONS; ++i)
    {
        if (r > BAILOUT)
            break;

        // To spherical coordinates.
        float theta = acos(clamp(z.z / r, -1.0, 1.0));
        float phi = atan(z.y, z.x);

        // Scalar derivative of the iteration.
        dr = pow(r, POWER - 1.0) * POWER * dr + 1.0;

        // z^POWER back to cartesian, plus the constant term.
        float zr = pow(r, POWER);
        theta *= POWER;
        phi *= POWER;

        z = zr * vec3(
            sin(theta) * cos(phi),
            sin(theta) * sin(phi),
            cos(theta)
        ) + p;

        r = length(z);
        trap = min(trap, r);
    }

    gOrbitTrap = trap;
    return 0.5 * log(r) * r / dr;
}

// Horizontal plane at height h with upward normal.
float sdPlane(vec3 p, float h)
{
    return p.y - h;
}

// ---------------------------------------------------------------------------
// Scene description
// ---------------------------------------------------------------------------

vec2 map(vec3 p)
{
    vec2 scene = vec2(sdPlane(p, -1.2), MAT_GROUND);

    // The bulb floats above the ground and slowly spins around Y.
    vec3 q = p - vec3(0.0, 1.0, 0.0);
    float a = 0.15 * uTime;
    float c = cos(a);
    float s = sin(a);
    q.xz = mat2(c, -s, s, c) * q.xz;

    scene = opUnion(scene, vec2(mandelbulbDE(q), MAT_FRACTAL));

    return scene;
}

// ---------------------------------------------------------------------------
// Shading
// ---------------------------------------------------------------------------

vec3 missColor(vec3 rd)
{
    // Deep dusk gradient so the fractal colors stand out.
    return mix(
        vec3(0.10, 0.08, 0.16),
        vec3(0.02, 0.02, 0.06),
        clamp(rd.y, 0.0, 1.0)
    );
}

vec3 shade(vec3 ro, vec3 rd, float t, float mat)
{
    // Capture the orbit trap of the primary-ray hit before any other
    // map() evaluation (normals, shadows, AO) overwrites it.
    float trap = gOrbitTrap;

    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p, t);

    vec3 albedo;
    if (mat == MAT_GROUND)
    {
        // Dim checkerboard so the floor reads without stealing focus.
        float checker = mod(floor(p.x) + floor(p.z), 2.0);
        albedo = mix(vec3(0.05), vec3(0.09), checker);
    }
    else
    {
        albedo = cosinePalette(
            clamp(trap * 0.7, 0.0, 1.0),
            vec3(1.0),
            vec3(0.0, 0.10, 0.20)
        );
    }

    vec3 lightDir = normalize(vec3(0.6, 0.8, -0.5));
    vec3 lightColor = vec3(1.0, 0.9, 0.8);

    float diffuse = max(dot(n, lightDir), 0.0);
    vec3 halfway = normalize(lightDir - rd);
    float specular = pow(max(dot(n, halfway), 0.0), 48.0);

    float shadow = softShadow(p + n * 0.01, lightDir, 0.02, 12.0, 12.0);
    float ao = ambientOcclusion(p, n);

    vec3 color = vec3(0.0);
    color += albedo * lightColor * diffuse * shadow;
    color += lightColor * specular * shadow * 0.6;
    color += albedo * vec3(0.25, 0.20, 0.35) * ao; // purple ambient

    return applyFog(color, missColor(rd), t);
}
