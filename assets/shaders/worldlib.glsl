// ---------------------------------------------------------------------------
// Shared raymarching library, spliced into world shaders through the
// custom #include directive handled by the application's shader loader.
//
// A world shader must, after including this file, define:
//
//   vec2 map(vec3 p);                                  scene SDF
//   vec3 missColor(vec3 rd);                           sky / background
//   vec3 shade(vec3 ro, vec3 rd, float t, float mat);  surface color
//
// Tunables below may be overridden with #define BEFORE the #include.
// This file must not declare #version; the world shader owns line 1.
// ---------------------------------------------------------------------------

out vec4 FragColor;

uniform vec2  uResolution; // framebuffer size in pixels
uniform float uTime;       // seconds since startup
uniform vec3  uCamPos;     // camera position, world space
uniform mat3  uCamRot;     // camera basis: columns = (right, up, forward)

// ---------------------------------------------------------------------------
// Tunables and their defaults
// ---------------------------------------------------------------------------

#ifndef MAX_STEPS
#define MAX_STEPS 128
#endif

#ifndef MAX_DISTANCE
#define MAX_DISTANCE 100.0
#endif

#ifndef HIT_EPSILON
#define HIT_EPSILON 0.001
#endif

#ifndef FOCAL_LENGTH
#define FOCAL_LENGTH 1.5 // ~67 degrees vertical FOV
#endif

// March step damping; fractal DEs are lower bounds and need < 1.0.
#ifndef STEP_SCALE
#define STEP_SCALE 1.0
#endif

#ifndef NORMAL_EPSILON
#define NORMAL_EPSILON 0.001
#endif

#ifndef FOG_DENSITY
#define FOG_DENSITY 0.02
#endif

#ifndef SHADOW_STEPS
#define SHADOW_STEPS 64
#endif

#ifndef SHADOW_STEP_MIN
#define SHADOW_STEP_MIN 0.01
#endif

#ifndef SHADOW_STEP_MAX
#define SHADOW_STEP_MAX 0.5
#endif

#ifndef AO_STEP
#define AO_STEP 0.06
#endif

#ifndef AO_STRENGTH
#define AO_STRENGTH 2.0
#endif

#ifndef AO_FALLOFF
#define AO_FALLOFF 0.6
#endif

// Optional: #define EXPOSURE x.y before the include to get a filmic-ish
// exposure curve before gamma; otherwise plain gamma is applied.

const float MAT_NONE = -1.0;

// ---------------------------------------------------------------------------
// World hooks (defined by the including shader)
// ---------------------------------------------------------------------------

vec2 map(vec3 p);
vec3 missColor(vec3 rd);
vec3 shade(vec3 ro, vec3 rd, float t, float mat);

// ---------------------------------------------------------------------------
// Globals written during marching
// ---------------------------------------------------------------------------

// Orbit trap for fractal coloring; world DE functions may write it in
// map() and read it back in shade(). Note that any later map() call
// (calcNormal, shadows, AO) overwrites it, so capture it early.
float gOrbitTrap = 0.0;

// Closest approach to any surface along the primary ray; lets miss
// shading add glow to rays that grazed the scene.
float gClosest = 1e9;

// ---------------------------------------------------------------------------
// SDF helpers
// ---------------------------------------------------------------------------

// Returns whichever of two (distance, material) pairs is nearer.
vec2 opUnion(vec2 a, vec2 b)
{
    return (a.x < b.x) ? a : b;
}

// ---------------------------------------------------------------------------
// Sphere tracing
// ---------------------------------------------------------------------------

// Returns vec2(hit distance along ray, material ID); material MAT_NONE
// on a miss. The hit epsilon scales with distance so far surfaces
// resolve without excessive iteration.
vec2 rayMarch(vec3 ro, vec3 rd)
{
    float t = 0.0;
    gClosest = 1e9;

    for (int i = 0; i < MAX_STEPS; ++i)
    {
        vec2 hit = map(ro + rd * t);

        gClosest = min(gClosest, hit.x);

        if (hit.x < HIT_EPSILON * max(t, 1.0))
            return vec2(t, hit.y);

        t += hit.x * STEP_SCALE;

        if (t > MAX_DISTANCE)
            break;
    }

    return vec2(MAX_DISTANCE, MAT_NONE);
}

// Surface normal = normalized gradient of the SDF (central differences).
// The offset grows with distance so far-away surfaces stay stable.
vec3 calcNormal(vec3 p, float t)
{
    vec2 e = vec2(max(NORMAL_EPSILON * t, NORMAL_EPSILON), 0.0);
    return normalize(vec3(
        map(p + e.xyy).x - map(p - e.xyy).x,
        map(p + e.yxy).x - map(p - e.yxy).x,
        map(p + e.yyx).x - map(p - e.yyx).x
    ));
}

// ---------------------------------------------------------------------------
// Soft shadows and ambient occlusion
// ---------------------------------------------------------------------------

// Soft shadow by marching toward the light and tracking how close the
// ray came to any occluder relative to the distance traveled (penumbra
// cone approximation). k controls penumbra sharpness.
float softShadow(vec3 ro, vec3 rd, float tMin, float tMax, float k)
{
    float result = 1.0;
    float t = tMin;

    for (int i = 0; i < SHADOW_STEPS; ++i)
    {
        float d = map(ro + rd * t).x;

        if (d < HIT_EPSILON)
            return 0.0;

        result = min(result, k * d / t);
        t += clamp(d, SHADOW_STEP_MIN, SHADOW_STEP_MAX);

        if (t > tMax)
            break;
    }

    return clamp(result, 0.0, 1.0);
}

// Ambient occlusion from a few SDF samples along the normal: where the
// distance field grows slower than the sample offset, geometry is near.
float ambientOcclusion(vec3 p, vec3 n)
{
    float occlusion = 0.0;
    float weight = 1.0;

    for (int i = 1; i <= 5; ++i)
    {
        float h = AO_STEP * float(i);
        float d = map(p + n * h).x;
        occlusion += weight * (h - d);
        weight *= AO_FALLOFF;
    }

    return clamp(1.0 - AO_STRENGTH * occlusion, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

// Exponential (Beer-Lambert) distance fog toward a haze color.
vec3 applyFog(vec3 color, vec3 haze, float t)
{
    float fog = 1.0 - exp(-FOG_DENSITY * t);
    return mix(color, haze, fog);
}

// Cosine palette (Inigo Quilez): smooth cyclic colors from one scalar.
vec3 cosinePalette(float t, vec3 freq, vec3 phase)
{
    return vec3(0.5) + vec3(0.5) * cos(6.28318 * (freq * t + phase));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

void main()
{
    // Pixel -> normalized screen coordinate, aspect-corrected,
    // y up, origin at screen center.
    vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

    // Camera ray.
    vec3 ro = uCamPos;
    vec3 rd = normalize(uCamRot * vec3(uv, FOCAL_LENGTH));

    vec2 hit = rayMarch(ro, rd);

    vec3 color = (hit.y < 0.0)
        ? missColor(rd)
        : shade(ro, rd, hit.x, hit.y);

#ifdef EXPOSURE
    color = 1.0 - exp(-EXPOSURE * color);
#endif

    // Simple gamma correction.
    color = pow(color, vec3(1.0 / 2.2));

    FragColor = vec4(color, 1.0);
}
