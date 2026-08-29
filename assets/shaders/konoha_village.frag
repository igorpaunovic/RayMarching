#version 330 core

// Hidden-leaf village: an homage to Konoha from Naruto. A huge cliff
// looms over the village with four stone faces carved into it
// (Hokage-Rock style), a red multi-tier tower stands at the plaza, a
// dirt road runs from the village gate to the tower, and dozens of
// varied round and boxy houses fill the space between, with forest
// all around. Tall pagoda temples rise above the rooftops and a
// crenellated stone rampart rings the village, opening at the main
// gate and running into the cliff. Bright daylight, drifting clouds,
// soft shadows.

#define MAX_STEPS      200
#define MAX_DISTANCE   420.0
#define HIT_EPSILON    0.0008
#define STEP_SCALE     0.7
#define NORMAL_EPSILON 0.0008
#define FOG_DENSITY    0.0035
#define SHADOW_STEPS   32
#define SHADOW_STEP_MIN 0.02
#define SHADOW_STEP_MAX 1.5
#define AO_STEP        0.10
#define AO_STRENGTH    2.0
#define AO_FALLOFF     0.65
#define EXPOSURE       1.1

#include "worldlib.glsl"

// Material IDs
const float MAT_GROUND = 0.0;
const float MAT_ROCK   = 1.0;
const float MAT_FACE   = 2.0;
const float MAT_WALL   = 3.0;
const float MAT_ROOF   = 4.0;
const float MAT_TOWER  = 5.0;
const float MAT_TRIM   = 6.0;
const float MAT_TRUNK  = 7.0;
const float MAT_LEAF   = 8.0;
const float MAT_GATE   = 9.0;
const float MAT_STONE  = 10.0;

const vec3 SUN_DIR = normalize(vec3(0.45, 0.65, -0.60));

// Per-cell house variation, written by map() and captured by shade()
// before further map() calls overwrite it.
float gHouseTint = 0.0;

// ---------------------------------------------------------------------------
// Utilities and SDF primitives
// ---------------------------------------------------------------------------

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

