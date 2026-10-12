#version 330 core

// Traditional rasterization vertex shader for the meshed Mandelbox.
// Same camera and projection as planets.vert (FOCAL 1.5, like
// worldlib). Positions and normals are baked from the fractal's
// distance estimator; all secondary effects (shadows, AO, glow) are
// marched per fragment against that same DE.

layout (location = 0) in vec3 aPos;
layout (location = 1) in vec3 aNormal;

uniform vec3  uCamPos;
uniform mat3  uCamRot;      // columns = (right, up, forward)
uniform vec2  uResolution;

uniform mat3  uModelRot;
uniform vec3  uModelPos;
uniform float uScale;

out vec3 vWorld;
out vec3 vNormal;
out vec3 vLocal; // fractal (unit) space, for the orbit-trap coloring

const float FOCAL = 1.5;
const float NEAR  = 0.1;
const float FAR   = 16000.0;

void main()
{
    vLocal = aPos;

    vec3 world = uModelRot * (aPos * uScale) + uModelPos;
    vWorld = world;
    vNormal = normalize(uModelRot * aNormal);

    // View space: camera looks down +z of its own basis.
    vec3 v = transpose(uCamRot) * (world - uCamPos);

    float aspect = uResolution.x / uResolution.y;
    gl_Position = vec4(
        v.x * FOCAL / aspect,
        v.y * FOCAL,
        (v.z * (FAR + NEAR) - 2.0 * FAR * NEAR) / (FAR - NEAR),
        v.z
    );
}
