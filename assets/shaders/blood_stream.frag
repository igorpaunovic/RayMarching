#version 330 core

// Blood stream world: the camera floats inside an endless, winding
// blood vessel. Cells surge past with pulsatile flow, the walls beat
// with the heart, and rays are marched along gently curved paths so
// the scene swims organically. Each inhabitant is a different shape:
//   red blood cells    biconcave discs (ellipsoid with carved dimples)
//   white blood cells  amoeboid spheres that crawl and deform
//   viruses            small octahedra fused with spiky balls
//   platelets          tiny rounded fragments

out vec4 FragColor;

uniform vec2  uResolution; // framebuffer size in pixels
uniform float uTime;       // seconds since startup
uniform vec3  uCamPos;     // camera position, world space
uniform mat3  uCamRot;     // camera basis: columns = (right, up, forward)

// Menu-controlled effects.
uniform float uCurveScale     = 1.0; // 0 = straight (Euclidean) rays
uniform bool  uEnableAO       = true;
uniform bool  uEnableSpecular = true;
uniform bool  uEnableFog      = true;

const float FOCAL_LENGTH = 1.5; // ~67 degrees vertical FOV
const int   MAX_STEPS    = 200;
const float MAX_DISTANCE = 90.0;
const float HIT_EPSILON  = 0.002;

// Gentle space curvature; strong enough to feel fluid, weak enough to
// stay believable.
const float CURVE_STRENGTH = 0.02;
const float MAX_STEP_LEN   = 0.8;

// Mean blood flow speed along the vessel, world units per second.
const float FLOW_SPEED = 4.0;

// Heart rate ~66 bpm.
const float HEART_RATE = 1.1;

// Material IDs
const float MAT_VESSEL   = 0.0;
const float MAT_RED      = 1.0;
const float MAT_WHITE    = 2.0;
const float MAT_VIRUS    = 3.0;
const float MAT_PLATELET = 4.0;

// Material of the nearest surface from the last map() call.
float gMat = MAT_VESSEL;

// ---------------------------------------------------------------------------
// Hashing and small helpers
// ---------------------------------------------------------------------------