float sdBox(vec3 p, vec3 b)
{
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdRoundBox(vec3 p, vec3 b, float r)
{
    return sdBox(p, b) - r;
}

float sdCappedCylinder(vec3 p, float r, float halfH)
{
    vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, halfH);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

// Capped cone, centered, halfH half-height, r1 bottom / r2 top radius.
float sdCappedCone(vec3 p, float halfH, float r1, float r2)
{
    vec2 q = vec2(length(p.xz), p.y);
    vec2 k1 = vec2(r2, halfH);
    vec2 k2 = vec2(r2 - r1, 2.0 * halfH);
    vec2 ca = vec2(q.x - min(q.x, (q.y < 0.0) ? r1 : r2), abs(q.y) - halfH);
    vec2 cb = q - k1 + k2 * clamp(dot(k1 - q, k2) / dot(k2, k2), 0.0, 1.0);
    float s = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;
    return s * sqrt(min(dot(ca, ca), dot(cb, cb)));
}

float sdEllipsoid(vec3 p, vec3 r)
{
    float k0 = length(p / r);
    float k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / k1;
}

float sdCapsuleY(vec3 p, float h, float r)
{
    p.y -= clamp(p.y, 0.0, h);
    return length(p) - r;
}

float smin(float a, float b, float k)
{
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

// ---------------------------------------------------------------------------
// The monument cliff with carved faces
// ---------------------------------------------------------------------------

// One stylized stone face. The skull is a cranium blended into a
// narrower jaw mass; the brow overhangs deep carved eye sockets with
// closed stone lids inside, the nose has a bridge, tip and nostril
// wings, and the mouth groove sits between a lower lip and a strong
// chin. The variant parameter varies width, nose and hair so the four
// founders don't look identical.
float faceSDF(vec3 q, float v)
{
    float widthF = 0.85 + 0.10 * sin(v * 2.1);
    float noseF  = 0.85 + 0.30 * fract(v * 0.317 + 0.13);

    // Cranium blended into a narrower jaw mass, so the head tapers
    // toward the chin instead of reading as an egg.
    float d = sdEllipsoid(q - vec3(0.0, 1.5, 0.0), vec3(6.3 * widthF, 6.6, 5.2));
    d = smin(d, sdEllipsoid(
        q - vec3(0.0, -4.2, -0.8), vec3(4.6 * widthF, 4.4, 4.4)), 1.5);

    // Brow ridge, pushed forward so the eyes sit in its shadow.
    d = smin(d, sdRoundBox(
        q - vec3(0.0, 1.9, -4.6),
        vec3(3.4 * widthF, 0.5, 0.9),
        0.45
    ), 0.6);

    // Cheekbones give the mid-face its planes.
    d = smin(d, sdEllipsoid(
        vec3(abs(q.x) - 3.0 * widthF, q.y + 1.6, q.z + 3.7),
        vec3(1.7, 2.0, 1.5)), 0.9);

    // Deep eye sockets carved under the brow...
    vec3 eq = vec3(abs(q.x) - 2.5 * widthF, q.y - 0.6, q.z + 4.9);
    d = max(d, -sdEllipsoid(eq, vec3(1.75, 1.15, 1.4)));

    // ...with closed stone lids resting inside them...
    d = smin(d, sdEllipsoid(
        eq - vec3(0.0, -0.05, -0.35), vec3(1.3, 0.62, 0.85)), 0.3);

    // ...and a lash-line groove across each lid.
    d = max(d, -sdRoundBox(
        eq - vec3(0.0, -0.05, -0.75), vec3(1.05, 0.10, 0.55), 0.08));

    // Nose: bridge descending from the brow, rounded tip, nostril wings.
    float nose = sdRoundBox(
        q - vec3(0.0, 0.6, -4.9), vec3(0.55 * noseF, 1.7, 0.65), 0.3);
    nose = smin(nose, sdEllipsoid(
        q - vec3(0.0, -1.9, -5.3), vec3(1.05 * noseF, 1.0, 1.0)), 0.5);
    nose = smin(nose, sdEllipsoid(
        vec3(abs(q.x) - 1.15 * noseF, q.y + 2.2, q.z + 4.8),
        vec3(0.55, 0.5, 0.6)), 0.35);
    d = smin(d, nose, 0.45);

    // Mouth groove between a lower lip and a strong chin.
    d = max(d, -sdRoundBox(
        q - vec3(0.0, -4.1, -4.35), vec3(1.6 * widthF, 0.13, 1.0), 0.12));
    d = smin(d, sdEllipsoid(
        q - vec3(0.0, -4.9, -4.4), vec3(1.5 * widthF, 0.55, 0.9)), 0.4);
    d = smin(d, sdEllipsoid(
        q - vec3(0.0, -6.4, -3.2), vec3(2.0, 1.4, 1.5)), 0.8);

    // Ears.
    d = smin(d, sdEllipsoid(
        vec3(abs(q.x) - 6.0 * widthF, q.y + 0.9, q.z - 0.2),
        vec3(0.9, 1.9, 1.2)), 0.6);

    // Hair crown: a jagged cap whose spike frequency and sharpness
    // differ per face; the first face also gets long side hair.
    vec3 hq = q - vec3(0.0, 6.2, 1.0);
    float spikes = abs(fract(q.x * (0.35 + 0.10 * v)) - 0.5);
    float hair = sdEllipsoid(hq, vec3(7.4 * widthF, 3.8, 5.8))
               + spikes * (0.5 + 0.5 * fract(v * 0.73));
    d = smin(d, hair, 1.0);

    if (v < 0.5)
    {
        float side = sdRoundBox(
            vec3(abs(q.x) - 6.2 * widthF, q.y + 1.0, q.z - 0.5),
            vec3(0.9, 6.0, 3.2),
            0.6
        );
        d = smin(d, side, 1.0);
    }

    return d;
}

vec2 monument(vec3 p)
{
    // Cheap bound around the whole cliff so distant rays skip it.
    float bound = sdBox(p - vec3(0.0, 30.0, 152.0), vec3(140.0, 34.0, 30.0));
    if (bound > 3.0)
        return vec2(bound, MAT_ROCK);

    // The cliff itself: a giant rounded slab with craggy noise.
    vec3 q = p - vec3(0.0, 26.0, 152.0);
    float rock = sdRoundBox(q, vec3(128.0, 26.0, 18.0), 6.0);
    rock += (valueNoise(p * 0.25) - 0.5) * 1.6;

    vec2 res = vec2(rock, MAT_ROCK);

    // Four faces along the front, protruding from the rock.
    for (int i = 0; i < 4; ++i)
    {
        float fx = (float(i) - 1.5) * 26.0;
        vec3 f = p - vec3(fx, 30.0, 134.0);

        // A face can only win if its bounding sphere beats the rock.
        if (length(f) - 12.0 < res.x)
        {
            float fd = faceSDF(f, float(i));
            if (fd < res.x)
                res = vec2(fd, MAT_FACE);
        }
    }

    return res;
}

// ---------------------------------------------------------------------------
// Hokage tower, gate, houses and forest
// ---------------------------------------------------------------------------

vec2 tower(vec3 p)
{
    vec3 q = p - vec3(0.0, 0.0, 100.0);

    float bound = length(q - vec3(0.0, 13.0, 0.0)) - 22.0;
    if (bound > 2.0)
        return vec2(bound, MAT_TOWER);

    // Two red drums with pale eave discs, a dome and a spire.
    vec2 res = vec2(
        sdCappedCylinder(q - vec3(0.0, 7.0, 0.0), 10.0, 7.0),
        MAT_TOWER
    );

    float disc1 = sdCappedCylinder(q - vec3(0.0, 14.4, 0.0), 11.2, 0.6);
    if (disc1 < res.x) res = vec2(disc1, MAT_TRIM);

    float tier2 = sdCappedCylinder(q - vec3(0.0, 18.2, 0.0), 7.0, 3.4);
    if (tier2 < res.x) res = vec2(tier2, MAT_TOWER);

    float disc2 = sdCappedCylinder(q - vec3(0.0, 21.9, 0.0), 8.0, 0.5);
    if (disc2 < res.x) res = vec2(disc2, MAT_TRIM);

    float dome = length(q - vec3(0.0, 22.0, 0.0)) - 5.2;
    dome = max(dome, 22.0 - q.y);
    if (dome < res.x) res = vec2(dome, MAT_TOWER);

    float spire = sdCappedCylinder(q - vec3(0.0, 28.8, 0.0), 0.35, 2.0);
    if (spire < res.x) res = vec2(spire, MAT_TRIM);

    return res;
}

vec2 gate(vec3 p)
{
    vec3 q = p - vec3(0.0, 0.0, 16.0);

    float bound = sdBox(q - vec3(0.0, 6.0, 0.0), vec3(13.0, 8.0, 3.0));
    if (bound > 1.0)
        return vec2(bound, MAT_GATE);

    float pillars = sdBox(
        vec3(abs(q.x) - 8.0, q.y - 5.0, q.z),
        vec3(0.9, 5.0, 0.9)
    );
    float beam = sdRoundBox(q - vec3(0.0, 10.3, 0.0), vec3(10.5, 0.7, 1.2), 0.2);

    return vec2(min(pillars, beam), MAT_GATE);
}

// A grand pagoda temple: a stepped stone plinth, five shrinking red
// drums each crowned by a wide flared eave, and a dome with a finial
// spire on top. The scale parameter sizes the whole temple; at
// scale 1.3 it rises well above the Hokage tower.
vec2 pagodaTemple(vec3 p, vec3 pos, float s)
{
    vec3 q = p - pos;

    float bound = length(q - vec3(0.0, 20.0 * s, 0.0)) - 27.0 * s;
    if (bound > 2.0)
        return vec2(bound, MAT_TOWER);

    // Stepped stone plinth.
    vec2 res = vec2(
        sdCappedCylinder(q - vec3(0.0, 0.7 * s, 0.0), 13.0 * s, 0.7 * s),
        MAT_STONE
    );
    float step2 = sdCappedCylinder(q - vec3(0.0, 1.8 * s, 0.0), 10.8 * s, 0.5 * s);
    if (step2 < res.x) res = vec2(step2, MAT_STONE);

    // Tiers: shrinking drums, each crowned with a wide flared eave.
    float y = 2.3 * s;
    float r = 8.2 * s;
    for (int i = 0; i < 5; ++i)
    {
        float th = (6.2 - 0.9 * float(i)) * s;

        float body = sdCappedCylinder(q - vec3(0.0, y + th * 0.5, 0.0), r, th * 0.5);
        if (body < res.x) res = vec2(body, MAT_TOWER);

        float eave = sdCappedCone(
            q - vec3(0.0, y + th + 0.55 * s, 0.0),
            0.8 * s, r + 2.4 * s, r * 0.5);
        if (eave < res.x) res = vec2(eave, MAT_ROOF);

        y += th + 1.1 * s;
        r *= 0.80;
    }

    // Crown: dome, spire and finial orb.
    float dome = length(q - vec3(0.0, y, 0.0)) - r * 1.15;
    dome = max(dome, y - q.y);
    if (dome < res.x) res = vec2(dome, MAT_ROOF);

    float spire = sdCappedCylinder(
        q - vec3(0.0, y + r + 2.6 * s, 0.0), 0.32 * s, 2.8 * s);
    if (spire < res.x) res = vec2(spire, MAT_TRIM);

    float orb = length(q - vec3(0.0, y + r + 5.6 * s, 0.0)) - 0.8 * s;
    if (orb < res.x) res = vec2(orb, MAT_TRIM);

    // Temple eaves always read as weathered teal (tint 0.2 selects the
    // teal branch of the MAT_ROOF palette in shade()).
    if (res.y == MAT_ROOF) gHouseTint = 0.2;

    return res;
}

// Perimeter rampart: a rectangular ring of stone wall with merlons on
// top and a battered base, opening at the main gate on the front side
// and running into the cliff at the back.
vec2 walls(vec3 p)
{
    vec2 q = abs(p.xz - vec2(0.0, 72.0)) - vec2(86.0, 58.0);
    float ring = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);

    // Cheap reject; a valid lower bound for everything built below.
    if (abs(ring) - 2.6 > 2.0)
        return vec2(abs(ring) - 2.6, MAT_STONE);

    // Merlons alternate along whichever axis the wall runs.
    float along = (q.x > q.y) ? p.z : p.x;
    float top = 7.0 + 1.3 * step(0.5, fract(along * 0.09));

    float d = max(abs(ring) - 1.3, p.y - top);

    // Battered base.
    float base = max(abs(ring) - 2.6, p.y - 1.8);
    d = min(d, base);

    // Opening for the main gate on the front wall.
    float opening = sdBox(p - vec3(0.0, 4.6, 14.0), vec3(7.6, 5.2, 6.0));
    d = max(d, -opening);

    return vec2(d, MAT_STONE);
}

// Village houses on a jittered grid. Each cell hashes its own house:
// round with a cone roof or boxy with a hipped roof, varied heights,
// radii and colors. Cells on the road, near the tower/plaza or at the
// village edge stay empty.
const float HOUSE_CELL = 12.0;

vec2 houses(vec3 p)
{
    // Bounding slab over the whole village district.
    float slab = sdBox(p - vec3(0.0, 6.0, 65.0), vec3(82.0, 7.0, 54.0));
    if (slab > 2.0)
        return vec2(slab, MAT_WALL);

    vec2 cell = floor(p.xz / HOUSE_CELL);
    vec2 local = p.xz - (cell + 0.5) * HOUSE_CELL;

    // Distance to the cell wall bounds how close a neighbouring cell's
    // house can be; min-ing with it keeps the repeated DE safe.
    float edge = HOUSE_CELL * 0.5 - max(abs(local.x), abs(local.y));
    float safe = edge + 1.0;

    float h1 = hash13(vec3(cell, 7.7));
    float h2 = hash13(vec3(cell, 21.3));
    float h3 = hash13(vec3(cell, 55.1));

    vec2 cellCenter = (cell + 0.5) * HOUSE_CELL;
    bool onRoad = abs(cellCenter.x) < 7.0 && cellCenter.y < 96.0;
    bool nearTower = length(cellCenter - vec2(0.0, 100.0)) < 18.0;
    bool nearTemple =
        length(cellCenter - vec2(-52.0, 106.0)) < 23.0 ||
        length(cellCenter - vec2( 54.0,  84.0)) < 19.0 ||
        length(cellCenter - vec2( 30.0,  36.0)) < 16.0;
    bool outside =
        abs(cellCenter.x) > 76.0 || cellCenter.y < 18.0 || cellCenter.y > 114.0;

    if (h1 > 0.86 || onRoad || nearTower || nearTemple || outside)
        return vec2(safe, MAT_WALL);

    vec3 q = vec3(
        local.x - (h2 - 0.5) * 2.0,
        p.y,
        local.y - (h3 - 0.5) * 2.0
    );

    float bh = 3.0 + h2 * 5.0; // body height
    float br = 2.0 + h3 * 1.3; // body radius

    float body;
    float roof;
    if (h1 < 0.55)
    {
        // Konoha's signature round houses.
        body = sdCappedCylinder(q - vec3(0.0, bh * 0.5, 0.0), br, bh * 0.5);
        roof = sdCappedCone(q - vec3(0.0, bh + 1.1, 0.0), 1.1, br + 0.6, 0.2);
    }
    else
    {
        body = sdBox(q - vec3(0.0, bh * 0.5, 0.0), vec3(br, bh * 0.5, br * 0.9));
        roof = sdCappedCone(q - vec3(0.0, bh + 1.0, 0.0), 1.0, br * 1.25, 0.25);
    }

    gHouseTint = h1 * 13.7 + h2;

    vec2 res = (roof < body)
        ? vec2(roof, MAT_ROOF)
        : vec2(body, MAT_WALL);
    res.x = min(res.x, safe);

    return res;
}

// Forest ring around the village: simple trunk + canopy trees on a
// jittered grid, skipped inside the village footprint.
const float TREE_CELL = 9.0;

vec2 trees(vec3 p)
{
    float slab = sdBox(p - vec3(0.0, 5.0, 38.0), vec3(150.0, 6.0, 96.0));
    if (slab > 2.0)
        return vec2(slab, MAT_LEAF);

    vec2 cell = floor(p.xz / TREE_CELL);
    vec2 local = p.xz - (cell + 0.5) * TREE_CELL;

    float edge = TREE_CELL * 0.5 - max(abs(local.x), abs(local.y));
    float safe = edge + 0.8;

    float h1 = hash13(vec3(cell, 3.1));
    float h2 = hash13(vec3(cell, 9.4));
    float h3 = hash13(vec3(cell, 27.9));

    vec2 cellCenter = (cell + 0.5) * TREE_CELL;
    // Widened past the rampart footprint so trees don't grow into it.
    bool inVillage =
        abs(cellCenter.x) < 92.0 && cellCenter.y > 6.0 && cellCenter.y < 124.0;
    bool onCliff = cellCenter.y > 124.0;
    bool onRoad = abs(cellCenter.x) < 7.0;

    if (h1 > 0.7 || inVillage || onCliff || onRoad)
        return vec2(safe, MAT_LEAF);

    vec3 q = vec3(
        local.x - (h2 - 0.5) * 2.0,
        p.y,
        local.y - (h3 - 0.5) * 2.0
    );

    float th = 2.5 + h2 * 2.5; // trunk height
    float cr = 1.8 + h3 * 0.8; // canopy radius

    float trunk = sdCapsuleY(q, th, 0.35);
    float canopy = min(
        length(q - vec3(0.0, th + cr * 0.7, 0.0)) - cr,
        length(q - vec3(0.4, th + cr * 1.5, 0.2)) - cr * 0.7
    );

    vec2 res = (canopy < trunk)
        ? vec2(canopy, MAT_LEAF)
        : vec2(trunk, MAT_TRUNK);
    res.x = min(res.x, safe);

    return res;
}

// ---------------------------------------------------------------------------
// Scene description
// ---------------------------------------------------------------------------

vec2 map(vec3 p)
{
    vec2 scene = vec2(p.y, MAT_GROUND);

    scene = opUnion(scene, monument(p));
    scene = opUnion(scene, tower(p));
    scene = opUnion(scene, gate(p));
    scene = opUnion(scene, walls(p));
    scene = opUnion(scene, pagodaTemple(p, vec3(-52.0, 0.0, 106.0), 1.3));
    scene = opUnion(scene, pagodaTemple(p, vec3( 54.0, 0.0,  84.0), 1.0));
    scene = opUnion(scene, pagodaTemple(p, vec3( 30.0, 0.0,  36.0), 0.75));
    scene = opUnion(scene, houses(p));
    scene = opUnion(scene, trees(p));

    return scene;
}

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

vec3 skyColor(vec3 rd)
{
    float h = clamp(rd.y, 0.0, 1.0);
    vec3 col = mix(vec3(0.65, 0.80, 0.95), vec3(0.18, 0.42, 0.85), h);

    float s = clamp(dot(rd, SUN_DIR), 0.0, 1.0);
    col += vec3(1.0, 0.85, 0.60) * pow(s, 400.0) * 3.0;
    col += vec3(1.0, 0.75, 0.50) * pow(s, 8.0) * 0.12;

    // Drifting cumulus: fbm sampled on a projected sky plane.
    if (rd.y > 0.02)
    {
        vec2 uv = rd.xz / rd.y * 1.6 + vec2(uTime * 0.008, 0.0);
        float n = fbm(vec3(uv * 0.35, 3.7));
        float cloud = smoothstep(0.52, 0.72, n);
        float fade = smoothstep(0.02, 0.18, rd.y);
        col = mix(col, vec3(1.0), cloud * fade * 0.85);
    }

    return col;
}

vec3 missColor(vec3 rd)
{
    return skyColor(rd);
}

// ---------------------------------------------------------------------------
// Surface shading
// ---------------------------------------------------------------------------

vec3 shade(vec3 ro, vec3 rd, float t, float mat)
{
    // Capture per-hit globals before normals/shadows/AO overwrite them.
    float tint = gHouseTint;

    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p, t);

    int m = int(mat + 0.5);
    vec3 albedo = vec3(0.5);
    float specStrength = 0.15;

    if (m == 0) // ground: grass outside, packed earth inside, dirt road
    {
        float noise = valueNoise(p * 0.35);
        bool road = abs(p.x) < 4.5 && p.z > -30.0 && p.z < 88.0;
        bool plaza = length(p.xz - vec2(0.0, 100.0)) < 16.0;
        bool inVillage = abs(p.x) < 80.0 && p.z > 12.0 && p.z < 118.0;

        if (road || plaza)
            albedo = mix(vec3(0.55, 0.47, 0.35), vec3(0.63, 0.55, 0.41), noise);
        else if (inVillage)
            albedo = mix(vec3(0.45, 0.42, 0.32), vec3(0.52, 0.47, 0.36), noise);
        else
            albedo = mix(vec3(0.20, 0.34, 0.14), vec3(0.28, 0.42, 0.18), noise);
        specStrength = 0.0;
    }
    else if (m == 1) // cliff rock
    {
        float noise = valueNoise(p * 0.6);
        albedo = mix(vec3(0.38, 0.33, 0.28), vec3(0.50, 0.44, 0.36), noise);
        specStrength = 0.05;
    }
    else if (m == 2) // carved faces: cleaner, lighter stone
    {
        albedo = vec3(0.58, 0.52, 0.44);
        specStrength = 0.05;
    }
    else if (m == 3) // house walls: pastel plaster variations
    {
        float v = fract(tint);
        albedo = mix(
            vec3(0.85, 0.78, 0.62),           // cream
            (v < 0.5)
                ? vec3(0.75, 0.62, 0.50)      // tan
                : vec3(0.66, 0.74, 0.62),     // pale green
            smoothstep(0.2, 0.8, fract(v * 3.7))
        );
        specStrength = 0.05;
    }
    else if (m == 4) // roofs: red, teal or orange like the anime skyline
    {
        float v = fract(tint * 2.3);
        if (v < 0.40)
            albedo = vec3(0.62, 0.16, 0.12); // red
        else if (v < 0.70)
            albedo = vec3(0.16, 0.42, 0.42); // teal
        else
            albedo = vec3(0.75, 0.42, 0.14); // orange
        specStrength = 0.3;
    }
    else if (m == 5) // Hokage tower: bold red
    {
        albedo = vec3(0.70, 0.16, 0.12);
        specStrength = 0.2;
    }
    else if (m == 6) // trim / eaves / spire
    {
        albedo = vec3(0.90, 0.86, 0.78);
        specStrength = 0.3;
    }
    else if (m == 7) // trunks
    {
        albedo = vec3(0.32, 0.22, 0.13);
        specStrength = 0.0;
    }
    else if (m == 8) // leaves: two-tone canopy
    {
        float noise = valueNoise(p * 1.5);
        albedo = mix(vec3(0.12, 0.30, 0.10), vec3(0.24, 0.46, 0.15), noise);
        specStrength = 0.1;
    }
    else if (m == 9) // village gate: deep green with worn paint
    {
        float noise = valueNoise(p * 2.0);
        albedo = mix(vec3(0.10, 0.28, 0.16), vec3(0.14, 0.36, 0.20), noise);
        specStrength = 0.25;
    }
    else if (m == 10) // rampart / temple plinth: coursed grey stone
    {
        float noise = valueNoise(p * 0.7);
        float course = 0.92 + 0.08 * step(0.5, fract(p.y * 0.75));
        albedo = mix(vec3(0.50, 0.48, 0.44), vec3(0.62, 0.59, 0.52), noise)
               * course;
        specStrength = 0.05;
    }

    vec3 sunColor = vec3(1.05, 0.95, 0.80);

    float diffuse = max(dot(n, SUN_DIR), 0.0);
    vec3 halfway = normalize(SUN_DIR - rd);
    float specular = uEnableSpecular
        ? pow(max(dot(n, halfway), 0.0), 48.0) * specStrength
        : 0.0;

    float shadow = softShadow(p + n * 0.04, SUN_DIR, 0.08, 80.0, 10.0);
    float ao = ambientOcclusion(p, n);

    // Blue sky ambient from above, warm bounce from the ground.
    float skyAmb = 0.5 + 0.5 * n.y;
    float bounce = max(dot(n, vec3(0.0, -1.0, 0.0)), 0.0);

    vec3 color = vec3(0.0);
    color += albedo * sunColor * diffuse * shadow * 1.25;
    color += sunColor * specular * shadow;
    color += albedo * vec3(0.35, 0.45, 0.65) * skyAmb * ao * 0.9;
    color += albedo * vec3(0.30, 0.25, 0.15) * bounce * ao * 0.5;

    // Pale blue daylight haze.
    vec3 haze = mix(
        vec3(0.70, 0.78, 0.88),
        vec3(0.45, 0.60, 0.85),
        clamp(rd.y * 0.5 + 0.5, 0.0, 1.0)
    );

    return applyFog(color, haze, t);
}
