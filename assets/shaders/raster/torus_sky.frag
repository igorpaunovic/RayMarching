#version 330 core

// Background pass for the rasterized torus world: violet void, stars,
// and the same grazing-ray glow as torus_world.frag. Glow needs the
// closest SDF approach along the ray, so this pass marches the warped
// torus field (straight rays only - cheaper than the full raymarcher,
// no shading) and is overdrawn by the mesh wherever a torus is hit.

out vec4 FragColor;

uniform vec2  uResolution;
uniform float uTime;
uniform mat3  uCamRot;
uniform vec3  uCamPos;

const float REPEAT       = 9.0;
const int   GLOW_STEPS   = 360;
const float MAX_DISTANCE = 220.0;
const float HIT_EPSILON  = 0.002;
const float MAX_STEP_LEN = 0.7;

float hashCell(vec3 c)
{
    return fract(sin(dot(c, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

float map(vec3 p)
{
    p += 0.6 * sin(p.zxy * 0.30 + uTime * 0.35);
    vec3 q = mod(p + 0.5 * REPEAT, REPEAT) - 0.5 * REPEAT;
    vec2 tq = vec2(length(q.xz) - 2.0, q.y);
    float d = length(tq) - 0.6;
    return d * 0.7;
}

void main()
{
    vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    vec3 rd = normalize(uCamRot * vec3(uv, 1.5));

    vec3 sky = mix(
        vec3(0.06, 0.03, 0.12),
        vec3(0.01, 0.01, 0.04),
        clamp(rd.y * 0.5 + 0.5, 0.0, 1.0)
    );

    float star = hashCell(floor(rd * 180.0));
    sky += vec3(0.8, 0.9, 1.0) * step(0.9985, star) * 0.8;

    // Closest approach along a straight ray (gClosest in the
    // raymarched world). Caps steps like the curved marcher so empty
    // space does not skip past thin tubes.
    float closest = 1e9;
    float t = 0.0;
    vec3 pos = uCamPos;

    for (int i = 0; i < GLOW_STEPS; ++i)
    {
        float d = map(pos);
        closest = min(closest, d);

        if (d < HIT_EPSILON)
        {
            closest = 0.0;
            break;
        }

        float stepLen = min(d, MAX_STEP_LEN);
        pos += rd * stepLen;
        t += stepLen;

        if (t > MAX_DISTANCE)
            break;
    }

    sky += vec3(0.45, 0.25, 0.7) * exp(-0.9 * closest) * 0.5;

    sky = pow(sky, vec3(1.0 / 2.2));
    FragColor = vec4(sky, 1.0);
}