float hash1(vec3 c)
{
    return fract(sin(dot(c, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

vec3 hash3(vec3 c)
{
    return fract(
        sin(vec3(
            dot(c, vec3(127.1, 311.7, 74.7)),
            dot(c, vec3(269.5, 183.3, 246.1)),
            dot(c, vec3(113.5, 271.9, 124.6))
        )) * 43758.5453
    );
}

mat2 rot2(float a)
{
    float c = cos(a);
    float s = sin(a);
    return mat2(c, -s, s, c);
}

// Heartbeat envelope: two quick thumps per cycle (lub-dub).
float heartbeat()
{
    float cycle = fract(uTime * HEART_RATE);
    float thump1 = exp(-300.0 * pow(cycle - 0.15, 2.0));
    float thump2 = exp(-300.0 * pow(cycle - 0.45, 2.0)) * 0.6;
    return thump1 + thump2;
}

// ---------------------------------------------------------------------------
// SDF shapes
// ---------------------------------------------------------------------------

float sdEllipsoid(vec3 p, vec3 r)
{
    float k0 = length(p / r);
    float k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / k1;
}

float sdSphere(vec3 p, float r)
{
    return length(p) - r;
}

float sdBox(vec3 p, vec3 b)
{
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdOctahedron(vec3 p, float s)
{
    p = abs(p);
    return (p.x + p.y + p.z - s) * 0.57735;
}

// Smooth subtraction: carves b out of a with a rounded seam.
float opSmoothSubtraction(float b, float a, float k)
{
    float h = clamp(0.5 - 0.5 * (a + b) / k, 0.0, 1.0);
    return mix(a, -b, h) + k * h * (1.0 - h);
}

// Red blood cell: flattened ellipsoid with a dimple carved into each
// face - the classic biconcave disc.
float sdRedCell(vec3 q)
{
    float disc = sdEllipsoid(q, vec3(0.85, 0.34, 0.85));
    disc = opSmoothSubtraction(
        sdSphere(q - vec3(0.0, 0.52, 0.0), 0.42), disc, 0.12);
    disc = opSmoothSubtraction(
        sdSphere(q + vec3(0.0, 0.52, 0.0), 0.42), disc, 0.12);
    return disc;
}

// ---------------------------------------------------------------------------
// The vessel and its inhabitants
// ---------------------------------------------------------------------------

// The vessel centerline winds through space.
vec2 vesselCenter(float z)
{
    return vec2(4.0 * sin(z * 0.08), 3.0 * cos(z * 0.06));
}

// Inside of a winding tube. Walls carry two scales of relief: large
// soft folds and a fine cobble suggesting endothelial cells.
float sdVessel(vec3 p)
{
    vec2 rel = p.xy - vesselCenter(p.z);
    float ang = atan(rel.y, rel.x);

    float radius = 10.0;
    radius += 0.8 * sin(p.z * 0.30);                          // long bulges
    radius += 0.5 * heartbeat();                              // pulse
    radius += 0.30 * sin(ang * 7.0 + sin(p.z * 0.8) * 2.0);   // soft folds
    radius += 0.08 * sin(ang * 23.0 + p.z * 3.1)
                   * sin(p.z * 5.7);                          // endothelial cobble

    // Negative inside: we live within the tube. The winding and the
    // ripples distort distances, so scale to a safe lower bound.
    return (radius - length(rel)) * 0.65;
}

// Positions a point within an infinite jittered lattice of one cell
// type, drifting with pulsatile flow. Writes the shape-local frame and
// the per-instance hash; caller computes the actual shape distance.
//   spacing   lattice period
//   seed      decorrelates lattices
//   speedMul  relative flow speed (big cells lag, small ride the core)
vec3 cellLattice(vec3 p, float spacing, float seed, float speedMul, out vec3 h)
{
    // Pulsatile flow: steady drift plus a surge on each heartbeat.
    float surge = 0.5 * sin(uTime * HEART_RATE * 6.2832) * speedMul;
    p.z += uTime * FLOW_SPEED * speedMul + surge + seed * 17.0;

    vec3 id = floor((p + 0.5 * spacing) / spacing);
    vec3 local = mod(p + 0.5 * spacing, spacing) - 0.5 * spacing;

    h = hash3(id + seed);

    // Jitter each instance inside its cell.
    local -= (h - 0.5) * spacing * 0.4;

    // Brownian wobble: small random drift, faster for small particles.
    local += 0.15 * sin(uTime * (1.0 + 2.0 * h) + h * 6.2832);

    // Slow tumble.
    float tumble = uTime * (0.2 + 0.4 * h.x) + h.y * 6.2832;
    local.xy = rot2(tumble) * local.xy;
    local.yz = rot2(tumble * 0.7) * local.yz;

    return local;
}

vec2 opUnion(vec2 a, vec2 b)
{
    return (a.x < b.x) ? a : b;
}

float map(vec3 p)
{
    // Faint plasma sway; everything drifts as if suspended in fluid.
    p += 0.25 * sin(p.zxy * 0.35 + uTime * 0.5);

    vec2 scene = vec2(sdVessel(p), MAT_VESSEL);

    vec3 h;
    vec3 q;

    // Red blood cells: biconcave discs, by far the most numerous,
    // riding near the fast core of the flow.
    q = cellLattice(p, 6.5, 0.0, 1.0, h);
    scene = opUnion(scene, vec2(sdRedCell(q) * 0.6, MAT_RED));

    // White blood cells: rare, larger, amoeboid - the membrane slowly
    // crawls with traveling deformation waves.
    q = cellLattice(p, 21.0, 1.0, 0.7, h);
    float wbc = length(q) - 1.4
              + 0.16 * sin(q.x * 3.0 + uTime * 1.2)
                     * sin(q.y * 3.0 - uTime * 0.9)
                     * sin(q.z * 3.0 + uTime * 1.5);
    scene = opUnion(scene, vec2(wbc * 0.7, MAT_WHITE));

    // Viruses: far smaller than any cell, uncommon, riding the core.
    q = cellLattice(p, 16.0, 2.0, 1.1, h);
    float core = sdOctahedron(q, 0.32);
    float spikes = length(q) - 0.20
                 - 0.07 * cos(q.x * 22.0) * cos(q.y * 22.0) * cos(q.z * 22.0);
    scene = opUnion(scene, vec2(min(core, spikes) * 0.7, MAT_VIRUS));

    // Platelets: small rounded fragments.
    q = cellLattice(p, 9.0, 3.0, 0.9, h);
    float plate = sdBox(q, vec3(0.32, 0.07, 0.32)) - 0.05;
    scene = opUnion(scene, vec2(plate * 0.8, MAT_PLATELET));

    gMat = scene.y;
    return scene.x;
}

// ---------------------------------------------------------------------------
// Curved-space marching (same scheme as non_euclidean.frag)
// ---------------------------------------------------------------------------

vec3 bendField(vec3 p)
{
    return vec3(
        sin(p.y * 0.20 + uTime * 0.30),
        sin(p.z * 0.15 - uTime * 0.20),
        sin(p.x * 0.18 + uTime * 0.25)
    );
}

float rayMarch(vec3 ro, vec3 rd, out vec3 pos, out vec3 dir)
{
    pos = ro;
    dir = rd;
    float t = 0.0;

    for (int i = 0; i < MAX_STEPS; ++i)
    {
        float d = map(pos);

        if (d < HIT_EPSILON)
            return t;

        float stepLen = min(d, MAX_STEP_LEN);
        pos += dir * stepLen;
        t += stepLen;

        dir = normalize(
            dir + bendField(pos) * (CURVE_STRENGTH * uCurveScale) * stepLen
        );

        if (t > MAX_DISTANCE)
            break;
    }

    return MAX_DISTANCE;
}

vec3 calcNormal(vec3 p)
{
    const vec2 e = vec2(0.003, 0.0);
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
        float h = 0.10 * float(i);
        float d = map(p + n * h);
        occlusion += weight * (h - d);
        weight *= 0.6;
    }

    return clamp(1.0 - 2.0 * occlusion, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Shading
// ---------------------------------------------------------------------------

vec3 materialAlbedo(float mat)
{
    if (mat == MAT_RED)      return vec3(0.62, 0.06, 0.05);
    if (mat == MAT_WHITE)    return vec3(0.92, 0.88, 0.78);
    if (mat == MAT_VIRUS)    return vec3(0.50, 0.65, 0.35);
    if (mat == MAT_PLATELET) return vec3(0.82, 0.66, 0.42);
    return vec3(0.36, 0.05, 0.06); // vessel wall
}

// Deep red plasma; everything dissolves into it with distance.
vec3 plasmaColor()
{
    return vec3(0.13, 0.012, 0.016) * (1.0 + 0.25 * heartbeat());
}

vec3 shade(vec3 p, vec3 rd, float t, float mat)
{
    vec3 n = calcNormal(p);
    vec3 albedo = materialAlbedo(mat);

    // Headlight: inside a body the only light is the viewer's. Wrapped
    // diffuse imitates light bleeding through soft translucent tissue
    // instead of the hard falloff of an opaque surface.
    vec3 lightDir = -rd;
    float wrap = dot(n, lightDir) * 0.5 + 0.5;
    float diffuse = pow(wrap, 1.5);

    // Broad wet-membrane sheen rather than a hard plastic highlight.
    float specular = uEnableSpecular
        ? pow(max(dot(n, lightDir), 0.0), 12.0)
        : 0.0;

    // Transmission: thin translucent cells glow at grazing angles as
    // light passes through their rims (strongest on red cells).
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 2.5);
    float transmission = (mat == MAT_RED) ? rim * 0.9 : rim * 0.35;

    float ao = ambientOcclusion(p, n);

    vec3 color = vec3(0.0);
    color += albedo * diffuse * vec3(1.0, 0.9, 0.85);
    color += vec3(1.0, 0.85, 0.75) * specular * 0.18;
    color += albedo * vec3(0.40, 0.10, 0.09) * ao;      // red ambient
    color += vec3(0.95, 0.20, 0.12) * transmission;     // glow-through

    // Pulse brightens the whole scene on each heartbeat.
    color *= 1.0 + 0.10 * heartbeat();

    // Dense plasma fog: distance drowns everything in deep red.
    if (!uEnableFog)
        return color;

    float fog = 1.0 - exp(-0.055 * t);
    return mix(color, plasmaColor(), fog);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

void main()
{
    vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

    vec3 ro = uCamPos;
    vec3 rd = normalize(uCamRot * vec3(uv, FOCAL_LENGTH));

    vec3 pos;
    vec3 dir;
    float t = rayMarch(ro, rd, pos, dir);
    float mat = gMat;

    vec3 color = (t >= MAX_DISTANCE)
        ? plasmaColor()
        : shade(pos, dir, t, mat);

    // Simple gamma correction.
    color = pow(color, vec3(1.0 / 2.2));

    FragColor = vec4(color, 1.0);
}
