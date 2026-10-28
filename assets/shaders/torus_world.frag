#version 330 core

// Torus world: a single torus repeated endlessly in all three axes,
// seen through curved (non-Euclidean) space. Two distortions are at
// work:
//  - domain warping: the SDF is evaluated in space displaced by moving
//    sine waves, so all geometry breathes and shifts over time;
//  - bent rays: the march does not travel in straight lines; the ray
//    direction is deflected through a sinusoidal field at every step,
//    so light itself follows curved paths (standalone shader - the
//    worldlib march assumes straight rays and cannot do this).
// The rasterized counterpart lives in assets/shaders/raster/torus.*.

out vec4 FragColor;

uniform vec2  uResolution; // framebuffer size in pixels
uniform float uTime;       // seconds since startup
uniform vec3  uCamPos;     // camera position, world space
uniform mat3  uCamRot;     // camera basis: columns = (right, up, forward)

// Menu-controlled effects.
uniform float uCurveScale     = 1.0; // 0 = straight (Euclidean) rays
uniform bool  uEnableShadows  = true;
uniform bool  uEnableAO       = true;
uniform bool  uEnableSpecular = true;
uniform bool  uEnableFog      = true;

const float FOCAL_LENGTH = 1.5; // ~67 degrees vertical FOV
const int   MAX_STEPS    = 360;
const float MAX_DISTANCE = 220.0;
const float HIT_EPSILON  = 0.002;

const int   SHADOW_STEPS    = 32;
const float MAX_SHADOW      = 40.0;

// Curvature of space: how strongly ray directions are deflected per
// unit of travel. Steps are capped so the bending integrates smoothly
// instead of being skipped across large empty stretches.
const float CURVE_STRENGTH = 0.05;
const float MAX_STEP_LEN   = 0.7;

// Lattice spacing of the repeated object.
const float REPEAT = 9.0;

// Cell coordinate of the last map() evaluation, for per-cell coloring.
vec3 gCell = vec3(0.0);

// Closest approach along the ray, for glow on misses.
float gClosest = 1e9;

// ---------------------------------------------------------------------------
// Scene: one torus, repeated forever, in breathing warped space
// ---------------------------------------------------------------------------

float map(vec3 p)
{
    // Domain warp: displace space with slow traveling sine waves. This
    // is what makes the geometry itself shift constantly.
    p += 0.6 * sin(p.zxy * 0.30 + uTime * 0.35);

    // Infinite repetition: fold all of space into one cell.
    gCell = floor((p + 0.5 * REPEAT) / REPEAT);
    vec3 q = mod(p + 0.5 * REPEAT, REPEAT) - 0.5 * REPEAT;

    // The one object: a torus lying flat in its cell.
    vec2 tq = vec2(length(q.xz) - 2.0, q.y);
    float d = length(tq) - 0.6;

    // The warp stretches distances (its gradient exceeds 1), so scale
    // the estimate down to stay a safe lower bound for marching.
    return d * 0.7;
}

// ---------------------------------------------------------------------------
// Curved-space marching
// ---------------------------------------------------------------------------

// Direction the ray is nudged toward at a given point: a slowly
// drifting sinusoidal vector field.
vec3 bendField(vec3 p)
{
    return vec3(
        sin(p.y * 0.15 + uTime * 0.20),
        sin(p.z * 0.13 - uTime * 0.15),
        sin(p.x * 0.17 + uTime * 0.10)
    );
}

// Marches a curved ray. Returns the traveled distance (MAX_DISTANCE on
// a miss) and writes the final position and direction, which shading
// needs because they no longer follow from ro + rd * t.
float rayMarch(vec3 ro, vec3 rd, out vec3 pos, out vec3 dir)
{
    pos = ro;
    dir = rd;
    float t = 0.0;
    gClosest = 1e9;

    for (int i = 0; i < MAX_STEPS; ++i)
    {
        float d = map(pos);

        gClosest = min(gClosest, d);

        if (d < HIT_EPSILON)
            return t;

        // Capped step so direction changes integrate smoothly.
        float stepLen = min(d, MAX_STEP_LEN);
        pos += dir * stepLen;
        t += stepLen;

        // Curve the ray through the sinusoidal field.
        dir = normalize(
            dir + bendField(pos) * (CURVE_STRENGTH * uCurveScale) * stepLen
        );

        if (t > MAX_DISTANCE)
            break;
    }

    return MAX_DISTANCE;
}

