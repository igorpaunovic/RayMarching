#version 330 core

// Traditional rasterization fragment shader for the mesh solar
// system. The procedural surface coloring is copied from the
// raymarched fractal_galaxy world so the two renderers draw (almost)
// the same picture; the differences are exactly the things meshes
// don't give you for free: no displaced relief, no marched soft
// shadows, no SDF ambient occlusion.

in vec3 vWorld;
in vec3 vNormal;
in vec3 vLocal;

out vec4 FragColor;

// Body ids: 0..7 planets, 8 sun, 9 moon, 10 Saturn ring, 11 Uranus ring.
uniform int   uBodyId;
uniform float uTime;
uniform vec3  uCamPos;
uniform float uRingInner = 1.0;
uniform float uRingOuter = 2.0;

const vec3  SUN_POS    = vec3(0.0, 2.0, 90.0);
const float SUN_RADIUS = 10.0;

const vec3 MONS_DIR     = normalize(vec3(0.62, 0.35, 0.70));
const vec3 SPOT_DIR     = normalize(vec3(0.80, -0.25, 0.55));
const vec3 DARKSPOT_DIR = normalize(vec3(-0.55, 0.20, 0.81));

// --- Same noise stack as the raymarched world. ---

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

float fbm3(vec3 p)
{
    float v = 0.0;
    float a = 0.5;

    for (int i = 0; i < 3; ++i)
    {
        v += a * valueNoise(p);
        p = p * 2.13 + vec3(11.3);
        a *= 0.5;
    }

    return v;
}

