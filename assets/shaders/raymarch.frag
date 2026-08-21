#version 330 core

// Primitives world: sphere, box and torus on a checkerboard ground.
// Shared marching/lighting machinery comes from worldlib.glsl; the
// library defaults suit this scene, so nothing is overridden.

#include "worldlib.glsl"

// Material IDs
const float MAT_GROUND = 0.0;
const float MAT_SPHERE = 1.0;
const float MAT_BOX    = 2.0;
const float MAT_TORUS  = 3.0;

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

vec3 missColor(vec3 rd)
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
    vec3 n = calcNormal(p, t);
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

    return applyFog(color, missColor(rd), t);
}
