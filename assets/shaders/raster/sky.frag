#version 330 core

// Background pass for the rasterized solar system: the same nebula,
// starfield and tone mapping as the raymarched world, drawn on a
// fullscreen quad with depth writes off before the meshes render.

out vec4 FragColor;

uniform vec2  uResolution;
uniform float uTime;
uniform mat3  uCamRot;

float hash13(vec3 p)
{
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}

float valueNoise(vec3 p)
{
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);

    float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

    return mix(
        mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
        mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
        u.z
    );
}

float fbm(vec3 p)
{
    float v = 0.0;
    float a = 0.5;

    for (int i = 0; i < 4; ++i)
    {
        v += a * valueNoise(p);
        p = p * 2.13 + vec3(11.3);
        a *= 0.5;
    }

    return v;
}

void main()
{
    vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
    vec3 rd = normalize(uCamRot * vec3(uv, 1.5));

    vec3 col = mix(
        vec3(0.010, 0.008, 0.025),
        vec3(0.001, 0.001, 0.006),
        clamp(rd.y * 0.5 + 0.5, 0.0, 1.0)
    );

    float n = fbm(rd * 2.6 + vec3(4.7, 0.0, 1.3));
    float m = fbm(rd * 5.2 + vec3(0.0, 8.1, 3.3));
    vec3 nebula = mix(
        vec3(0.45, 0.10, 0.55),
        vec3(0.05, 0.35, 0.55),
        m
    );
    col += nebula * pow(max(n - 0.25, 0.0), 2.0) * 1.4;

    vec3 g = rd * 110.0;
    float h = hash13(floor(g));
    if (h > 0.994)
    {
        float d = length(fract(g) - 0.5);
        float twinkle = 0.6 + 0.4 * sin(uTime * 2.0 + h * 90.0);
        col += vec3(0.9, 0.95, 1.0)
             * smoothstep(0.35, 0.0, d) * twinkle * 1.6;
    }

    col = 1.0 - exp(-1.35 * col);
    col = pow(col, vec3(1.0 / 2.2));

    FragColor = vec4(col, 1.0);
}
