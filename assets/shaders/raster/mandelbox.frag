#version 330 core

// Traditional rasterization fragment shader for the meshed Mandelbox,
// the rasterized counterpart of large_fractal.frag. The geometry is a
// CPU-baked isosurface of the fractal's distance estimator, but all
// the secondary effects of the raymarched world are reproduced here
// by marching that same DE per fragment: soft sun shadows, SDF
// ambient occlusion, the orbit-trap palette, haze and tone mapping -
// a hybrid renderer. Only primary visibility comes from triangles,
// which is also why fine detail is capped by the bake resolution.

in vec3 vWorld;
in vec3 vNormal;
in vec3 vLocal;

out vec4 FragColor;

uniform vec3  uCamPos;
uniform vec3  uModelPos;
uniform float uScale;

// World-space DE value the baked surface sits at (half a bake cell):
// subtracting it re-roots the field on the mesh surface so shadow and
// AO rays start at "distance zero" exactly like in the raymarcher.
uniform float uIsoOffset;

// Menu-controlled effect toggles, same semantics as worldlib.glsl.
uniform bool uEnableShadows  = true;
uniform bool uEnableAO       = true;
uniform bool uEnableSpecular = true;
uniform bool uEnableFog      = true;

// Fractal parameters, identical to large_fractal.frag.
const float BOX_SCALE      = -1.77;
const int   ITERATIONS     = 13;
const float MIN_RADIUS_2   = 0.25;
const float FIXED_RADIUS_2 = 1.0;

// Effect tunables, identical to large_fractal.frag.
const float HIT_EPSILON     = 0.0006;
const int   SHADOW_STEPS    = 40;
const float SHADOW_STEP_MIN = 0.02;
const float SHADOW_STEP_MAX = 2.0;
const float AO_STEP         = 0.1;
const float AO_STRENGTH     = 2.5;
const float AO_FALLOFF      = 0.65;
const float FOG_DENSITY     = 0.004;
const float EXPOSURE        = 1.2;

const vec3 SUN_DIR = normalize(vec3(0.55, 0.35, -0.75));

// Cosine palette (Inigo Quilez), same as worldlib.glsl.
vec3 cosinePalette(float t, vec3 freq, vec3 phase)
{
    return vec3(0.5) + vec3(0.5) * cos(6.28318 * (freq * t + phase));
}

// The Mandelbox DE from large_fractal.frag, orbit trap included.
float gOrbitTrap = 0.0;

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

// World-space distance to the baked surface, like map() in the
// raymarched world but re-rooted on the mesh isosurface.
float mapWorld(vec3 p)
{
    return mandelboxDE((p - uModelPos) / uScale) * uScale - uIsoOffset;
}

// Soft shadow, copied from worldlib.glsl with large_fractal's
// constants, marching the DE instead of sampling a shadow map.
float softShadow(vec3 ro, vec3 rd, float tMin, float tMax, float k)
{
    if (!uEnableShadows)
        return 1.0;

    float result = 1.0;
    float t = tMin;

    for (int i = 0; i < SHADOW_STEPS; ++i)
    {
        float d = mapWorld(ro + rd * t);

        if (d < HIT_EPSILON)
            return 0.0;

        result = min(result, k * d / t);
        t += clamp(d, SHADOW_STEP_MIN, SHADOW_STEP_MAX);

        if (t > tMax)
            break;
    }

    return clamp(result, 0.0, 1.0);
}

// Ambient occlusion from DE samples along the normal, same formula
// and constants as the raymarched world, now evaluated per pixel.
float ambientOcclusion(vec3 p, vec3 n)
{
    if (!uEnableAO)
        return 1.0;

    float occlusion = 0.0;
    float weight = 1.0;

    for (int i = 1; i <= 5; ++i)
    {
        float h = AO_STEP * float(i);
        float d = mapWorld(p + n * h);
        occlusion += weight * (h - d);
        weight *= AO_FALLOFF;
    }

    return clamp(1.0 - AO_STRENGTH * occlusion, 0.0, 1.0);
}

void main()
{
    vec3 rd = normalize(vWorld - uCamPos);
    vec3 n = normalize(vNormal);
    vec3 p = vWorld;

    // Orbit trap at the surface point, for the same gold, copper and
    // deep teal palette as the raymarched shade().
    mandelboxDE(vLocal);
    float trap = gOrbitTrap;

    vec3 albedo = cosinePalette(
        clamp(trap * 0.35, 0.0, 1.0),
        vec3(0.9, 1.0, 1.1),
        vec3(0.05, 0.30, 0.55)
    );

    vec3 sunColor = vec3(1.0, 0.82, 0.6);

    float diffuse = max(dot(n, SUN_DIR), 0.0);
    vec3 halfway = normalize(SUN_DIR - rd);
    float specular = uEnableSpecular
        ? pow(max(dot(n, halfway), 0.0), 64.0)
        : 0.0;

    float shadow = softShadow(p + n * 0.05, SUN_DIR, 0.1, 60.0, 16.0);
    float ao = ambientOcclusion(p, n);

    // Fake bounce light from below, like the raymarched world.
    float bounce = max(dot(n, vec3(0.0, -1.0, 0.0)), 0.0);

    vec3 color = vec3(0.0);
    color += albedo * sunColor * diffuse * shadow * 1.4;
    color += sunColor * specular * shadow * 0.8;
    color += albedo * vec3(0.10, 0.14, 0.25) * ao * 2.0;    // cool ambient
    color += albedo * vec3(0.25, 0.10, 0.05) * bounce * ao; // warm bounce

    // Height-tinted haze, same as the raymarched applyFog call.
    if (uEnableFog)
    {
        vec3 haze = mix(
            vec3(0.30, 0.15, 0.10),
            vec3(0.05, 0.07, 0.15),
            clamp(rd.y * 0.5 + 0.5, 0.0, 1.0)
        );
        float fog =
            1.0 - exp(-FOG_DENSITY * length(vWorld - uCamPos));
        color = mix(color, haze, fog);
    }

    // Same tone mapping as the raymarcher (EXPOSURE + gamma).
    color = 1.0 - exp(-EXPOSURE * color);
    color = pow(color, vec3(1.0 / 2.2));

    FragColor = vec4(color, 1.0);
}
