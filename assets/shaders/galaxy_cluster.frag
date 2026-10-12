#version 330 core

// Galaxy cluster: nine weird galaxies sharing one space, each a
// glowing island you can fly between.
//
//   1. Mini solar system  - sun, eight planets, rings, Earth's moon
//   2. Black hole         - blazing accretion disk, doomed comets,
//                           a companion star being stripped
//   3. Crystal spiral     - two arms of pulsing octahedral shards
//   4. Jellyfish bloom    - six bioluminescent space jellies
//   5. Donut galaxy       - a frosted, sprinkled torus of star-dough
//                           tumbling around a white dwarf
//   6. Grid galaxy        - a galaxy assimilated into a lattice of
//                           pulsing neon cubes
//   7. Vortex galaxy      - a star tornado; debris spirals down the
//                           funnel into golden fire
//   8. Butterfly nebula   - a colossal space butterfly slowly flapping
//                           wings full of eye-spots and glowing veins
//   9. Helix galaxy       - a rotating DNA strand of light with
//                           glowing rungs
//  10. Clockwork galaxy   - two meshing gears tick like an escapement
//                           while a pendulum star swings below
//  11. Eye galaxy         - a colossal cosmic eye that wanders its
//                           gaze around and blinks every few seconds
//  12. Harp galaxy        - seven vibrating strings of light playing
//                           themselves, plucks racing up and down
//  13. Portal galaxy      - a wormhole ring around a swirling
//                           iridescent membrane, sparks riding the rim
//
// The galaxies are flung THOUSANDS of units apart across deep space -
// from the solar system at spawn, the others are barely-visible
// glimmers you set course toward (crank the Move speed slider all the
// way up). Every galaxy sits behind its own bounding sphere, so each
// ray only ever pays for the one it is near; rays in empty space see
// nothing but sphere distances per step.

#define MAX_STEPS      170
#define MAX_DISTANCE   16000.0
#define HIT_EPSILON    0.0008
#define STEP_SCALE     0.85
#define NORMAL_EPSILON 0.0008
#define FOG_DENSITY    0.00002
#define SHADOW_STEPS   24
#define SHADOW_STEP_MIN 0.03
#define SHADOW_STEP_MAX 4.0
#define AO_STEP        0.12
#define AO_STRENGTH    2.2
#define AO_FALLOFF     0.65
#define EXPOSURE       1.25

#include "worldlib.glsl"

// ---------------------------------------------------------------------------
// Material IDs (unique across all galaxies, so shade() can dispatch)
// ---------------------------------------------------------------------------

const float MAT_SUN     = 0.0;
const float MAT_PLANET  = 1.0;
const float MAT_RINGM   = 2.0;
const float MAT_MOON    = 3.0;
const float MAT_HOLE    = 4.0;
const float MAT_DISK    = 5.0;
const float MAT_COMET   = 6.0;
const float MAT_BHSTAR  = 7.0;
const float MAT_STREAM  = 8.0;
const float MAT_CORE    = 9.0;
const float MAT_CRYSTAL = 10.0;
const float MAT_ORB     = 11.0;
const float MAT_BELL    = 12.0;
const float MAT_TENT    = 13.0;
const float MAT_ORGAN   = 14.0;
const float MAT_MOTE    = 15.0;
const float MAT_TORUS   = 16.0;
const float MAT_TORSTAR = 17.0;
const float MAT_CUBE    = 18.0;
const float MAT_VORTEX  = 19.0;
const float MAT_DEBRIS  = 20.0;
const float MAT_WING    = 21.0;
const float MAT_BFCORE  = 22.0;
const float MAT_STRAND  = 23.0;
const float MAT_RUNG    = 24.0;
const float MAT_GEAR    = 25.0;
const float MAT_PEND    = 26.0;
const float MAT_EYE     = 27.0;
const float MAT_LID     = 28.0;
const float MAT_STRING  = 29.0;
const float MAT_BEAD    = 30.0;
const float MAT_FRAME   = 31.0;
const float MAT_PORTRING = 32.0;
const float MAT_MEMBRANE = 33.0;

// ---------------------------------------------------------------------------
// Galaxy placement
// ---------------------------------------------------------------------------

const vec3 SOLAR_POS   = vec3(    0.0,     2.0,   90.0);
const vec3 HOLE_POS    = vec3(-5200.0,   600.0, 5200.0);
const vec3 CRYST_POS   = vec3( 5400.0,  -200.0, 6200.0);
const vec3 JELLY_POS   = vec3(-1800.0,   900.0, 8800.0);
const vec3 DONUT_POS   = vec3( 3000.0,  1600.0, 9500.0);
const vec3 GRID_POS    = vec3(-6200.0,  -800.0, 1600.0);
const vec3 VORTEX_POS  = vec3( 2600.0,  -900.0, 4200.0);
const vec3 FLY_POS     = vec3(-3200.0,  1800.0, 6400.0);
const vec3 HELIX_POS   = vec3( 6600.0,  1200.0, 1800.0);
const vec3 GEAR_POS    = vec3( 7200.0, -1600.0, 7000.0);
const vec3 EYE_POS     = vec3(-7000.0,  2400.0, 9500.0);
const vec3 HARP_POS    = vec3(  600.0, -2600.0, 7000.0);
const vec3 PORTAL_POS  = vec3(-2600.0, -1800.0, 3000.0);

// Generic per-hit payload written by map(). Because the galaxies are
// hundreds of units apart, only one of them is ever in detail range,
// so they can safely share these. shade() captures them first thing.
float gA = 0.0;        // body index / hue / progress / side ...
float gB = 0.0;        // ring U / galactic radius ...
vec3  gV = vec3(0.0);  // local hit position / unit direction ...

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

