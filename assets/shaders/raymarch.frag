#version 330 core

out vec4 FragColor;

uniform vec2  uResolution; // framebuffer size in pixels
uniform float uTime;       // seconds since startup
uniform vec3  uCamPos;     // camera position, world space
uniform mat3  uCamRot;     // camera basis: columns = (right, up, forward)

// ---------------------------------------------------------------------------
// Ray marching parameters
// ---------------------------------------------------------------------------

const int   MAX_STEPS    = 128;
const float MAX_DISTANCE = 100.0;
const float HIT_EPSILON  = 0.001;
const float FOCAL_LENGTH = 1.5; // ~67 degrees vertical FOV

// Material IDs
const float MAT_NONE   = -1.0;
const float MAT_GROUND =  0.0;
const float MAT_SPHERE =  1.0;
const float MAT_BOX    =  2.0;
const float MAT_TORUS  =  3.0;

// ---------------------------------------------------------------------------
// SDF primitives (exact distances, after Inigo Quilez's catalog)
// ---------------------------------------------------------------------------

float sdSphere(vec3 p, float r)
{
    return length(p) - r;
}

float sdBox(vec3 p, vec3 b)
{
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdTorus(vec3 p, vec2 t)
{
    vec2 q = vec2(length(p.xz) - t.x, p.y);
    return length(q) - t.y;
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
    vec2 scene = vec2(sdPlane(p, 0.0), MAT_GROUND);

    // Sphere, gently bobbing to show off animation via uTime.
    vec3 spherePos = vec3(0.0, 1.0 + 0.25 * sin(uTime), 0.0);
    scene = opUnion(scene, vec2(sdSphere(p - spherePos, 1.0), MAT_SPHERE));

    // Box.
    scene = opUnion(
        scene,
        vec2(sdBox(p - vec3(2.5, 0.5, 0.0), vec3(0.5)), MAT_BOX)
    );

    // Torus.
    scene = opUnion(
        scene,
        vec2(sdTorus(p - vec3(-2.5, 0.4, 0.0), vec2(0.8, 0.25)), MAT_TORUS)
    );

    return scene;
}

// ---------------------------------------------------------------------------
// Sphere tracing
// ---------------------------------------------------------------------------

// Returns vec2(hit distance along ray, material ID); material MAT_NONE
// on a miss.
vec2 rayMarch(vec3 ro, vec3 rd)
{
    float t = 0.0;

    for (int i = 0; i < MAX_STEPS; ++i)
    {
        vec2 hit = map(ro + rd * t);

        if (hit.x < HIT_EPSILON)
            return vec2(t, hit.y);

        t += hit.x;

        if (t > MAX_DISTANCE)
            break;
    }

    return vec2(MAX_DISTANCE, MAT_NONE);
}

// Surface normal = normalized gradient of the SDF (central differences).
vec3 calcNormal(vec3 p)
{
    const vec2 e = vec2(0.001, 0.0);
    return normalize(vec3(
        map(p + e.xyy).x - map(p - e.xyy).x,
        map(p + e.yxy).x - map(p - e.yxy).x,
        map(p + e.yyx).x - map(p - e.yyx).x
    ));
}

// ---------------------------------------------------------------------------
// "Free" SDF effects: soft shadows and ambient occlusion
// ---------------------------------------------------------------------------

// Soft shadow by marching toward the light and tracking how close the
// ray came to any occluder relative to the distance traveled (penumbra
// cone approximation). k controls penumbra sharpness.
float softShadow(vec3 ro, vec3 rd, float tMin, float tMax, float k)
{
    float result = 1.0;
    float t = tMin;

    for (int i = 0; i < 64; ++i)
    {
        float d = map(ro + rd * t).x;

        if (d < HIT_EPSILON)
            return 0.0;

        result = min(result, k * d / t);
        t += clamp(d, 0.01, 0.5);

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
        float h = 0.06 * float(i);
        float d = map(p + n * h).x;
        occlusion += weight * (h - d);
        weight *= 0.6;
    }

    return clamp(1.0 - 2.0 * occlusion, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Shading
// ---------------------------------------------------------------------------

vec3 materialAlbedo(float mat, vec3 p)
{
    if (mat == MAT_GROUND)
    {
        // Checkerboard to make camera motion readable.
        float checker = mod(floor(p.x) + floor(p.z), 2.0);
        return mix(vec3(0.25), vec3(0.75), checker);
    }
    if (mat == MAT_SPHERE) return vec3(0.9, 0.3, 0.2);
    if (mat == MAT_BOX)    return vec3(0.2, 0.5, 0.9);
    if (mat == MAT_TORUS)  return vec3(0.9, 0.75, 0.2);
    return vec3(0.0);
}

vec3 skyColor(vec3 rd)
{
    return mix(
        vec3(0.55, 0.7, 0.9),
        vec3(0.25, 0.45, 0.85),
        clamp(rd.y, 0.0, 1.0)
    );
}

vec3 shade(vec3 ro, vec3 rd, float t, float mat)
{
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);
    vec3 albedo = materialAlbedo(mat, p);

    vec3 lightDir = normalize(vec3(0.8, 0.7, -0.5));
    vec3 lightColor = vec3(1.0, 0.97, 0.9);

    // Blinn-Phong terms.
    float diffuse = max(dot(n, lightDir), 0.0);
    vec3 halfway = normalize(lightDir - rd);
    float specular = pow(max(dot(n, halfway), 0.0), 32.0);

    // SDF-native effects.
    float shadow = softShadow(p + n * 0.02, lightDir, 0.02, 20.0, 8.0);
    float ao = ambientOcclusion(p, n);

    vec3 color = vec3(0.0);
    color += albedo * lightColor * diffuse * shadow;          // diffuse
    color += lightColor * specular * shadow * 0.5;            // specular
    color += albedo * vec3(0.12, 0.15, 0.2) * ao;             // ambient/sky

    // Distance fog toward the sky color.
    float fog = 1.0 - exp(-0.02 * t);
    color = mix(color, skyColor(rd), fog);

    return color;
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

    vec3 color;
    if (hit.y < 0.0)
        color = skyColor(rd);
    else
        color = shade(ro, rd, hit.x, hit.y);

    // Simple gamma correction.
    color = pow(color, vec3(1.0 / 2.2));

    FragColor = vec4(color, 1.0);
}
