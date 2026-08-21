#version 330 core

out vec4 FragColor;

uniform vec2  uResolution; // framebuffer size in pixels
uniform float uTime;       // seconds since startup
uniform vec3  uCamPos;     // camera position, world space
uniform mat3  uCamRot;     // camera basis: columns = (right, up, forward)

// ---------------------------------------------------------------------------
// Ray marching parameters
// ---------------------------------------------------------------------------

const int   MAX_STEPS    = 220;
const float MAX_DISTANCE = 260.0;
const float HIT_EPSILON  = 0.0006;
const float FOCAL_LENGTH = 1.5; // ~67 degrees vertical FOV

// Fractal parameters. A negative-scale Mandelbox produces huge curved
// halls and arches instead of the cubic grids of positive scales.
const float BOX_SCALE     = -1.77;
const int   ITERATIONS    = 13;
const float MIN_RADIUS_2  = 0.25;
const float FIXED_RADIUS_2 = 1.0;

// Uniform world scale: the raw Mandelbox spans a few units, this blows
// it up into a structure hundreds of units across that the camera
// starts inside of.
const float WORLD_SCALE = 12.0;

// Material IDs
const float MAT_NONE    = -1.0;
const float MAT_FRACTAL =  1.0;

// Written by the distance estimator during map(): orbit trap for
// coloring (min |z| over the iteration).
float gOrbitTrap = 0.0;

// Written by rayMarch(): closest approach to the surface along the ray,
// used to add glow to rays that graze the structure and miss.
float gClosest = 1e9;

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

// Returns vec2(signed distance, material ID) of the nearest surface.
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
// Sphere tracing
// ---------------------------------------------------------------------------

// Returns vec2(hit distance along ray, material ID); material MAT_NONE
// on a miss. Damped steps and a distance-scaled epsilon keep the
// lower-bound fractal DE from causing surface speckle.
vec2 rayMarch(vec3 ro, vec3 rd)
{
    float t = 0.01;
    gClosest = 1e9;

    for (int i = 0; i < MAX_STEPS; ++i)
    {
        vec2 hit = map(ro + rd * t);

        gClosest = min(gClosest, hit.x);

        if (hit.x < HIT_EPSILON * max(t, 1.0))
            return vec2(t, hit.y);

        t += hit.x * 0.85;

        if (t > MAX_DISTANCE)
            break;
    }

    return vec2(MAX_DISTANCE, MAT_NONE);
}

// Surface normal = normalized gradient of the SDF (central differences).
// The offset grows with distance so far-away surfaces stay stable.
vec3 calcNormal(vec3 p, float t)
{
    vec2 e = vec2(max(0.0006 * t, 0.0006), 0.0);
    return normalize(vec3(
        map(p + e.xyy).x - map(p - e.xyy).x,
        map(p + e.yxy).x - map(p - e.yxy).x,
        map(p + e.yyx).x - map(p - e.yyx).x
    ));
}

// ---------------------------------------------------------------------------
// Soft shadows and ambient occlusion
// ---------------------------------------------------------------------------

float softShadow(vec3 ro, vec3 rd, float tMin, float tMax, float k)
{
    float result = 1.0;
    float t = tMin;

    for (int i = 0; i < 40; ++i)
    {
        float d = map(ro + rd * t).x;

        if (d < HIT_EPSILON)
            return 0.0;

        result = min(result, k * d / t);
        t += clamp(d, 0.02, 2.0);

        if (t > tMax)
            break;
    }

    return clamp(result, 0.0, 1.0);
}

float ambientOcclusion(vec3 p, vec3 n)
{
    float occlusion = 0.0;
    float weight = 1.0;

    for (int i = 1; i <= 5; ++i)
    {
        float h = 0.1 * float(i);
        float d = map(p + n * h).x;
        occlusion += weight * (h - d);
        weight *= 0.65;
    }

    return clamp(1.0 - 2.5 * occlusion, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Shading
// ---------------------------------------------------------------------------

// Cosine palette tuned toward gold, copper and deep teal.
vec3 palette(float t)
{
    return vec3(0.5)
        + vec3(0.5) * cos(6.28318 * (vec3(0.9, 1.0, 1.1) * t
        + vec3(0.05, 0.30, 0.55)));
}

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

vec3 shade(vec3 ro, vec3 rd, float t, float trap)
{
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p, t);

    vec3 albedo = palette(clamp(trap * 0.35, 0.0, 1.0));

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
    color += albedo * vec3(0.10, 0.14, 0.25) * ao * 2.0;  // cool ambient
    color += albedo * vec3(0.25, 0.10, 0.05) * bounce * ao; // warm bounce

    // Height-tinted fog: lower areas fill with warm haze, giving the
    // structure a sense of enormous depth. Kept thin because the whole
    // structure sits ~100 units from the spawn point.
    float fog = 1.0 - exp(-0.004 * t);
    vec3 fogColor = mix(
        vec3(0.30, 0.15, 0.10),
        vec3(0.05, 0.07, 0.15),
        clamp(rd.y * 0.5 + 0.5, 0.0, 1.0)
    );
    color = mix(color, fogColor, fog);

    return color;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

void main()
{
    vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

    vec3 ro = uCamPos;
    vec3 rd = normalize(uCamRot * vec3(uv, FOCAL_LENGTH));

    vec2 hit = rayMarch(ro, rd);
    float trap = gOrbitTrap;

    vec3 color;
    if (hit.y < 0.0)
    {
        color = skyColor(rd);

        // Rays that grazed the structure pick up a warm glow, so the
        // fractal appears to radiate light against the dark sky.
        float glow = exp(-0.20 * gClosest);
        color += vec3(1.0, 0.5, 0.2) * glow * 0.6;
    }
    else
    {
        color = shade(ro, rd, hit.x, trap);
    }

    // Slight exposure lift, then gamma.
    color = 1.0 - exp(-1.2 * color);
    color = pow(color, vec3(1.0 / 2.2));

    FragColor = vec4(color, 1.0);
}