// Surface normal = normalized gradient of the (warped) SDF.
vec3 calcNormal(vec3 p)
{
    const vec2 e = vec2(0.002, 0.0);
    return normalize(vec3(
        map(p + e.xyy) - map(p - e.xyy),
        map(p + e.yxy) - map(p - e.yxy),
        map(p + e.yyx) - map(p - e.yyx)
    ));
}

float ambientOcclusion(vec3 p, vec3 n)
{
    if (!uEnableAO)
        return 1.0;

    float occlusion = 0.0;
    float weight = 1.0;

    for (int i = 1; i <= 5; ++i)
    {
        float h = 0.08 * float(i);
        float d = map(p + n * h);
        occlusion += weight * (h - d);
        weight *= 0.6;
    }

    return clamp(1.0 - 2.0 * occlusion, 0.0, 1.0);
}

float softShadow(vec3 ro, vec3 rd)
{
    if (!uEnableShadows)
        return 1.0;

    float result = 1.0;
    float t = 0.08;

    for (int i = 0; i < SHADOW_STEPS; ++i)
    {
        float d = map(ro + rd * t);
        if (d < HIT_EPSILON)
            return 0.0;

        result = min(result, 8.0 * d / t);
        t += clamp(d, 0.05, 1.5);

        if (t > MAX_SHADOW || result < 0.02)
            break;
    }

    return clamp(result, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Shading
// ---------------------------------------------------------------------------

float hashCell(vec3 c)
{
    return fract(sin(dot(c, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

// Cosine palette (Inigo Quilez).
vec3 palette(float t)
{
    return vec3(0.5)
        + vec3(0.5) * cos(6.28318 * (vec3(1.0, 0.7, 0.4) * t
        + vec3(0.00, 0.15, 0.20)));
}

vec3 skyColor(vec3 rd)
{
    // Dark violet void with faint direction-hashed stars.
    vec3 sky = mix(
        vec3(0.06, 0.03, 0.12),
        vec3(0.01, 0.01, 0.04),
        clamp(rd.y * 0.5 + 0.5, 0.0, 1.0)
    );

    float star = hashCell(floor(rd * 180.0));
    sky += vec3(0.8, 0.9, 1.0) * step(0.9985, star) * 0.8;

    return sky;
}

vec3 shade(vec3 p, vec3 rd, float t)
{
    vec3 n = calcNormal(p);

    // Each cell of the lattice gets its own hue: the same one object,
    // but the journey through curved space recolors it.
    vec3 albedo = palette(hashCell(gCell) + 0.05 * uTime);

    vec3 lightDir = normalize(vec3(0.5, 0.8, -0.3));
    float diffuse = max(dot(n, lightDir), 0.0);
    float shadow = softShadow(p + n * 0.02, lightDir);
    vec3 halfway = normalize(lightDir - rd);
    float specular = uEnableSpecular
        ? pow(max(dot(n, halfway), 0.0), 32.0)
        : 0.0;

    float ao = ambientOcclusion(p, n);

    // Rim light sells the curvature of the surfaces.
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);

    vec3 color = vec3(0.0);
    color += albedo * diffuse * shadow * vec3(1.0, 0.95, 0.9);
    color += vec3(1.0) * specular * shadow * 0.4;
    color += albedo * vec3(0.20, 0.15, 0.30) * ao;  // ambient
    color += albedo * rim * 0.6;

    // Fog into the void; far tori dissolve into darkness.
    if (!uEnableFog)
        return color;

    float fog = 1.0 - exp(-0.030 * t);
    return mix(color, skyColor(rd), fog);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

void main()
{
    vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

    vec3 ro = uCamPos;
    vec3 rd = normalize(uCamRot * vec3(uv, FOCAL_LENGTH));

    vec3 pos;
    vec3 dir;
    float t = rayMarch(ro, rd, pos, dir);

    vec3 color;
    if (t >= MAX_DISTANCE)
    {
        color = skyColor(dir);

        // Grazing rays glow with the void's violet.
        float glow = exp(-0.9 * gClosest);
        color += vec3(0.45, 0.25, 0.7) * glow * 0.5;
    }
    else
    {
        color = shade(pos, dir, t);
    }

    // Simple gamma correction.
    color = pow(color, vec3(1.0 / 2.2));

    FragColor = vec4(color, 1.0);
}
