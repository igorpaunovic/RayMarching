#version 330 core

// Miniature solar system floating in a nebula. A boiling orange sun
// sits at the center and acts as the scene's point light; eight
// planets modeled on the real ones (Mercury through Neptune) orbit it
// in the ecliptic plane with Kepler-style speeds - inner planets race,
// outer ones crawl. Sizes, tilts and spins echo the real system:
// Jupiter is the giant, Venus spins upside down, Uranus rolls on its
// side. Every planet has its own terrain, vegetation and a signature
// detail: Mercury wears a belt of giant cacti, Venus grows glowing
// sulfur lichen, Earth has continents, forests, clouds, night-side
// city lights and an orbiting Moon, Mars sports a shield volcano and
// teal lowland moss, Jupiter a Great Red Spot and an emerald sky-algae
// bloom, Saturn its rings plus a hexagonal polar storm, sideways
// Uranus a thin ring and drifting mint sky-kelp, and Neptune racing
// storm streaks with bioluminescent plankton glowing on its night side.

#define MAX_STEPS      200
#define MAX_DISTANCE   450.0
#define HIT_EPSILON    0.0007
#define STEP_SCALE     0.7
#define NORMAL_EPSILON 0.0007
#define FOG_DENSITY    0.0008
#define SHADOW_STEPS   32
#define SHADOW_STEP_MIN 0.03
#define SHADOW_STEP_MAX 2.5
#define AO_STEP        0.12
#define AO_STRENGTH    2.2
#define AO_FALLOFF     0.65
#define EXPOSURE       1.35

#include "worldlib.glsl"

// Material IDs
const float MAT_SUN    = 0.0;
const float MAT_PLANET = 1.0;
const float MAT_RING   = 2.0;
const float MAT_MOON   = 3.0;

// ---------------------------------------------------------------------------
// The system roster: 0 Mercury, 1 Venus, 2 Earth, 3 Mars, 4 Jupiter,
// 5 Saturn, 6 Uranus, 7 Neptune.
// ---------------------------------------------------------------------------

const int   NUM_PLANETS = 8;
const vec3  SUN_POS     = vec3(0.0, 2.0, 90.0);
const float SUN_RADIUS  = 10.0;

// Orbit radius around the sun.
const float P_ORBITR[8] = float[8](16.0, 22.0, 28.0, 34.0, 46.0, 58.0, 68.0, 77.0);

// Planet radius; relative sizes echo the real system.
const float P_SIZE[8] = float[8](1.3, 2.2, 2.4, 1.7, 6.0, 5.0, 3.4, 3.3);

// Orbital angular speed (rad/s), ~ Kepler's third law: w = 40 / r^1.5.
// Fast enough that the revolution is obvious: Mercury laps the sun in
// ~10 s, Neptune in ~106 s.
const float P_OMEGA[8] = float[8](0.625, 0.388, 0.270, 0.202, 0.128, 0.090, 0.071, 0.059);

// Starting angle so the planets are spread around the sun.
const float P_PHASE[8] = float[8](0.0, 0.9, 2.1, 3.4, 4.2, 5.1, 0.6, 2.8);

// Axial tilt (radians): Venus is flipped almost upside down (3.09) and
// Uranus rolls on its side (1.71), just like the real ones.
const float P_TILT[8] = float[8](0.05, 3.09, 0.41, 0.44, 0.05, 0.47, 1.71, 0.49);

// Self-spin speed (rad/s); Venus barely turns, and retrograde.
const float P_SPIN[8] = float[8](0.08, -0.03, 0.35, 0.33, 0.60, 0.55, -0.40, 0.45);

// Fixed local-frame directions for one-off surface landmarks.
const vec3 MONS_DIR     = normalize(vec3(0.62, 0.35, 0.70)); // Mars volcano
const vec3 SPOT_DIR     = normalize(vec3(0.80, -0.25, 0.55)); // Jupiter red spot
const vec3 DARKSPOT_DIR = normalize(vec3(-0.55, 0.20, 0.81)); // Neptune dark spot

// Per-hit globals written by map(); shade() must capture them before
// any further map() evaluation (normals, shadows, AO) overwrites them.
float gBody  = -1.0;       // 0..7 planet, 8 sun, 9 moon
vec3  gLocal = vec3(0.0);  // unit direction on the body, in its local frame
float gRingU = 0.0;        // 0..1 across the ring width

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

float hash13(vec3 p)
{
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}

mat3 rotX(float a)
{
    float c = cos(a);
    float s = sin(a);
    return mat3(1.0, 0.0, 0.0,
                0.0,   c,   s,
                0.0,  -s,   c);
}

