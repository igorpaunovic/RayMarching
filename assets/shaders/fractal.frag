#version 330 core

out vec4 FragColor;

uniform vec2  uResolution; // framebuffer size in pixels
uniform float uTime;       // seconds since startup
uniform vec3  uCamPos;     // camera position, world space
uniform mat3  uCamRot;     // camera basis: columns = (right, up, forward)

// ---------------------------------------------------------------------------
// Ray marching parameters
// ---------------------------------------------------------------------------

const int   MAX_STEPS    = 160;
const float MAX_DISTANCE = 60.0;
const float HIT_EPSILON  = 0.0008;
const float FOCAL_LENGTH = 1.5; // ~67 degrees vertical FOV

// Fractal parameters
const float POWER      = 8.0;  // classic power-8 Mandelbulb
const int   ITERATIONS = 12;
const float BAILOUT    = 2.0;

// Material IDs
const float MAT_NONE    = -1.0;
const float MAT_GROUND  =  0.0;
const float MAT_FRACTAL =  1.0;

// Written by the distance estimator during map(); the smallest |z|
// reached across iterations (orbit trap), used for coloring.
float gOrbitTrap = 0.0;

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

// Returns vec2(signed distance, material ID) of the nearest surface.
vec2 opUnion(vec2 a, vec2 b)
{
    return (a.x < b.x) ? a : b;
}

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
// Sphere tracing
// ---------------------------------------------------------------------------

// Returns vec2(hit distance along ray, material ID); material MAT_NONE
// on a miss. Steps are slightly damped because the fractal DE is only
// a lower bound and overshoots near the surface otherwise.
vec2 rayMarch(vec3 ro, vec3 rd)
{
    float t = 0.0;

    for (int i = 0; i < MAX_STEPS; ++i)
    {
        vec2 hit = map(ro + rd * t);

        if (hit.x < HIT_EPSILON * max(t, 1.0))
            return vec2(t, hit.y);

        t += hit.x * 0.9;

        if (t > MAX_DISTANCE)
            break;
    }

    return vec2(MAX_DISTANCE, MAT_NONE);
}

// Surface normal = normalized gradient of the SDF (central differences).
vec3 calcNormal(vec3 p)
{
    const vec2 e = vec2(0.0005, 0.0);
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

    for (int i = 0; i < 48; ++i)
    {
        float d = map(ro + rd * t).x;

        if (d < HIT_EPSILON)
            return 0.0;

        result = min(result, k * d / t);
        t += clamp(d, 0.01, 0.4);

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
        float h = 0.02 * float(i);
        float d = map(p + n * h).x;
        occlusion += weight * (h - d);
        weight *= 0.6;
    }

    return clamp(1.0 - 12.0 * occlusion, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Shading
// ---------------------------------------------------------------------------

// Cosine palette (Inigo Quilez); t is driven by the orbit trap so the
// fractal's internal structure shows up as color bands.
vec3 palette(float t)
{
    return vec3(0.5)
        + vec3(0.5) * cos(6.28318 * (vec3(1.0, 1.0, 1.0) * t
        + vec3(0.0, 0.10, 0.20)));
}

vec3 skyColor(vec3 rd)
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
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);

    // map() was just evaluated by calcNormal; re-evaluate at p so the
    // orbit trap belongs to this exact point.
    map(p);
    float trap = gOrbitTrap;

    vec3 albedo;
    if (mat == MAT_GROUND)
    {
        // Dim checkerboard so the floor reads without stealing focus.
        float checker = mod(floor(p.x) + floor(p.z), 2.0);
        albedo = mix(vec3(0.05), vec3(0.09), checker);
    }
    else
    {
        albedo = palette(clamp(trap * 0.7, 0.0, 1.0));
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

    // Distance fog toward the sky color.
    float fog = 1.0 - exp(-0.05 * t);
    color = mix(color, skyColor(rd), fog);

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

    vec3 color;
    if (hit.y < 0.0)
        color = skyColor(rd);
    else
        color = shade(ro, rd, hit.x, hit.y);

    // Simple gamma correction.
    color = pow(color, vec3(1.0 / 2.2));

    FragColor = vec4(color, 1.0);
}
