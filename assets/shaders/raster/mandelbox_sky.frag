#version 330 core

// Background pass for the rasterized Mandelbox: the same deep-space
// gradient, low sun and warm structure glow as the raymarched world
// (large_fractal.frag). The glow needs the ray's closest approach to
// the fractal, which triangles cannot provide, so this pass marches
// the distance estimator per pixel - cheaper than the full raymarcher
// (fewer steps, no shading) and overdrawn by the mesh wherever the
// structure is actually hit.

out vec4 FragColor;

uniform vec2 uResolution;
uniform mat3 uCamRot;
uniform vec3 uCamPos;

// Fractal parameters and placement, identical to large_fractal.frag.
const float BOX_SCALE      = -1.77;
const int   ITERATIONS     = 13;
const float MIN_RADIUS_2   = 0.25;
const float FIXED_RADIUS_2 = 1.0;
const float WORLD_SCALE    = 12.0;
const vec3  BOX_POS        = vec3(0.0, 0.0, 45.0);

const int   GLOW_STEPS   = 80;
const float MAX_DISTANCE = 260.0;
const float HIT_EPSILON  = 0.0006;

const vec3 SUN_DIR = normalize(vec3(0.55, 0.35, -0.75));

float mandelboxDE(vec3 p)
{
    vec3 z = p;
    float dr = 1.0;

    for (int i = 0; i < ITERATIONS; ++i)
    {
        z = clamp(z, -1.0, 1.0) * 2.0 - z;

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
    }

    return length(z) / abs(dr);
}

float mapWorld(vec3 p)
{
    return mandelboxDE((p - BOX_POS) / WORLD_SCALE) * WORLD_SCALE;
}

void main()
{
    vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    vec3 rd = normalize(uCamRot * vec3(uv, 1.5));

    vec3 sky = mix(
        vec3(0.03, 0.04, 0.10),
        vec3(0.01, 0.01, 0.03),
        clamp(rd.y * 0.5 + 0.5, 0.0, 1.0)
    );

    float sun = clamp(dot(rd, SUN_DIR), 0.0, 1.0);
    sky += vec3(1.0, 0.75, 0.45) * pow(sun, 256.0) * 4.0; // disk
    sky += vec3(1.0, 0.55, 0.25) * pow(sun, 8.0) * 0.25;  // halo

    // Closest approach to the structure along this ray (gClosest in
    // worldlib terms), for the same warm glow as the raymarched sky.
    float closest = 1e9;
    float t = 0.0;

    for (int i = 0; i < GLOW_STEPS; ++i)
    {
        float d = mapWorld(uCamPos + rd * t);
        closest = min(closest, d);

        if (d < HIT_EPSILON * max(t, 1.0))
        {
            closest = 0.0;
            break;
        }

        t += d;

        if (t > MAX_DISTANCE)
            break;
    }

    sky += vec3(1.0, 0.5, 0.2) * exp(-0.20 * closest) * 0.6;

    // Same tone mapping as the mesh pass (EXPOSURE 1.2 + gamma).
    sky = 1.0 - exp(-1.2 * sky);
    sky = pow(sky, vec3(1.0 / 2.2));

    FragColor = vec4(sky, 1.0);
}