mat3 rotY(float a)
{
    float c = cos(a);
    float s = sin(a);
    return mat3(  c, 0.0,  -s,
                0.0, 1.0, 0.0,
                  s, 0.0,   c);
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

// ---------------------------------------------------------------------------
// Planet surface relief
// ---------------------------------------------------------------------------

// Radial displacement (world units) for a point on planet i, sampled
// by unit direction in the planet's local frame. Shading recomputes
// the same fields with the same seeds to color what the geometry
// raised.
float planetDisp(int i, vec3 qn)
{
    if (i == 0) // Mercury: cratered rock and a belt of giant cacti
    {
        float craters = (fbm(qn * 5.0 + 1.7) - 0.5) * 0.16;
        float spikeN = valueNoise(qn * 6.0 + 3.1);
        float spikes = pow(max(spikeN - 0.55, 0.0) * 2.2, 2.0);
        float belt = smoothstep(0.35, 0.10, abs(qn.y));
        return craters + spikes * belt * 0.50;
    }

    if (i == 1) // Venus: soft rolling cloud deck
        return (fbm(qn * 3.0 + 4.2) - 0.5) * 0.06;

    if (i == 2) // Earth: continents rise gently out of the ocean
    {
        float cont = fbm(qn * 3.0 + 7.2);
        return smoothstep(0.50, 0.53, cont) * 0.10
             + (fbm(qn * 8.0 + 3.3) - 0.5) * 0.05;
    }

    if (i == 3) // Mars: rough terrain plus one huge shield volcano
    {
        float terrain = (fbm(qn * 4.0 + 2.9) - 0.5) * 0.18;
        float mons = smoothstep(0.90, 1.0, dot(qn, MONS_DIR)) * 0.55;
        return terrain + mons;
    }

    // Gas giants: nearly smooth, faint rolling cloud tops.
    return (fbm(qn * 3.0 + float(i) * 3.7) - 0.5) * 0.05;
}

// ---------------------------------------------------------------------------
// Scene description
// ---------------------------------------------------------------------------

vec2 map(vec3 p)
{
    float best = 1e9;
    float bestMat = MAT_PLANET;
    float bestBody = -1.0;
    vec3  bestLocal = vec3(0.0, 1.0, 0.0);
    float bestRing = 0.0;

    // --- The sun: a boiling emissive ball at the center. ---
    {
        vec3 rel = p - SUN_POS;
        float ds = length(rel) - (SUN_RADIUS + 1.2);

        if (ds > 0.5)
        {
            best = ds;
            bestMat = MAT_SUN;
        }
        else
        {
            vec3 qn = normalize(rel);
            float boil = (fbm(qn * 4.0 + uTime * 0.10) - 0.5) * 0.8;
            float d = (length(rel) - SUN_RADIUS - boil) * 0.8;

            best = d;
            bestMat = MAT_SUN;
            bestBody = 8.0;
            bestLocal = qn;
        }
    }

    // --- The planets. ---
    for (int i = 0; i < NUM_PLANETS; ++i)
    {
        float a = P_PHASE[i] + uTime * P_OMEGA[i];
        vec3 center = SUN_POS + vec3(cos(a), 0.0, sin(a)) * P_ORBITR[i];
        vec3 rel = p - center;

        float size = P_SIZE[i];
        float ringOuter =
            (i == 5) ? size * 2.10 :
            (i == 6) ? size * 1.75 : 0.0;

        float cullR = max(size + 1.0, ringOuter + 0.6);
        if (i == 2)
            cullR = 6.0; // Earth's cull sphere also covers the Moon's orbit

        // Far away: the bounding sphere is a valid, cheap lower bound.
        float ds = length(rel) - cullR;
        if (ds > 0.5)
        {
            best = min(best, ds);
            continue;
        }

        // Tilted, spinning local frame; features rotate with the planet.
        vec3 q = rotY(uTime * P_SPIN[i]) * (rotX(P_TILT[i]) * rel);
        vec3 qn = normalize(q);

        // Displaced sphere, damped because the relief (especially
        // Mercury's cacti and Mars' volcano) steepens the field.
        float damp = (i == 0) ? 0.5 : (i <= 3) ? 0.6 : 0.85;
        float d = (length(rel) - size - planetDisp(i, qn)) * damp;

        float m = MAT_PLANET;
        float body = float(i);
        vec3 loc = qn;
        float ringU = 0.0;

        // Earth's Moon, a cratered pebble on a fast inclined orbit.
        if (i == 2)
        {
            float ma = uTime * 0.45 + 1.3;
            vec3 mc = vec3(cos(ma), 0.18 * sin(ma * 0.7), sin(ma)) * 4.3;
            vec3 mrel = rel - mc;
            vec3 mqn = normalize(mrel);
            float md = (length(mrel) - 0.6
                      - (valueNoise(mqn * 6.0 + 8.0) - 0.5) * 0.10) * 0.8;

            if (md < d)
            {
                d = md;
                m = MAT_MOON;
                body = 9.0;
                loc = mqn;
            }
        }

        // Rings for Saturn (broad) and Uranus (thin, near-vertical
        // because the whole local frame is tilted on its side).
        if (ringOuter > 0.0)
        {
            float inner = (i == 5) ? size * 1.35 : size * 1.45;
            float thick = (i == 5) ? 0.10 + size * 0.012 : 0.09;
            float rr = length(q.xz);
            vec2 w = vec2(rr - clamp(rr, inner, ringOuter), q.y);
            float dRing = length(w) - thick;

            if (dRing < d)
            {
                d = dRing;
                m = MAT_RING;
                body = float(i);
                ringU = clamp((rr - inner) / (ringOuter - inner), 0.0, 1.0);
            }
        }

        if (d < best)
        {
            best = d;
            bestMat = m;
            bestBody = body;
            bestLocal = loc;
            bestRing = ringU;
        }
    }

    gBody = bestBody;
    gLocal = bestLocal;
    gRingU = bestRing;

    return vec2(best, bestMat);
}

// ---------------------------------------------------------------------------
// Sky: nebula and starfield (the sun is real geometry now)
// ---------------------------------------------------------------------------

vec3 skyColor(vec3 rd)
{
    // Near-black space gradient.
    vec3 col = mix(
        vec3(0.010, 0.008, 0.025),
        vec3(0.001, 0.001, 0.006),
        clamp(rd.y * 0.5 + 0.5, 0.0, 1.0)
    );

    // Nebula: one fbm for density, a second to blend magenta and cyan.
    float n = fbm(rd * 2.6 + vec3(4.7, 0.0, 1.3));
    float m = fbm(rd * 5.2 + vec3(0.0, 8.1, 3.3));
    vec3 nebula = mix(
        vec3(0.45, 0.10, 0.55),
        vec3(0.05, 0.35, 0.55),
        m
    );
    col += nebula * pow(max(n - 0.25, 0.0), 2.0) * 1.4;

    // Twinkling starfield on a direction grid.
    vec3 g = rd * 110.0;
    float h = hash13(floor(g));
    if (h > 0.994)
    {
        float d = length(fract(g) - 0.5);
        float twinkle = 0.6 + 0.4 * sin(uTime * 2.0 + h * 90.0);
        col += vec3(0.9, 0.95, 1.0)
             * smoothstep(0.35, 0.0, d) * twinkle * 1.6;
    }

    return col;
}

vec3 missColor(vec3 rd)
{
    vec3 color = skyColor(rd);

    // Rays that grazed the system pick up a warm corona glow; the
    // effect is strongest right around the sun's limb.
    float glow = exp(-0.10 * gClosest);
    color += vec3(1.0, 0.55, 0.20) * glow * 0.6;

    return color;
}

// ---------------------------------------------------------------------------
// Surface shading
// ---------------------------------------------------------------------------

vec3 shade(vec3 ro, vec3 rd, float t, float mat)
{
    // Capture the per-hit globals before normals/shadows/AO
    // re-evaluate map() and overwrite them.
    int body = int(gBody + 0.5);
    vec3 qn = gLocal;
    float ringU = gRingU;

    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p, t);

    // Space haze for the final fog blend.
    vec3 haze = mix(
        vec3(0.10, 0.04, 0.12),
        vec3(0.02, 0.03, 0.08),
        clamp(rd.y * 0.5 + 0.5, 0.0, 1.0)
    );

    // --- The sun is pure emission: granulation plus limb darkening. ---
    if (mat == MAT_SUN)
    {
        float gran = fbm(qn * 6.0 + vec3(uTime * 0.10));
        float limb = pow(clamp(dot(n, -rd), 0.0, 1.0), 0.6);
        vec3 c = mix(vec3(1.0, 0.30, 0.02), vec3(1.0, 0.85, 0.35), gran);
        c *= 1.6 + 2.4 * limb;
        return applyFog(c, haze, t);
    }

    // Point light at the sun's center; everything else is lit by it.
    vec3 toSun = SUN_POS - p;
    float dSun = length(toSun);
    vec3 L = toSun / dSun;
    float lat = qn.y;
    float night = smoothstep(0.02, -0.06, dot(n, L));

    vec3 albedo = vec3(0.5);
    vec3 emissive = vec3(0.0);
    float specStrength = 0.1;

    if (mat == MAT_RING)
    {
        // Banded dusty ring with a Cassini-style gap.
        float bands = 0.55 + 0.45 * sin(ringU * 34.0);
        float gap = smoothstep(0.56, 0.62, ringU)
                  * (1.0 - smoothstep(0.66, 0.72, ringU));

        vec3 tint = (body == 6)
            ? vec3(0.55, 0.75, 0.85)   // Uranus: icy blue
            : vec3(0.80, 0.70, 0.52);  // Saturn: warm sand
        albedo = mix(tint, tint * 0.45, bands);
        albedo *= 1.0 - 0.75 * gap;
        specStrength = 0.2;
    }
    else if (mat == MAT_MOON)
    {
        float crater = valueNoise(qn * 6.0 + 8.0);
        albedo = mix(vec3(0.30, 0.30, 0.32), vec3(0.55, 0.55, 0.58), crater);
        specStrength = 0.03;
    }
    else if (body == 0) // Mercury: grey rock, equatorial cactus belt
    {
        float crater = fbm(qn * 5.0 + 1.7);
        albedo = mix(vec3(0.38, 0.34, 0.30), vec3(0.55, 0.50, 0.44), crater);

        float spikeN = valueNoise(qn * 6.0 + 3.1);
        float spikes = pow(max(spikeN - 0.55, 0.0) * 2.2, 2.0);
        float belt = smoothstep(0.35, 0.10, abs(lat));
        float cactus = clamp(spikes * belt * 5.0, 0.0, 1.0);
        albedo = mix(albedo, vec3(0.14, 0.45, 0.18), cactus);
        specStrength = 0.05;
    }
    else if (body == 1) // Venus: golden clouds, glowing sulfur lichen
    {
        float swirl = fbm(qn * 3.0 + vec3(uTime * 0.02, 0.0, 0.0) + 4.2);
        float bands = 0.5 + 0.5 * sin(lat * 9.0 + swirl * 5.0);
        albedo = mix(vec3(0.86, 0.72, 0.45), vec3(0.98, 0.90, 0.66), bands);

        float vein = abs(fbm(qn * 6.0 + 9.3) - 0.52);
        float lichen = smoothstep(0.035, 0.0, vein - 0.015);
        emissive += vec3(0.9, 0.55, 0.10) * lichen * 0.35;
        specStrength = 0.15;
    }
    else if (body == 2) // Earth: oceans, forests, ice, clouds, cities
    {
        float cont = fbm(qn * 3.0 + 7.2);
        float land = smoothstep(0.50, 0.53, cont);
        float ice = smoothstep(0.78, 0.86, abs(lat));

        float forest = fbm(qn * 9.0 + 3.3);
        vec3 landCol = mix(
            vec3(0.10, 0.34, 0.08),
            vec3(0.05, 0.22, 0.05),
            smoothstep(0.4, 0.7, forest)
        );
        // Sandy deserts near the equator.
        landCol = mix(
            landCol,
            vec3(0.75, 0.66, 0.40),
            smoothstep(0.25, 0.05, abs(lat)) * smoothstep(0.55, 0.65, forest)
        );

        albedo = mix(vec3(0.03, 0.12, 0.35), landCol, land);
        albedo = mix(albedo, vec3(0.90, 0.93, 0.98), ice);
        specStrength = mix(0.9, 0.05, max(land, ice)); // oceans glint

        float cl = fbm(qn * 4.0 + vec3(uTime * 0.015, 0.0, 0.0) + 5.5);
        float clouds = smoothstep(0.55, 0.70, cl);
        albedo = mix(albedo, vec3(0.95), clouds * 0.85);
        specStrength *= 1.0 - clouds;

        // City lights speckle the dark side of the continents.
        float cities = smoothstep(0.965, 0.995, valueNoise(qn * 60.0));
        emissive += vec3(1.0, 0.75, 0.35)
                  * cities * land * (1.0 - clouds) * night * 1.6;
    }
    else if (body == 3) // Mars: rust, ice caps, volcano, lowland moss
    {
        float m1 = fbm(qn * 4.0 + 2.9);
        albedo = mix(vec3(0.55, 0.22, 0.10), vec3(0.78, 0.42, 0.22), m1);

        float caps = smoothstep(0.82, 0.90, abs(lat));
        albedo = mix(albedo, vec3(0.92, 0.90, 0.88), caps);

        float mons = smoothstep(0.90, 1.0, dot(qn, MONS_DIR));
        albedo = mix(albedo, vec3(0.45, 0.25, 0.16), mons * 0.7);

        float moss = smoothstep(0.60, 0.72, fbm(qn * 6.0 + 6.1))
                   * smoothstep(0.55, 0.20, abs(lat));
        albedo = mix(albedo, vec3(0.10, 0.40, 0.35), moss * 0.8);
        specStrength = 0.05;
    }
    else if (body == 4) // Jupiter: bands, Red Spot, sky-algae bloom
    {
        float turb = fbm(qn * vec3(2.0, 7.0, 2.0) + 8.8);
        float bands = sin(lat * 14.0 + turb * 6.0);
        albedo = mix(
            vec3(0.72, 0.55, 0.38),
            vec3(0.90, 0.82, 0.68),
            0.5 + 0.5 * bands
        );

        float spot = smoothstep(0.962, 0.985, dot(qn, SPOT_DIR));
        albedo = mix(albedo, vec3(0.72, 0.18, 0.10), spot);

        // An emerald bloom of floating algae rides one southern band.
        float band = smoothstep(0.10, 0.02, abs(lat + 0.42) - 0.06);
        float wisp = smoothstep(0.50, 0.75,
            fbm(qn * 6.0 + vec3(0.0, 0.0, uTime * 0.01) + 12.0));
        albedo = mix(albedo, vec3(0.10, 0.55, 0.30), band * wisp * 0.8);
        emissive += vec3(0.05, 0.35, 0.15) * band * wisp * 0.4;
        specStrength = 0.2;
    }
    else if (body == 5) // Saturn: pale gold bands, hexagonal pole storm
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
    else if (body == 6) // Uranus: sideways cyan world, mint sky-kelp
    {
        float k = fbm(qn * vec3(2.0, 8.0, 2.0) + 5.9);
        albedo = mix(
            vec3(0.35, 0.72, 0.78),
            vec3(0.55, 0.85, 0.88),
            0.5 + 0.5 * sin(lat * 6.0 + k * 3.0)
        );

        float kelp = smoothstep(0.62, 0.78,
            valueNoise(qn * vec3(3.0, 12.0, 3.0) + vec3(uTime * 0.03)));
        albedo = mix(albedo, vec3(0.55, 0.95, 0.75), kelp * 0.5);
        emissive += vec3(0.20, 0.60, 0.45) * kelp * 0.15;
        specStrength = 0.3;
    }
    else if (body == 7) // Neptune: racing storms, glowing plankton
    {
        float w = fbm(qn * 3.5 + vec3(uTime * 0.06, 0.0, 0.0) + 7.7);
        albedo = mix(
            vec3(0.05, 0.15, 0.55),
            vec3(0.16, 0.35, 0.80),
            0.5 + 0.5 * sin(lat * 8.0 + w * 7.0)
        );

        float streak = smoothstep(0.68, 0.80, w)
                     * smoothstep(0.45, 0.10, abs(lat + 0.15));
        albedo = mix(albedo, vec3(0.92, 0.96, 1.0), streak * 0.8);

        float dark = smoothstep(0.965, 0.99, dot(qn, DARKSPOT_DIR));
        albedo = mix(albedo, vec3(0.02, 0.06, 0.25), dark);

        // Bioluminescent plankton light up the night hemisphere.
        float plank = smoothstep(0.94, 0.99, valueNoise(qn * 30.0 + 2.2));
        emissive += vec3(0.15, 0.80, 0.90) * plank * night * 1.2;
        specStrength = 0.35;
    }

    // Sunlight: shadow ray stops short of the sun's own surface, and a
    // gentle falloff keeps the outer planets dimmer than the inner ones.
    vec3 sunColor = vec3(1.0, 0.88, 0.70);
    float atten = clamp(45.0 / dSun, 0.55, 1.6);

    float diffuse = max(dot(n, L), 0.0);
    vec3 halfway = normalize(L - rd);
    float specular = uEnableSpecular
        ? pow(max(dot(n, halfway), 0.0), 64.0) * specStrength
        : 0.0;
    float shadowMax = max(dSun - SUN_RADIUS - 1.5, 1.0);
    float shadow = softShadow(p + n * 0.05, L, 0.1, shadowMax, 10.0);

    float ao = ambientOcclusion(p, n);

    vec3 color = vec3(0.0);
    color += albedo * sunColor * diffuse * shadow * atten * 1.6;
    color += sunColor * specular * shadow * atten;
    color += albedo * vec3(0.10, 0.08, 0.16) * ao * 1.6; // nebula ambient
    color += emissive;

    return applyFog(color, haze, t);
}