void main()
{
    vec3 rd = normalize(vWorld - uCamPos);
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing)
        n = -n; // rings are double-sided

    vec3 qn = normalize(vLocal);
    float lat = qn.y;

    vec3 color;

    if (uBodyId == 8) // the sun: pure emission
    {
        float gran = fbm(qn * 4.0 + uTime * 0.10);
        float limb = pow(clamp(dot(n, -rd), 0.0, 1.0), 0.6);
        vec3 c = mix(vec3(1.0, 0.30, 0.02), vec3(1.0, 0.85, 0.35), gran);
        color = c * (1.6 + 2.4 * limb);
    }
    else
    {
        vec3 toSun = SUN_POS - vWorld;
        float dSun = length(toSun);
        vec3 L = toSun / dSun;
        float night = smoothstep(0.02, -0.06, dot(n, L));

        vec3 albedo = vec3(0.5);
        vec3 emissive = vec3(0.0);
        float specStrength = 0.1;

        if (uBodyId == 10 || uBodyId == 11) // rings
        {
            float rr = length(vLocal.xz);
            float ringU = clamp(
                (rr - uRingInner) / (uRingOuter - uRingInner), 0.0, 1.0);
            float bands = 0.55 + 0.45 * sin(ringU * 34.0);
            float gap = smoothstep(0.56, 0.62, ringU)
                      * (1.0 - smoothstep(0.66, 0.72, ringU));
            vec3 tint = (uBodyId == 11)
                ? vec3(0.55, 0.75, 0.85)
                : vec3(0.80, 0.70, 0.52);
            albedo = mix(tint, tint * 0.45, bands);
            albedo *= 1.0 - 0.75 * gap;
            specStrength = 0.2;
        }
        else if (uBodyId == 9) // moon
        {
            float crater = valueNoise(qn * 6.0 + 8.0);
            albedo = mix(vec3(0.30, 0.30, 0.32), vec3(0.55, 0.55, 0.58), crater);
            specStrength = 0.03;
        }
        else if (uBodyId == 0) // Mercury
        {
            float crater = fbm3(qn * 5.0 + 1.7);
            albedo = mix(vec3(0.38, 0.34, 0.30), vec3(0.55, 0.50, 0.44), crater);
            float spikeN = valueNoise(qn * 5.0 + 3.1);
            float spikes = pow(max(spikeN - 0.55, 0.0) * 2.2, 2.0);
            float belt = smoothstep(0.35, 0.10, abs(lat));
            float cactus = clamp(spikes * belt * 5.0, 0.0, 1.0);
            albedo = mix(albedo, vec3(0.14, 0.45, 0.18), cactus);
            specStrength = 0.05;
        }
        else if (uBodyId == 1) // Venus
        {
            float swirl = fbm(qn * 3.0 + vec3(uTime * 0.02, 0.0, 0.0) + 4.2);
            float bands = 0.5 + 0.5 * sin(lat * 9.0 + swirl * 5.0);
            albedo = mix(vec3(0.86, 0.72, 0.45), vec3(0.98, 0.90, 0.66), bands);
            float vein = abs(fbm(qn * 6.0 + 9.3) - 0.52);
            float lichen = smoothstep(0.035, 0.0, vein - 0.015);
            emissive += vec3(0.9, 0.55, 0.10) * lichen * 0.35;
            specStrength = 0.15;
        }
        else if (uBodyId == 2) // Earth
        {
            float cont = fbm3(qn * 3.0 + 7.2);
            float land = smoothstep(0.50, 0.53, cont);
            float ice = smoothstep(0.78, 0.86, abs(lat));
            float forest = fbm(qn * 9.0 + 3.3);
            vec3 landCol = mix(
                vec3(0.10, 0.34, 0.08),
                vec3(0.05, 0.22, 0.05),
                smoothstep(0.4, 0.7, forest)
            );
            landCol = mix(
                landCol,
                vec3(0.75, 0.66, 0.40),
                smoothstep(0.25, 0.05, abs(lat)) * smoothstep(0.55, 0.65, forest)
            );
            albedo = mix(vec3(0.03, 0.12, 0.35), landCol, land);
            albedo = mix(albedo, vec3(0.90, 0.93, 0.98), ice);
            specStrength = mix(0.9, 0.05, max(land, ice));
            float cl = fbm(qn * 4.0 + vec3(uTime * 0.015, 0.0, 0.0) + 5.5);
            float clouds = smoothstep(0.55, 0.70, cl);
            albedo = mix(albedo, vec3(0.95), clouds * 0.85);
            specStrength *= 1.0 - clouds;
            float cities = smoothstep(0.965, 0.995, valueNoise(qn * 60.0));
            emissive += vec3(1.0, 0.75, 0.35)
                      * cities * land * (1.0 - clouds) * night * 1.6;
        }
        else if (uBodyId == 3) // Mars
        {
            float m1 = fbm3(qn * 4.0 + 2.9);
            albedo = mix(vec3(0.55, 0.22, 0.10), vec3(0.78, 0.42, 0.22), m1);
            float caps = smoothstep(0.82, 0.90, abs(lat));
            albedo = mix(albedo, vec3(0.92, 0.90, 0.88), caps);
            float mons = smoothstep(0.86, 1.0, dot(qn, MONS_DIR));
            albedo = mix(albedo, vec3(0.45, 0.25, 0.16), mons * 0.7);
            float moss = smoothstep(0.60, 0.72, fbm(qn * 6.0 + 6.1))
                       * smoothstep(0.55, 0.20, abs(lat));
            albedo = mix(albedo, vec3(0.10, 0.40, 0.35), moss * 0.8);
            specStrength = 0.05;
        }
        else if (uBodyId == 4) // Jupiter
        {
            float turb = fbm(qn * vec3(2.0, 7.0, 2.0) + 8.8);
            float bands = sin(lat * 14.0 + turb * 6.0);
            albedo = mix(vec3(0.72, 0.55, 0.38), vec3(0.90, 0.82, 0.68),
                         0.5 + 0.5 * bands);
            float spot = smoothstep(0.962, 0.985, dot(qn, SPOT_DIR));
            albedo = mix(albedo, vec3(0.72, 0.18, 0.10), spot);
            float band = smoothstep(0.10, 0.02, abs(lat + 0.42) - 0.06);
            float wisp = smoothstep(0.50, 0.75,
                fbm(qn * 6.0 + vec3(0.0, 0.0, uTime * 0.01) + 12.0));
            albedo = mix(albedo, vec3(0.10, 0.55, 0.30), band * wisp * 0.8);
            emissive += vec3(0.05, 0.35, 0.15) * band * wisp * 0.4;
            specStrength = 0.2;
        }
        else if (uBodyId == 5) // Saturn
        {
            float turb = fbm(qn * 3.0 + 3.3);
            float bands = 0.5 + 0.5 * sin(lat * 11.0 + turb * 4.0);
            albedo = mix(vec3(0.78, 0.66, 0.45), vec3(0.92, 0.85, 0.64), bands);
            float ang = atan(qn.z, qn.x);
            float hexEdge = 0.86 + 0.03 * cos(ang * 6.0);
            float hex = smoothstep(hexEdge, hexEdge + 0.02, lat);
            albedo = mix(albedo, vec3(0.35, 0.45, 0.55), hex);
            specStrength = 0.2;
        }
        else if (uBodyId == 6) // Uranus
        {
            float k = fbm(qn * vec3(2.0, 8.0, 2.0) + 5.9);
            albedo = mix(vec3(0.35, 0.72, 0.78), vec3(0.55, 0.85, 0.88),
                         0.5 + 0.5 * sin(lat * 6.0 + k * 3.0));
            float kelp = smoothstep(0.62, 0.78,
                valueNoise(qn * vec3(3.0, 12.0, 3.0) + vec3(uTime * 0.03)));
            albedo = mix(albedo, vec3(0.55, 0.95, 0.75), kelp * 0.5);
            emissive += vec3(0.20, 0.60, 0.45) * kelp * 0.15;
            specStrength = 0.3;
        }
        else // Neptune
        {
            float w = fbm(qn * 3.5 + vec3(uTime * 0.06, 0.0, 0.0) + 7.7);
            albedo = mix(vec3(0.05, 0.15, 0.55), vec3(0.16, 0.35, 0.80),
                         0.5 + 0.5 * sin(lat * 8.0 + w * 7.0));
            float streak = smoothstep(0.68, 0.80, w)
                         * smoothstep(0.45, 0.10, abs(lat + 0.15));
            albedo = mix(albedo, vec3(0.92, 0.96, 1.0), streak * 0.8);
            float dark = smoothstep(0.965, 0.99, dot(qn, DARKSPOT_DIR));
            albedo = mix(albedo, vec3(0.02, 0.06, 0.25), dark);
            float plank = smoothstep(0.94, 0.99, valueNoise(qn * 30.0 + 2.2));
            emissive += vec3(0.15, 0.80, 0.90) * plank * night * 1.2;
            specStrength = 0.35;
        }

        vec3 sunColor = vec3(1.0, 0.88, 0.70);
        float atten = clamp(45.0 / dSun, 0.55, 1.6);

        float diffuse = max(dot(n, L), 0.0);
        vec3 halfway = normalize(L - rd);
        float specular = pow(max(dot(n, halfway), 0.0), 64.0) * specStrength;

        color = vec3(0.0);
        color += albedo * sunColor * diffuse * atten * 1.6;
        color += sunColor * specular * atten;
        color += albedo * vec3(0.10, 0.08, 0.16) * 1.6;
        color += emissive;
    }

    // Same tone mapping as the raymarcher (EXPOSURE 1.35 + gamma).
    color = 1.0 - exp(-1.35 * color);
    color = pow(color, vec3(1.0 / 2.2));

    FragColor = vec4(color, 1.0);
}
