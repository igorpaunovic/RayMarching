#version 330 core

// Traditional rasterization fragment shader for the torus world.
// Primary visibility comes from the mesh lattice; shading matches
// torus_world.frag (SDF normals, soft shadows, AO, per-cell palette,
// rim, fog). Curved rays remain absent - that is the rasterization
// limit.

in vec3 vWorld;

out vec4 FragColor;

uniform float uTime;
uniform vec3  uCamPos;

uniform bool uEnableShadows  = true;
uniform bool uEnableAO       = true;
uniform bool uEnableSpecular = true;
uniform bool uEnableFog      = true;

const float REPEAT          = 9.0;
const float HIT_EPSILON     = 0.002;
const int   SHADOW_STEPS    = 32;
const float MAX_SHADOW      = 40.0;

// Cell of the last map() call, same role as gCell in torus_world.frag.
vec3 gCell = vec3(0.0);

float hashCell(vec3 c)
{
    return fract(sin(dot(c, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

vec3 palette(float t)
{
    return vec3(0.5)
        + vec3(0.5) * cos(6.28318 * (vec3(1.0, 0.7, 0.4) * t
        + vec3(0.00, 0.15, 0.20)));
}

// Identical to map() in torus_world.frag.
float map(vec3 p)
{
    p += 0.6 * sin(p.zxy * 0.30 + uTime * 0.35);

    gCell = floor((p + 0.5 * REPEAT) / REPEAT);
    vec3 q = mod(p + 0.5 * REPEAT, REPEAT) - 0.5 * REPEAT;

    vec2 tq = vec2(length(q.xz) - 2.0, q.y);
    float d = length(tq) - 0.6;
    return d * 0.7;
}

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

// Identical to softShadow() in torus_world.frag.
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

vec3 skyColor(vec3 rd)
{
    vec3 sky = mix(
        vec3(0.06, 0.03, 0.12),
        vec3(0.01, 0.01, 0.04),
        clamp(rd.y * 0.5 + 0.5, 0.0, 1.0)
    );

    float star = hashCell(floor(rd * 180.0));
    sky += vec3(0.8, 0.9, 1.0) * step(0.9985, star) * 0.8;

    return sky;
}

// Identical to shade() in torus_world.frag.
vec3 shade(vec3 p, vec3 rd, float t)
{
    vec3 n = calcNormal(p);
    map(p);

    vec3 albedo = palette(hashCell(gCell) + 0.05 * uTime);

    vec3 lightDir = normalize(vec3(0.5, 0.8, -0.3));
    float diffuse = max(dot(n, lightDir), 0.0);
    float shadow = softShadow(p + n * 0.02, lightDir);
    vec3 halfway = normalize(lightDir - rd);
    float specular = uEnableSpecular
        ? pow(max(dot(n, halfway), 0.0), 32.0)
        : 0.0;

    float ao = ambientOcclusion(p, n);
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);

    vec3 color = vec3(0.0);
    color += albedo * diffuse * shadow * vec3(1.0, 0.95, 0.9);
    color += vec3(1.0) * specular * shadow * 0.4;
    color += albedo * vec3(0.20, 0.15, 0.30) * ao;
    color += albedo * rim * 0.6;

    if (!uEnableFog)
        return color;

    float fog = 1.0 - exp(-0.030 * t);
    return mix(color, skyColor(rd), fog);
}

void main()
{
    vec3 rd = normalize(vWorld - uCamPos);
    float t = length(vWorld - uCamPos);

    vec3 color = shade(vWorld, rd, t);
    color = pow(color, vec3(1.0 / 2.2));
    FragColor = vec4(color, 1.0);
}