mat3 rotZ(float a)
{
    float c = cos(a);
    float s = sin(a);
    return mat3(  c,   s, 0.0,
                 -s,   c, 0.0,
                0.0, 0.0, 1.0);
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

// 3-octave fbm for fields the distance estimator needs (map() runs
// hundreds of times per pixel; shading fields that must line up with
// geometry use this too).
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

float sdBox(vec3 p, vec3 b)
{
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdOcta(vec3 p, float s)
{
    p = abs(p);
    return (p.x + p.y + p.z - s) * 0.57735;
}

float sdEllip(vec3 p, vec3 r)
{
    float k0 = length(p / r);
    float k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / k1;
}

// ===========================================================================
// GALAXY 1: mini solar system
// ===========================================================================

const int   NUM_PLANETS = 8;
const float SUN_RADIUS  = 10.0;

const float P_ORBITR[8] = float[8](16.0, 22.0, 28.0, 34.0, 46.0, 58.0, 68.0, 77.0);
const float P_SIZE[8]   = float[8](1.3, 2.2, 2.4, 1.7, 6.0, 5.0, 3.4, 3.3);
const float P_OMEGA[8]  = float[8](0.625, 0.388, 0.270, 0.202, 0.128, 0.090, 0.071, 0.059);
const float P_PHASE[8]  = float[8](0.0, 0.9, 2.1, 3.4, 4.2, 5.1, 0.6, 2.8);
const float P_TILT[8]   = float[8](0.05, 3.09, 0.41, 0.44, 0.05, 0.47, 1.71, 0.49);
const float P_SPIN[8]   = float[8](0.08, -0.03, 0.35, 0.33, 0.60, 0.55, -0.40, 0.45);
const float P_MAXDISP[8] = float[8](0.48, 0.04, 0.14, 0.66, 0.03, 0.03, 0.03, 0.03);

const vec3 MONS_DIR     = normalize(vec3(0.62, 0.35, 0.70));
const vec3 SPOT_DIR     = normalize(vec3(0.80, -0.25, 0.55));
const vec3 DARKSPOT_DIR = normalize(vec3(-0.55, 0.20, 0.81));

float planetDisp(int i, vec3 qn)
{
    if (i == 0) // Mercury: craters and a belt of giant cacti
    {
        float craters = (fbm3(qn * 5.0 + 1.7) - 0.5) * 0.16;
        float spikeN = valueNoise(qn * 5.0 + 3.1);
        float spikes = pow(max(spikeN - 0.55, 0.0) * 2.2, 2.0);
        float belt = smoothstep(0.35, 0.10, abs(qn.y));
        return craters + spikes * belt * 0.40;
    }

    if (i == 1) // Venus
        return (fbm3(qn * 3.0 + 4.2) - 0.5) * 0.06;

    if (i == 2) // Earth
    {
        float cont = fbm3(qn * 3.0 + 7.2);
        return smoothstep(0.49, 0.55, cont) * 0.10
             + (fbm3(qn * 8.0 + 3.3) - 0.5) * 0.05;
    }

    if (i == 3) // Mars
    {
        float terrain = (fbm3(qn * 4.0 + 2.9) - 0.5) * 0.18;
        float mons = smoothstep(0.86, 1.0, dot(qn, MONS_DIR)) * 0.55;
        return terrain + mons;
    }

    return (fbm3(qn * 3.0 + float(i) * 3.7) - 0.5) * 0.05;
}

vec2 solarSystem(vec3 p)
{
    vec3 srel = p - SOLAR_POS;
    float sysDist = length(srel);
    float sys = sysDist - 84.0;
    if (sys > 1.0)
        return vec2(sys, MAT_PLANET);

    float best = 1e9;
    float bestMat = MAT_PLANET;
    float bestA = -1.0;
    float bestB = 0.0;
    vec3  bestV = vec3(0.0, 1.0, 0.0);

    // The sun.
    {
        float ds = sysDist - (SUN_RADIUS + 1.2);
        if (ds > 0.5)
        {
            best = ds;
            bestMat = MAT_SUN;
        }
        else
        {
            vec3 qn = srel / sysDist;
            float boil = (fbm3(qn * 4.0 + uTime * 0.10) - 0.5) * 0.8;
            best = (sysDist - SUN_RADIUS - boil) * 0.75;
            bestMat = MAT_SUN;
            bestA = 8.0;
            bestV = qn;
        }
    }

    float rho = length(srel.xz);

    for (int i = 0; i < NUM_PLANETS; ++i)
    {
        float size = P_SIZE[i];
        float ringOuter =
            (i == 5) ? size * 2.10 :
            (i == 6) ? size * 1.75 : 0.0;

        float cullR = max(size + 1.0, ringOuter + 0.6);
        if (i == 2)
            cullR = 6.0;

        // Orbit-circle prefilter: no trig until a ray is close.
        float dc = length(vec2(rho - P_ORBITR[i], srel.y)) - cullR;
        if (dc > 0.5)
        {
            best = min(best, dc);
            continue;
        }

        float a = P_PHASE[i] + uTime * P_OMEGA[i];
        vec3 center = SOLAR_POS + vec3(cos(a), 0.0, sin(a)) * P_ORBITR[i];
        vec3 rel = p - center;

        float ds = length(rel) - cullR;
        if (ds > 0.5)
        {
            best = min(best, ds);
            continue;
        }

        vec3 q = rotY(uTime * P_SPIN[i]) * (rotX(P_TILT[i]) * rel);
        vec3 qn = normalize(q);

        float d0 = length(rel) - size;
        float d;
        if (d0 - P_MAXDISP[i] > 0.4)
        {
            d = d0 - P_MAXDISP[i];
        }
        else
        {
            float damp = (i == 0) ? 0.55 : (i <= 3) ? 0.6 : 0.85;
            d = (d0 - planetDisp(i, qn)) * damp;
        }

        float m = MAT_PLANET;
        float body = float(i);
        vec3 loc = qn;
        float ringU = 0.0;

        if (i == 2) // Earth's Moon
        {
            float ma = uTime * 0.45 + 1.3;
            vec3 mc = vec3(cos(ma), 0.18 * sin(ma * 0.7), sin(ma)) * 4.3;
            vec3 mrel = rel - mc;
            float md0 = length(mrel) - 0.6;

            float md;
            if (md0 > 0.5)
            {
                md = md0 - 0.05;
            }
            else
            {
                vec3 mqn = normalize(mrel);
                md = (md0 - (valueNoise(mqn * 6.0 + 8.0) - 0.5) * 0.10) * 0.8;
            }

            if (md < d)
            {
                d = md;
                m = MAT_MOON;
                body = 9.0;
                loc = normalize(mrel);
            }
        }

        if (ringOuter > 0.0)
        {
            float inner = (i == 5) ? size * 1.35 : size * 1.45;
            float thickR = (i == 5) ? 0.10 + size * 0.012 : 0.09;
            float rr = length(q.xz);
            vec2 w = vec2(rr - clamp(rr, inner, ringOuter), q.y);
            float dRing = length(w) - thickR;

            if (dRing < d)
            {
                d = dRing;
                m = MAT_RINGM;
                body = float(i);
                ringU = clamp((rr - inner) / (ringOuter - inner), 0.0, 1.0);
            }
        }

        if (d < best)
        {
            best = d;
            bestMat = m;
            bestA = body;
            bestB = ringU;
            bestV = loc;
        }
    }

    gA = bestA;
    gB = bestB;
    gV = bestV;

    return vec2(best, bestMat);
}

// ===========================================================================
// GALAXY 2: black hole
// ===========================================================================

const float HOLE_R    = 6.0;
const float DISK_IN   = 8.5;
const float DISK_OUT  = 30.0;
const float DISK_TILT = 0.35;

vec2 blackHole(vec3 p)
{
    vec3 rel = p - HOLE_POS;
    float rc = length(rel);

    float sys = rc - 52.0;
    if (sys > 1.0)
        return vec2(sys, MAT_DISK);

    float best = rc - HOLE_R;
    float bestMat = MAT_HOLE;
    float bestA = 0.0;
    vec3 bestV = rel;

    vec3 q = rotX(DISK_TILT) * rel;

    float rr = length(q.xz);
    float thick = 0.12 + 0.55 * smoothstep(DISK_OUT, DISK_IN, rr);
    vec2 w = vec2(rr - clamp(rr, DISK_IN, DISK_OUT), q.y);
    float dDisk = length(w) - thick;
    if (dDisk < best)
    {
        best = dDisk;
        bestMat = MAT_DISK;
        bestV = q;
    }

    for (int i = 0; i < 3; ++i)
    {
        float fi = float(i);
        float prog = fract(uTime * 0.06 + fi * 0.33);
        float cr = mix(DISK_OUT + 4.0, HOLE_R + 2.0, prog);
        float ca = fi * 2.1 + uTime * 0.9 + prog * 6.0;
        vec2 cs = vec2(cos(ca), sin(ca));
        vec3 cq = vec3(cs.x * cr, 0.4 * sin(ca * 2.0 + fi), cs.y * cr);
        vec3 tang = vec3(-cs.y, 0.0, cs.x);

        vec3 pa = q - cq;
        vec3 ba = -tang * 5.0;
        float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
        float dcm = length(pa - ba * h) - mix(0.45, 0.10, h);

        if (dcm < best)
        {
            best = dcm;
            bestMat = MAT_COMET;
            bestA = h;
            bestV = q;
        }
    }

    vec3 sp = vec3(34.0, 10.0, 0.0);
    float dStar = length(q - sp) - 3.2;
    if (dStar < best)
    {
        best = dStar;
        bestMat = MAT_BHSTAR;
        bestV = q - sp;
    }

    vec3 target = vec3(DISK_OUT * 0.95, 0.0, -6.0);
    for (int j = 0; j < 5; ++j)
    {
        float ft = float(j) / 4.0;
        vec3 c = mix(sp, target, ft);
        c.y -= sin(ft * 3.14159) * 2.0;
        c.z -= sin(ft * 3.14159) * 4.0;
        float dg = length(q - c) - mix(1.4, 0.6, ft);

        if (dg < best)
        {
            best = dg;
            bestMat = MAT_STREAM;
            bestA = ft;
            bestV = q;
        }
    }

    gA = bestA;
    gV = bestV;

    return vec2(best, bestMat);
}

// ===========================================================================
// GALAXY 3: crystal spiral
// ===========================================================================

const float CRYST_CELL = 9.0;

vec2 crystalGalaxy(vec3 p)
{
    vec3 rel = p - CRYST_POS;

    float sys = length(rel) - 76.0;
    if (sys > 1.0)
        return vec2(sys, MAT_CRYSTAL);

    float best = (length(rel) - (6.5 + 0.35 * sin(uTime * 1.7))) * 0.9;
    float bestMat = MAT_CORE;
    float bestA = 0.0;
    float bestB = 0.0;

    vec3 rq = rotY(uTime * 0.05) * rel;

    float dSlab = abs(rq.y) - 10.0;
    if (dSlab > 0.5)
    {
        best = min(best, dSlab);
    }
    else
    {
        vec2 cell = floor(rq.xz / CRYST_CELL);
        vec2 lc = rq.xz - (cell + 0.5) * CRYST_CELL;
        float safe = CRYST_CELL * 0.5 - max(abs(lc.x), abs(lc.y)) + 1.2;

        float h1 = hash13(vec3(cell, 4.4));
        float h2 = hash13(vec3(cell, 17.9));
        float h3 = hash13(vec3(cell, 42.3));

        vec2 cc = (cell + 0.5) * CRYST_CELL;
        float r = length(cc);
        float theta = atan(cc.y, cc.x);

        float arm = 0.5 + 0.5 * sin(2.0 * theta - 3.6 * log(max(r, 3.0)));
        bool present = h1 < arm * arm * 0.9 + 0.04 && r > 11.0 && r < 66.0;

        float cand = safe;
        if (present)
        {
            vec3 q = vec3(
                lc.x - (h2 - 0.5) * 3.0,
                rq.y - (h3 - 0.5) * 7.0 * (1.0 - r / 90.0),
                lc.y - (h3 - 0.5) * 3.0
            );

            q = rotZ(h2 * 1.2 - 0.6) * (rotY(h1 * 6.283) * q);
            float tall = 2.2 + h1 * 1.6;
            float size = 1.0 + h3 * 1.8;

            float d = sdOcta(vec3(q.x, q.y / tall, q.z), size);
            cand = min(d, safe);
        }

        if (cand < best)
        {
            best = cand;
            bestMat = MAT_CRYSTAL;
            bestA = h1 * 7.7 + h2;
            bestB = r;
        }
    }

    for (int i = 0; i < 2; ++i)
    {
        float fi = float(i);
        float oa = uTime * (0.20 - fi * 0.07) + fi * 3.14159;
        float orbR = 40.0 + fi * 14.0;
        vec3 oc = vec3(cos(oa) * orbR, 2.5 * sin(oa * 3.0 + fi), sin(oa) * orbR);
        float dOrb = length(rq - oc) - 1.3;

        if (dOrb < best)
        {
            best = dOrb;
            bestMat = MAT_ORB;
        }
    }

    gA = bestA;
    gB = bestB;

    return vec2(best, bestMat);
}

// ===========================================================================
// GALAXY 4: jellyfish bloom (with plankton motes)
// ===========================================================================

const int NUM_JELLY = 6;

const vec3 J_OFF[6] = vec3[6](
    vec3(  0.0,  2.0,  0.0),
    vec3(-14.0,  7.0, -7.0),
    vec3( 12.0, -4.0,  7.0),
    vec3( -8.0, -9.0, 15.0),
    vec3( 18.0,  8.0, -13.0),
    vec3(-21.0, -2.0,  5.0)
);

const float J_SIZE[6] = float[6](5.0, 3.2, 4.0, 2.6, 2.2, 3.6);
const float J_PH[6]   = float[6](0.0, 1.3, 2.6, 3.9, 5.2, 0.7);

vec2 jellyGalaxy(vec3 p)
{
    vec3 crel = p - JELLY_POS;
    float sys = length(crel) - 45.0;
    if (sys > 1.0)
        return vec2(sys, MAT_MOTE);

    float best = 1e9;
    float bestMat = MAT_MOTE;
    float bestA = 0.0;
    vec3 bestV = vec3(0.0);

    for (int i = 0; i < NUM_JELLY; ++i)
    {
        float ph = J_PH[i];
        float s = J_SIZE[i];

        vec3 c = JELLY_POS + J_OFF[i];
        c.y += sin(uTime * 0.5 + ph) * 1.2;

        vec3 q = p - c;

        float bound = length(q) - s * 3.8;
        if (bound > 0.5)
        {
            best = min(best, bound);
            continue;
        }

        float pulse = 1.0 + 0.10 * sin(uTime * 1.6 + ph);
        float R = s * pulse;

        float outer = length(q * vec3(1.0, 1.12, 1.0)) - R;
        float inner = length(q) - R * 0.80;
        float bell = max(outer, -inner);
        bell = max(bell, -(q.y + R * 0.18));
        bell *= 0.8;

        float d = bell;
        float m = MAT_BELL;
        vec3 lq = q / R;

        float organ = length(q - vec3(0.0, R * 0.30, 0.0)) - R * 0.30;
        if (organ < d)
        {
            d = organ;
            m = MAT_ORGAN;
        }

        float sector = 0.785398;
        float ang = mod(atan(q.z, q.x) + sector * 0.5, sector) - sector * 0.5;
        float rxz = length(q.xz);
        vec3 tq = vec3(rxz * cos(ang) - R * 0.55, q.y + R * 0.10, rxz * sin(ang));

        float droop = clamp(-tq.y / (2.6 * s), 0.0, 1.0);
        tq.x += sin(q.y * 0.9 / s + uTime * 1.8 + ph) * 0.35 * s * droop;

        float len = 2.6 * s;
        vec3 pc = vec3(tq.x, tq.y + clamp(-tq.y, 0.0, len), tq.z);
        float tent = (length(pc) - mix(0.10 * s, 0.025 * s, droop)) * 0.6;

        if (tent < d)
        {
            d = tent;
            m = MAT_TENT;
            lq = vec3(tq.x, tq.y, droop) / s;
        }

        if (d < best)
        {
            best = d;
            bestMat = m;
            bestA = float(i);
            bestV = lq;
        }
    }

    // Plankton motes inside the bloom.
    {
        vec3 g = p / 6.0;
        vec3 cellId = floor(g);
        vec3 lf = fract(g) - 0.5;

        vec3 off = vec3(
            hash13(cellId + 1.1),
            hash13(cellId + 2.2),
            hash13(cellId + 3.3)
        ) - 0.5;
        off *= 0.6;

        float mote = length(lf - off) * 6.0 - 0.10;
        float edge = (0.5 - max(abs(lf.x), max(abs(lf.y), abs(lf.z)))) * 6.0 + 0.3;
        float dm = (hash13(cellId) < 0.5) ? edge : min(mote, edge);

        if (dm < best)
        {
            best = dm;
            bestMat = MAT_MOTE;
            bestV = cellId;
        }
    }

    gA = bestA;
    gV = bestV;

    return vec2(best, bestMat);
}

// ===========================================================================
// GALAXY 5: donut galaxy (frosted, with sprinkles)
// ===========================================================================

vec2 donutGalaxy(vec3 p)
{
    vec3 rel = p - DONUT_POS;
    float bound = length(rel) - 36.0;
    if (bound > 1.0)
        return vec2(bound, MAT_TORUS);

    // The donut slowly tumbles end over end.
    vec3 q = rotX(uTime * 0.06) * rel;

    float d = (length(vec2(length(q.xz) - 24.0, q.y)) - 6.0) * 0.9;
    vec2 res = vec2(d, MAT_TORUS);

    // A white dwarf sits in the hole.
    float star = length(q) - 2.5;
    if (star < res.x)
        res = vec2(star, MAT_TORSTAR);

    gV = q;
    return res;
}

// ===========================================================================
// GALAXY 6: grid galaxy (assimilated into neon cubes)
// ===========================================================================

vec2 gridGalaxy(vec3 p)
{
    vec3 rel = p - GRID_POS;
    float sphere = length(rel) - 30.0;
    if (sphere > 1.0)
        return vec2(sphere, MAT_CUBE);

    vec3 g = rel / 8.0;
    vec3 cellId = floor(g);
    vec3 lf = (fract(g) - 0.5) * 8.0;

    float h = hash13(cellId);
    float pulse = 1.1 + 0.5
        * sin(uTime * 1.5 + h * 6.28 + (cellId.x + cellId.y + cellId.z) * 0.8);

    float cube = sdBox(lf, vec3(pulse));
    float edge = 4.0 - max(abs(lf.x), max(abs(lf.y), abs(lf.z))) + 0.4;

    // Lattice clipped to the galaxy's ball.
    float d = max(min(cube, edge), sphere);

    gA = h;
    gV = cellId;
    return vec2(d, MAT_CUBE);
}

// ===========================================================================
// GALAXY 7: vortex galaxy (a tornado of stars)
// ===========================================================================

vec2 vortexGalaxy(vec3 p)
{
    vec3 rel = p - VORTEX_POS;
    float bound = length(rel) - 34.0;
    if (bound > 1.0)
        return vec2(bound, MAT_VORTEX);

    // Funnel shell: narrow at the bottom, flaring open at the top.
    float y = clamp(rel.y, -20.0, 20.0);
    float fr = 2.0 + (y + 20.0) * 0.45;
    float shell = (abs(length(rel.xz) - fr) - 1.0) * 0.6;
    float d = max(shell, abs(rel.y) - 20.0);

    vec2 res = vec2(d, MAT_VORTEX);
    gV = rel;

    // Debris boulders spiraling down into the fire.
    for (int i = 0; i < 3; ++i)
    {
        float fi = float(i);
        float prog = fract(uTime * 0.07 + fi * 0.31);
        float dy = mix(20.0, -18.0, prog);
        float rr = 2.0 + (dy + 20.0) * 0.45 + 2.5;
        float aa = uTime * (1.4 + fi * 0.3) + fi * 2.1;
        vec3 dp = vec3(cos(aa) * rr, dy, sin(aa) * rr);
        float dd = length(rel - dp) - 0.9;

        if (dd < res.x)
        {
            res = vec2(dd, MAT_DEBRIS);
            gA = prog;
        }
    }

    return res;
}

// ===========================================================================
// GALAXY 8: butterfly nebula (it flaps)
// ===========================================================================

vec2 butterflyGalaxy(vec3 p)
{
    vec3 rel = p - FLY_POS;
    float bound = length(rel) - 30.0;
    if (bound > 1.0)
        return vec2(bound, MAT_WING);

    vec3 q = rel;
    float side = sign(q.x + 0.0001);
    q.x = abs(q.x);

    // Both wings rise and fall together.
    float flap = 0.35 + 0.25 * sin(uTime * 0.8);
    q = rotZ(-flap) * q;

    float upper = sdEllip(q - vec3(9.5, 3.5, 0.0), vec3(8.5, 5.0, 2.2));
    float lower = sdEllip(q - vec3(6.5, -4.5, 0.0), vec3(5.5, 4.0, 2.0));
    float wings = min(upper, lower) * 0.85;

    vec2 res = vec2(wings, MAT_WING);
    gV = q;
    gA = side;

    // Glowing body between the wings.
    vec3 bp = rel;
    bp.y -= clamp(bp.y, -6.0, 6.0);
    float body = length(bp) - 1.3;
    if (body < res.x)
        res = vec2(body, MAT_BFCORE);

    return res;
}

// ===========================================================================
// GALAXY 9: helix galaxy (cosmic DNA)
// ===========================================================================

vec2 helixGalaxy(vec3 p)
{
    vec3 rel = p - HELIX_POS;
    float bound = length(rel) - 32.0;
    if (bound > 1.0)
        return vec2(bound, MAT_STRAND);

    float R = 6.0;
    float pitch = 0.55;
    float spin = uTime * 0.35;
    float theta = atan(rel.z, rel.x);
    float dr = length(rel.xz) - R;

    // Conservative wrap metric: the sin handles both the angular wrap
    // and the vertical distance between turns.
    float norm = 2.0 * R / sqrt(1.0 + pitch * pitch * R * R);

    vec2 res = vec2(1e9, MAT_STRAND);

    for (int k = 0; k < 2; ++k)
    {
        float off = theta - rel.y * pitch - spin - float(k) * 3.14159;
        float w = sin(off * 0.5) * norm;
        float d = (length(vec2(dr, w)) - 1.1) * 0.7;
        d = max(d, abs(rel.y) - 22.0);

        if (d < res.x)
        {
            res = vec2(d, MAT_STRAND);
            gA = float(k);
        }
    }

    // Glowing rungs between the strands, one per 5-unit cell.
    float ry = (floor(rel.y / 5.0) + 0.5) * 5.0;
    if (abs(ry) < 21.0)
    {
        float aa = ry * pitch + spin;
        vec3 a = vec3(cos(aa) * R, ry, sin(aa) * R);
        vec3 pa = rel - a;
        vec3 ba = vec3(-2.0 * cos(aa) * R, 0.0, -2.0 * sin(aa) * R);
        float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
        float dRung = length(pa - ba * h) - 0.45;

        // Cell-border safety for the y-repetition.
        float safe = 2.5 - abs(rel.y - ry) + 0.45;
        dRung = min(dRung, safe);

        if (dRung < res.x)
        {
            res = vec2(dRung, MAT_RUNG);
            gB = ry;
        }
    }

    return res;
}

// ===========================================================================
// GALAXY 10: clockwork galaxy (it ticks)
// ===========================================================================

float gearSDF(vec3 q, float R, float teeth, float spin)
{
    float rxz = length(q.xz);

    // Flat annular body with a hub.
    float body = max(rxz - R, abs(q.y) - 1.1);
    body = max(body, -(rxz - R * 0.30));
    float hub = max(rxz - R * 0.16, abs(q.y) - 1.6);
    body = min(body, hub);

    // Teeth: fold the angle into one sector and place a single box.
    float sector = 6.28318 / teeth;
    float a = atan(q.z, q.x) - spin;
    a = mod(a + sector * 0.5, sector) - sector * 0.5;
    vec3 tp = vec3(rxz * cos(a) - (R + 1.1), q.y, rxz * sin(a));
    float tooth = sdBox(tp, vec3(1.3, 0.9, sector * R * 0.20));

    return min(body, tooth);
}

vec2 gearGalaxy(vec3 p)
{
    vec3 rel = p - GEAR_POS;
    float bound = length(rel) - 46.0;
    if (bound > 1.0)
        return vec2(bound, MAT_GEAR);

    vec3 q = rotX(0.35) * rel; // the whole clockwork leans toward you

    // Escapement drive: the gears advance one tooth per tick, with a
    // snappy ease at the end of every beat.
    float u = uTime * 1.4;
    float tick = floor(u) + pow(smoothstep(0.55, 1.0, fract(u)), 2.0);
    float sA = tick * (6.28318 / 12.0);

    vec2 res = vec2(gearSDF(q, 13.0, 12.0, sA) * 0.85, MAT_GEAR);

    float g2 = gearSDF(q - vec3(23.5, 0.0, 0.0), 8.0, 8.0,
                       -sA * 1.5 + 0.39) * 0.85;
    if (g2 < res.x)
        res = vec2(g2, MAT_GEAR);

    // Pendulum star swinging beneath, one full swing per two ticks.
    float ang = sin(u * 3.14159) * 0.45;
    vec3 dir = vec3(sin(ang), -cos(ang), 0.0);
    vec3 pr = q - vec3(0.0, -1.0, 0.0);
    float along = clamp(dot(pr, dir), 0.0, 17.0);
    float rod = length(pr - dir * along) - 0.35;
    float bob = length(pr - dir * 17.0) - 2.4;
    float dp = min(rod, bob);
    if (dp < res.x)
        res = vec2(dp, MAT_PEND);

    gV = q;
    return res;
}

// ===========================================================================
// GALAXY 11: eye galaxy (it watches, it blinks)
// ===========================================================================

vec2 eyeGalaxy(vec3 p)
{
    vec3 rel = p - EYE_POS;
    float bound = length(rel) - 24.0;
    if (bound > 1.0)
        return vec2(bound, MAT_EYE);

    vec2 res = vec2(length(rel) - 16.0, MAT_EYE);

    // A quick blink at the start of every five-second cycle: an
    // eyelid shell sweeps down over the ball and back up.
    float f = fract(uTime / 5.0);
    float b = smoothstep(0.00, 0.06, f) * (1.0 - smoothstep(0.08, 0.16, f));
    float shell = abs(length(rel) - 16.9) - 0.9;
    float openH = (1.0 - 2.1 * b) * 16.9;
    float lid = max(shell, openH - rel.y);
    if (lid < res.x)
        res = vec2(lid, MAT_LID);

    gV = normalize(rel);
    return res;
}

// ===========================================================================
// GALAXY 12: harp galaxy (it plays itself)
// ===========================================================================

vec2 harpGalaxy(vec3 p)
{
    vec3 rel = p - HARP_POS;
    float bound = length(rel) - 40.0;
    if (bound > 1.0)
        return vec2(bound, MAT_STRING);

    // Seven strings, one per 6-unit cell along x; higher strings
    // vibrate in higher standing-wave modes, like a real chord.
    float id = clamp(floor(rel.x / 6.0 + 0.5), -3.0, 3.0);
    float lx = rel.x - id * 6.0;
    float m = abs(id) + 1.0;

    float wavePhase = uTime * (1.1 + 0.25 * m) + id * 1.7;
    float disp = (2.0 / m) * sin(rel.y * 0.131 * m) * sin(wavePhase);

    float dStr = (length(vec2(lx, rel.z - disp)) - 0.22) * 0.8;
    dStr = max(dStr, abs(rel.y) - 24.0);

    vec2 res = vec2(dStr, MAT_STRING);
    gA = id;

    // A pluck of light racing along each string.
    float by = mod(uTime * 9.0 + id * 11.0, 48.0) - 24.0;
    float bd = (2.0 / m) * sin(by * 0.131 * m) * sin(wavePhase);
    float dBead = length(vec3(lx, rel.y - by, rel.z - bd)) - 0.55;
    if (dBead < res.x)
        res = vec2(dBead, MAT_BEAD);

    // Cell-border safety so a neighbouring string is never skipped.
    if (abs(rel.x) < 20.5)
        res.x = min(res.x, 3.0 - abs(lx) + 0.4);

    // Golden frame bars top and bottom.
    float dBar = sdBox(vec3(rel.x, abs(rel.y) - 25.2, rel.z),
                       vec3(21.5, 1.1, 1.1)) - 0.2;
    if (dBar < res.x)
        res = vec2(dBar, MAT_FRAME);

    return res;
}

// ===========================================================================
// GALAXY 13: portal galaxy (a wormhole to somewhere else)
// ===========================================================================

vec2 portalGalaxy(vec3 p)
{
    vec3 rel = p - PORTAL_POS;
    float bound = length(rel) - 26.0;
    if (bound > 1.0)
        return vec2(bound, MAT_PORTRING);

    vec3 q = rotY(0.6) * rel; // angled back toward the cluster

    float ring = length(vec2(length(q.xy) - 18.0, q.z)) - 2.4;
    vec2 res = vec2(ring, MAT_PORTRING);

    // The membrane: a thin lens stretched across the ring.
    float rr = length(q.xy);
    float membrane = length(vec2(max(rr - 16.2, 0.0), q.z)) - 0.35;
    if (membrane < res.x)
        res = vec2(membrane, MAT_MEMBRANE);

    // Sparks riding the rim.
    for (int i = 0; i < 3; ++i)
    {
        float fi = float(i);
        float aa = uTime * (0.8 + fi * 0.25) + fi * 2.1;
        vec3 sp = vec3(cos(aa) * 18.0, sin(aa) * 18.0, 0.0);
        float ds = length(q - sp) - 0.8;
        if (ds < res.x)
            res = vec2(ds, MAT_BEAD);
    }

    gV = q;
    return res;
}

// ---------------------------------------------------------------------------
// Scene description: thirteen galaxies, one space
// ---------------------------------------------------------------------------

vec2 opU(vec2 a, vec2 b)
{
    return (a.x < b.x) ? a : b;
}

vec2 map(vec3 p)
{
    vec2 res = solarSystem(p);
    res = opU(res, blackHole(p));
    res = opU(res, crystalGalaxy(p));
    res = opU(res, jellyGalaxy(p));
    res = opU(res, donutGalaxy(p));
    res = opU(res, gridGalaxy(p));
    res = opU(res, vortexGalaxy(p));
    res = opU(res, butterflyGalaxy(p));
    res = opU(res, helixGalaxy(p));
    res = opU(res, gearGalaxy(p));
    res = opU(res, eyeGalaxy(p));
    res = opU(res, harpGalaxy(p));
    res = opU(res, portalGalaxy(p));
    return res;
}

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

vec3 skyColor(vec3 rd)
{
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
    if (h > 0.993)
    {
        float d = length(fract(g) - 0.5);
        float twinkle = 0.6 + 0.4 * sin(uTime * 2.0 + h * 90.0);
        col += vec3(0.9, 0.95, 1.0)
             * smoothstep(0.35, 0.0, d) * twinkle * 1.5;
    }

    return col;
}

vec3 missColor(vec3 rd)
{
    vec3 color = skyColor(rd);
    color += vec3(1.0, 0.75, 0.55) * exp(-0.25 * gClosest) * 0.6;
    return color;
}

// ---------------------------------------------------------------------------
// Surface shading
// ---------------------------------------------------------------------------

vec3 shade(vec3 ro, vec3 rd, float t, float mat)
{
    // Capture per-hit payload before further map() calls overwrite it.
    float A = gA;
    float B = gB;
    vec3 V = gV;

    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p, t);

    vec3 haze = mix(
        vec3(0.10, 0.04, 0.12),
        vec3(0.02, 0.03, 0.08),
        clamp(rd.y * 0.5 + 0.5, 0.0, 1.0)
    );

    int m = int(mat + 0.5);

    // ===== Solar system =====

    if (m == 0) // sun
    {
        float gran = fbm(V * 6.0 + vec3(uTime * 0.10));
        float limb = pow(clamp(dot(n, -rd), 0.0, 1.0), 0.6);
        vec3 c = mix(vec3(1.0, 0.30, 0.02), vec3(1.0, 0.85, 0.35), gran);
        return applyFog(c * (1.6 + 2.4 * limb), haze, t);
    }

    if (m <= 3) // planet, ring or moon: lit by the sun as a point light
    {
        int body = int(A + 0.5);
        vec3 qn = V;
        float lat = qn.y;

        vec3 toSun = SOLAR_POS - p;
        float dSun = length(toSun);
        vec3 L = toSun / dSun;
        float night = smoothstep(0.02, -0.06, dot(n, L));

        vec3 albedo = vec3(0.5);
        vec3 emissive = vec3(0.0);
        float specStrength = 0.1;

        if (m == 2) // ring
        {
            float bands = 0.55 + 0.45 * sin(B * 34.0);
            float gap = smoothstep(0.56, 0.62, B)
                      * (1.0 - smoothstep(0.66, 0.72, B));
            vec3 tint = (body == 6)
                ? vec3(0.55, 0.75, 0.85)
                : vec3(0.80, 0.70, 0.52);
            albedo = mix(tint, tint * 0.45, bands);
            albedo *= 1.0 - 0.75 * gap;
            specStrength = 0.2;
        }
        else if (m == 3) // moon
        {
            float crater = valueNoise(qn * 6.0 + 8.0);
            albedo = mix(vec3(0.30, 0.30, 0.32), vec3(0.55, 0.55, 0.58), crater);
            specStrength = 0.03;
        }
        else if (body == 0) // Mercury
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
        else if (body == 1) // Venus
        {
            float swirl = fbm(qn * 3.0 + vec3(uTime * 0.02, 0.0, 0.0) + 4.2);
            float bands = 0.5 + 0.5 * sin(lat * 9.0 + swirl * 5.0);
            albedo = mix(vec3(0.86, 0.72, 0.45), vec3(0.98, 0.90, 0.66), bands);
            float vein = abs(fbm(qn * 6.0 + 9.3) - 0.52);
            float lichen = smoothstep(0.035, 0.0, vein - 0.015);
            emissive += vec3(0.9, 0.55, 0.10) * lichen * 0.35;
            specStrength = 0.15;
        }
        else if (body == 2) // Earth
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
        else if (body == 3) // Mars
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
        else if (body == 4) // Jupiter
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
        else if (body == 5) // Saturn
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
        else if (body == 6) // Uranus
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
        float specular = uEnableSpecular
            ? pow(max(dot(n, halfway), 0.0), 64.0) * specStrength
            : 0.0;
        float shadowMax = max(dSun - SUN_RADIUS - 3.0, 1.0);
        float shadow = softShadow(p + n * 0.05, L, 0.1, shadowMax, 10.0);
        float ao = ambientOcclusion(p, n);

        vec3 color = vec3(0.0);
        color += albedo * sunColor * diffuse * shadow * atten * 1.6;
        color += sunColor * specular * shadow * atten;
        color += albedo * vec3(0.10, 0.08, 0.16) * ao * 1.6;
        color += emissive;

        return applyFog(color, haze, t);
    }

    // ===== Black hole =====

    if (m == 4) // horizon
    {
        float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 4.0);
        return vec3(0.15, 0.35, 0.9) * rim * 0.5;
    }

    if (m == 5) // accretion disk
    {
        float rr = length(V.xz);
        float th = atan(V.z, V.x);
        float heat = smoothstep(DISK_OUT, DISK_IN, rr);
        float omega = 22.0 / pow(rr, 1.5);
        float phase = th - uTime * omega;
        float streaks = fbm(vec3(cos(phase), sin(phase), rr * 0.18) * 3.0);
        float bright = 0.25 + 2.2 * streaks * streaks;
        vec3 col = mix(vec3(0.55, 0.06, 0.01), vec3(1.40, 1.15, 0.85),
                       pow(heat, 1.6));
        vec3 tang = rotX(-DISK_TILT) * vec3(-sin(th), 0.0, cos(th));
        float dop = 1.0 + 0.75 * heat * dot(tang, -rd);
        return col * bright * (0.5 + 2.5 * heat) * max(dop, 0.15);
    }

    if (m == 6) // comet
        return vec3(0.55, 0.85, 1.1) * (1.0 - A * 0.85) * 3.0;

    if (m == 7) // companion star
    {
        float gran = fbm(normalize(V) * vec3(7.0, 4.0, 7.0) + uTime * 0.15);
        float limb = pow(clamp(dot(n, -rd), 0.0, 1.0), 0.6);
        vec3 c = mix(vec3(1.0, 0.45, 0.10), vec3(1.0, 0.9, 0.55), gran);
        return c * (1.2 + 2.0 * limb);
    }

    if (m == 8) // gas stream
        return mix(vec3(1.0, 0.75, 0.40), vec3(1.2, 0.5, 0.15), A)
             * (0.8 + 1.6 * A);

    // ===== Crystal spiral =====

    if (m == 9) // core
    {
        float gran = fbm(p * 0.8 + uTime * 0.2);
        float limb = pow(clamp(dot(n, -rd), 0.0, 1.0), 0.5);
        vec3 c = mix(vec3(0.85, 0.60, 1.30), vec3(1.30, 1.20, 1.50), gran);
        return applyFog(c * (1.6 + 1.8 * limb), haze, t);
    }

    if (m == 10) // crystal shard
    {
        vec3 pal = cosinePalette(
            fract(A) * 0.8 + B * 0.004,
            vec3(1.0, 0.9, 1.0),
            vec3(0.00, 0.33, 0.67)
        );
        float pulse = 0.5 + 0.5 * sin(uTime * 2.0 - B * 0.30 + A * 3.0);
        float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 2.0);
        vec3 emissive = pal * (0.30 + 1.8 * pulse * pulse) * (0.6 + 1.4 * rim);
        vec3 L = normalize(CRYST_POS - p);
        float diffuse = max(dot(n, L), 0.0);
        float specular = uEnableSpecular
            ? pow(max(dot(n, normalize(L - rd)), 0.0), 96.0)
            : 0.0;
        vec3 color = emissive + pal * diffuse * 0.30
                   + vec3(0.95, 0.85, 1.1) * specular * 1.6;
        return applyFog(color, haze, t);
    }

    if (m == 11) // shepherd orb
        return applyFog(vec3(1.2, 1.15, 1.0) * 3.0, haze, t);

    // ===== Jellyfish bloom =====

    if (m == 15) // plankton mote
    {
        float tw = 0.5 + 0.5 * sin(uTime * 3.0 + hash13(V) * 40.0);
        return applyFog(vec3(0.45, 0.95, 0.95) * (0.8 + 1.6 * tw), haze, t);
    }

    if (m >= 12 && m <= 14) // jelly parts
    {
        vec3 pal = cosinePalette(
            A * 0.13 + 0.05,
            vec3(0.9, 0.8, 1.0),
            vec3(0.00, 0.30, 0.60)
        );
        float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 2.5);
        vec3 emissive;

        if (m == 12) // bell
        {
            float spots = smoothstep(0.66, 0.78, valueNoise(V * 6.0 + A * 9.0));
            float beat = 0.5 + 0.5 * sin(uTime * 2.0 + A * 3.0);
            emissive = pal * (rim * 2.2 + spots * beat * 1.4 + 0.15);
        }
        else if (m == 13) // tentacle
        {
            float tip = clamp(V.z, 0.0, 1.0);
            emissive = pal * (0.25 + 1.6 * tip * tip)
                     + vec3(0.1, 0.2, 0.3) * rim;
        }
        else // organ
        {
            float beat = 0.6 + 0.4 * sin(uTime * 2.4 + A * 3.0);
            emissive = pal * 2.0 * beat + vec3(0.8, 0.9, 1.0) * 0.8;
        }

        vec3 L = normalize(vec3(0.3, 0.8, -0.5));
        float diffuse = max(dot(n, L), 0.0);
        vec3 color = emissive
                   + pal * 0.15 * vec3(0.5, 0.7, 1.0) * diffuse * 0.5;
        return applyFog(color, haze, t);
    }

    // ===== Donut galaxy =====

    if (m == 16) // the donut itself
    {
        float u = atan(V.z, V.x);
        float v = atan(V.y, length(V.xz) - 24.0);

        // Dough below, pink frosting on top, drifting slowly.
        float frost = smoothstep(-0.2, 0.3, sin(v + 0.4)
                    + 0.3 * sin(u * 5.0 + uTime * 0.2));
        vec3 col = mix(vec3(0.55, 0.30, 0.10), vec3(1.0, 0.35, 0.55), frost);

        // Sprinkles: glowing candy dashes scattered over the frosting.
        float sp = valueNoise(vec3(u * 8.0, v * 4.0, 1.0));
        float sprinkle = step(0.80, sp) * frost;
        vec3 spCol = cosinePalette(sp * 13.7, vec3(1.0), vec3(0.0, 0.33, 0.67));
        col = mix(col, spCol * 1.5, sprinkle);

        // Star-dough glow, swirling around the ring.
        float flow = fbm(vec3(cos(u + uTime * 0.15),
                              sin(u + uTime * 0.15), v * 1.5) * 2.0);
        float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 2.0);
        return applyFog(col * (0.5 + 1.4 * flow) + col * rim * 0.8, haze, t);
    }

    if (m == 17) // white dwarf in the hole
    {
        float limb = pow(clamp(dot(n, -rd), 0.0, 1.0), 0.5);
        return vec3(1.1, 1.05, 0.95) * (1.5 + 2.0 * limb);
    }

    // ===== Grid galaxy =====

    if (m == 18)
    {
        // Alternating neon cubes, pulsing with a scanline sweep.
        vec3 pal = (mod(V.x + V.y + V.z, 2.0) < 1.0)
            ? vec3(0.10, 0.90, 0.95)
            : vec3(0.95, 0.15, 0.85);
        float beat = 0.5 + 0.5 * sin(uTime * 1.5 + A * 6.28);
        float scan = pow(0.5 + 0.5 * sin(p.y * 0.6 - uTime * 2.0), 4.0);
        float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 2.0);
        vec3 color = pal * (0.4 + 1.2 * beat + 1.6 * scan) + pal * rim * 1.2;
        return applyFog(color, haze, t);
    }

    // ===== Vortex galaxy =====

    if (m == 19)
    {
        float th = atan(V.z, V.x);
        float bot = smoothstep(20.0, -20.0, V.y);
        float phase = th * 3.0 + V.y * 0.5
                    - uTime * (3.0 + (20.0 - V.y) * 0.15);
        float streak = pow(0.5 + 0.5 * sin(phase), 3.0);
        vec3 col = mix(vec3(0.30, 0.10, 0.55), vec3(1.3, 0.9, 0.35), bot);
        return applyFog(col * (0.3 + 2.2 * streak) * (0.5 + bot * 1.5), haze, t);
    }

    if (m == 20) // debris boulder heating up as it falls
    {
        float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 2.0);
        vec3 col = mix(vec3(0.35, 0.28, 0.24), vec3(1.2, 0.6, 0.15), A);
        return applyFog(col * (0.4 + A * 1.6) + col * rim, haze, t);
    }

    // ===== Butterfly nebula =====

    if (m == 21) // wings
    {
        // Concentric vein rings around each wing's focus, eye-spots,
        // and a slight hue shift between the two wings.
        vec2 w = V.xy - vec2(9.0, 2.0);
        float rr = length(w);
        float veins = pow(0.5 + 0.5 * sin(rr * 2.2 - uTime * 0.5), 3.0);
        vec3 pal = cosinePalette(
            rr * 0.05 + A * 0.04 + 0.55,
            vec3(0.9, 0.8, 1.0),
            vec3(0.00, 0.30, 0.60)
        );
        float eye = smoothstep(2.2, 1.2, length(V.xy - vec2(11.0, 4.5)));
        vec3 col = pal * (0.35 + 1.5 * veins);
        col = mix(col, vec3(1.2, 0.9, 0.25), eye * 0.9);
        float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 2.0);
        return applyFog(col + pal * rim * 1.2, haze, t);
    }

    if (m == 22) // body
    {
        float beat = 0.6 + 0.4 * sin(uTime * 1.6);
        return applyFog(vec3(1.1, 1.0, 0.85) * (1.2 + beat), haze, t);
    }

    // ===== Helix galaxy =====

    if (m == 23) // strand
    {
        vec3 pal = (A < 0.5)
            ? vec3(0.20, 0.95, 0.70)
            : vec3(0.85, 0.30, 0.95);
        float wave = 0.5 + 0.5 * sin(p.y * 0.8 - uTime * 2.5);
        float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 2.0);
        return applyFog(pal * (0.5 + 1.5 * wave) + pal * rim * 1.0, haze, t);
    }

    if (m == 24) // helix rung: light pulses travel up the ladder
    {
        float pulse = pow(0.5 + 0.5 * sin(B * 0.5 - uTime * 3.0), 3.0);
        return applyFog(vec3(0.9, 1.0, 0.95) * (0.6 + 2.2 * pulse), haze, t);
    }

    // ===== Clockwork galaxy =====

    if (m == 25) // gears: old brass, flashing on every tick
    {
        float rxz = length(V.xz);
        float bands = 0.5 + 0.5 * sin(rxz * 2.0);
        vec3 col = mix(vec3(0.45, 0.30, 0.10), vec3(1.0, 0.75, 0.25), bands);
        float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 2.0);
        float flash = pow(smoothstep(0.55, 1.0, fract(uTime * 1.4)), 2.0);
        return applyFog(col * (0.5 + 0.8 * flash) + col * rim * 1.3, haze, t);
    }

    if (m == 26) // pendulum star: glows brightest mid-swing
    {
        float speedGlow = abs(cos(uTime * 1.4 * 3.14159));
        return applyFog(
            vec3(1.2, 0.95, 0.55) * (1.0 + 2.0 * speedGlow), haze, t);
    }

    // ===== Eye galaxy =====

    if (m == 27) // the eye itself
    {
        vec3 qn = V;
        vec3 gaze = normalize(vec3(
            0.55 * sin(uTime * 0.23),
            0.35 * sin(uTime * 0.17 + 1.0),
            -1.0
        ));
        float ca = dot(qn, gaze);

        // Iris frame for the radial streaks.
        vec3 uu = normalize(cross(gaze, vec3(0.0, 1.0, 0.0)));
        vec3 vv = cross(uu, gaze);
        float iAng = atan(dot(qn, vv), dot(qn, uu));

        float iris = smoothstep(0.845, 0.865, ca);
        float pupil = smoothstep(0.955, 0.968, ca);
        float streaks = 0.5 + 0.5 * sin(iAng * 26.0 + fbm(qn * 5.0) * 4.0);

        // Bloodshot sclera.
        vec3 scler = vec3(0.85, 0.83, 0.80);
        float veins = smoothstep(0.06, 0.0, abs(fbm(qn * 6.0 + 3.0) - 0.5) - 0.02);
        scler = mix(scler, vec3(0.70, 0.15, 0.12), veins * (1.0 - iris) * 0.6);

        vec3 irisCol = cosinePalette(
            0.55 + streaks * 0.10,
            vec3(0.8, 0.9, 1.0),
            vec3(0.00, 0.33, 0.67)
        ) * (0.6 + 0.8 * streaks);

        vec3 col = mix(scler, irisCol, iris);
        col = mix(col, vec3(0.01), pupil);

        // Wet glint and soft shaping light.
        vec3 L = normalize(vec3(0.4, 0.7, -0.6));
        float spec = pow(max(dot(reflect(rd, n), L), 0.0), 60.0);
        col = col * (0.55 + 0.6 * max(dot(n, L), 0.0))
            + irisCol * iris * 0.5
            + vec3(1.0) * spec * 1.5;

        return applyFog(col, haze, t);
    }

    if (m == 28) // eyelid
    {
        vec3 L = normalize(vec3(0.4, 0.7, -0.6));
        float diffuse = max(dot(n, L), 0.0);
        float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 2.0);
        vec3 col = vec3(0.25, 0.12, 0.30) * (0.4 + 0.6 * diffuse)
                 + vec3(0.5, 0.2, 0.6) * rim;
        return applyFog(col, haze, t);
    }

    // ===== Harp galaxy =====

    if (m == 29) // strings: each its own color, glowing as it swings
    {
        float mMode = abs(A) + 1.0;
        float swing = sin(uTime * (1.1 + 0.25 * mMode) + A * 1.7);
        vec3 pal = cosinePalette(
            A * 0.14 + 0.10,
            vec3(0.9, 0.9, 1.0),
            vec3(0.00, 0.33, 0.67)
        );
        return applyFog(pal * (0.6 + 1.8 * swing * swing), haze, t);
    }

    if (m == 30) // pluck bead / portal spark
        return applyFog(vec3(1.2, 1.15, 1.0) * 3.2, haze, t);

    if (m == 31) // harp frame: warm gold
    {
        float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 2.0);
        float bands = 0.5 + 0.5 * sin(p.x * 1.2);
        vec3 col = mix(vec3(0.55, 0.38, 0.12), vec3(1.0, 0.80, 0.30), bands);
        return applyFog(col * 0.7 + col * rim * 1.4, haze, t);
    }

    // ===== Portal galaxy =====

    if (m == 32) // braided ring
    {
        float u = atan(V.y, V.x);
        float stripes = 0.5 + 0.5 * sin(u * 24.0 - uTime * 3.0);
        vec3 col = mix(vec3(0.10, 0.80, 0.85), vec3(0.95, 0.95, 1.0), stripes);
        float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 2.0);
        return applyFog(col * (0.6 + 1.2 * stripes) + col * rim, haze, t);
    }

    // MAT_MEMBRANE: the swirling elsewhere behind the lens.
    {
        float ang = atan(V.y, V.x);
        float rr = length(V.xy);
        float sw = fbm(vec3(
            cos(ang - rr * 0.30 + uTime * 0.6),
            sin(ang - rr * 0.30 + uTime * 0.6),
            rr * 0.15
        ) * 2.2);
        vec3 col = cosinePalette(
            sw * 0.6 + rr * 0.02 - uTime * 0.03,
            vec3(1.0, 0.9, 1.0),
            vec3(0.00, 0.33, 0.67)
        );
        float center = exp(-rr * 0.15);
        return applyFog(col * (0.5 + 1.6 * sw) + vec3(1.1) * center * 2.0,
                        haze, t);
    }
}
