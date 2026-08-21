#version 330 core

// Clouds world: volumetric cloudscape marched through 3D noise.
// Unlike the SDF worlds this does not use worldlib.glsl - there are no
// surfaces to hit; instead density is integrated along the ray with
// Beer-Lambert transmittance and a cheap directional-derivative sun
// term for self-shadowing (after Inigo Quilez's "Clouds").

out vec4 FragColor;

uniform vec2  uResolution; // framebuffer size in pixels
uniform float uTime;       // seconds since startup
uniform vec3  uCamPos;     // camera position, world space
uniform mat3  uCamRot;     // camera basis: columns = (right, up, forward)

const float FOCAL_LENGTH = 1.5; // ~67 degrees vertical FOV
const int   MARCH_STEPS  = 128;
const float MAX_DISTANCE = 300.0;

const vec3 SUN_DIR = normalize(vec3(0.6, 0.3, -0.7));

// ---------------------------------------------------------------------------
// Value noise and fractal Brownian motion
// ---------------------------------------------------------------------------

float hash(vec3 p)
{
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise(vec3 x)
{
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f); // smoothstep fade

    return mix(
        mix(mix(hash(i + vec3(0, 0, 0)), hash(i + vec3(1, 0, 0)), f.x),
            mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x),
            f.y),
        mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
            mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x),
            f.y),
        f.z
    );
}

// 5 octaves: base shape from the low ones, curly detail from the high.
float fbm(vec3 p)
{
    float value = 0.0;
    float amplitude = 0.5;

    for (int i = 0; i < 5; ++i)
    {
        value += amplitude * noise(p);
        p = p * 2.02;
        amplitude *= 0.5;
    }

    return value;
}

// ---------------------------------------------------------------------------
// Cloud density field
// ---------------------------------------------------------------------------

// Returns cloud density in [0, 1] at a point. Two layers:
//  - a thick cumulus band around the camera, modulated by a very
//    low-frequency "weather" pattern so separate cloud masses take
//    different shapes and sizes across the sky;
//  - a thin, horizontally stretched cirrus sheet high above.
float cloudDensity(vec3 p)
{
    // Wind: the whole field drifts, high clouds slightly faster.
    vec3 q = p - vec3(6.0, 0.0, 3.0) * uTime * 0.4;

    // Weather pattern: where cloud masses live and how dense they get.
    float weather = fbm(q * 0.007 + vec3(0.0, 0.0, 100.0));

    // Vertical profile of the cumulus band: soft floor and ceiling.
    // The deck sits below the spawn height so the camera starts above
    // the cloud tops, looking down on them.
    float band =
        smoothstep(-75.0, -45.0, p.y) * smoothstep(-4.0, -25.0, p.y);

    float shape = fbm(q * 0.035);
    float cumulus = (shape + weather * 1.2 - 0.96) * band;

    // Cirrus: stretched domain -> long wispy streaks in a thin band.
    vec3 c = q * vec3(0.010, 0.15, 0.022);
    float cirrusBand =
        smoothstep(90.0, 110.0, p.y) * smoothstep(150.0, 125.0, p.y);
    float cirrus = (fbm(c) - 0.55) * cirrusBand * 0.6;

    return clamp(max(cumulus, cirrus) * 2.2, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Sky background
// ---------------------------------------------------------------------------

vec3 skyColor(vec3 rd)
{
    // Blue gradient, hazier toward and below the horizon.
    vec3 sky = mix(
        vec3(0.62, 0.72, 0.90),
        vec3(0.22, 0.40, 0.75),
        clamp(rd.y, 0.0, 1.0)
    );
    sky = mix(sky, vec3(0.70, 0.74, 0.80), smoothstep(0.1, -0.4, rd.y));

    float sun = clamp(dot(rd, SUN_DIR), 0.0, 1.0);
    sky += vec3(1.0, 0.75, 0.45) * pow(sun, 220.0) * 2.0; // disk
    sky += vec3(1.0, 0.80, 0.50) * pow(sun, 6.0) * 0.20;  // haze glow

    return sky;
}

// ---------------------------------------------------------------------------
// Volumetric integration
// ---------------------------------------------------------------------------

// Front-to-back accumulation: rgb holds premultiplied color, a holds
// opacity. Sun lighting uses the density difference toward the sun as
// a cheap directional derivative: less density sunward = more light.
vec4 marchClouds(vec3 ro, vec3 rd, vec3 bg)
{
    vec4 sum = vec4(0.0);
    float t = 0.1;

    for (int i = 0; i < MARCH_STEPS; ++i)
    {
        if (sum.a > 0.99 || t > MAX_DISTANCE)
            break;

        vec3 pos = ro + rd * t;
        float den = cloudDensity(pos);

        if (den > 0.01)
        {
            float sunward = cloudDensity(pos + SUN_DIR * 5.0);
            float dif = clamp((den - sunward) * 1.6, 0.0, 1.0);

            // Ambient sky light plus warm directional sun.
            vec3 lin = vec3(0.62, 0.68, 0.80) * 1.15
                     + vec3(1.0, 0.75, 0.55) * dif * 1.6;

            // Dense cores go gray, edges stay bright.
            vec3 cloudColor = mix(
                vec3(1.05, 1.0, 0.95),
                vec3(0.35, 0.38, 0.43),
                den
            );

            vec4 col = vec4(cloudColor * lin, den);

            // Distant clouds dissolve into the sky for aerial depth.
            col.rgb = mix(col.rgb, bg, 1.0 - exp(-0.003 * t));

            // Premultiply and accumulate front-to-back.
            col.a *= 0.42;
            col.rgb *= col.a;
            sum += col * (1.0 - sum.a);
        }

        // Step grows with distance: fine detail near, cheap far.
        t += max(0.3, 0.04 * t);
    }

    return clamp(sum, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

void main()
{
    vec2 uv = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

    vec3 ro = uCamPos;
    vec3 rd = normalize(uCamRot * vec3(uv, FOCAL_LENGTH));

    vec3 sky = skyColor(rd);
    vec4 clouds = marchClouds(ro, rd, sky);

    vec3 color = sky * (1.0 - clouds.a) + clouds.rgb;

    // No gamma here: cloud and sky values are tuned in display space,
    // as is conventional for this style of shader.
    FragColor = vec4(color, 1.0);
}
