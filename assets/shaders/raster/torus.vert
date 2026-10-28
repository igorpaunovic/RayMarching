#version 330 core

// Traditional rasterization vertex shader for the torus world: a
// lattice of mesh tori, the rasterized counterpart of torus_world.frag.
// Same camera and projection as the other mesh worlds (FOCAL 1.5).
//
// The raymarched map() evaluates the torus SDF in a sine-warped
// domain, so the surface is the set of points p where
// warp(p) lies on a rigid torus. Vertices are therefore inverse-
// warped from the rigid torus so the mesh sits on that same surface.
// Curved rays still cannot be reproduced with a depth buffer.

layout (location = 0) in vec3 aPos;
layout (location = 1) in vec3 aNormal;

uniform vec3  uCamPos;
uniform mat3  uCamRot;      // columns = (right, up, forward)
uniform vec2  uResolution;
uniform float uTime;

uniform vec3  uModelPos;    // lattice cell origin (torus center)
uniform vec3  uCell;        // integer cell coordinate (unused; frag recomputes)

out vec3 vWorld;

const float FOCAL = 1.5;
const float NEAR  = 0.1;
const float FAR   = 300.0; // past raymarch MAX_DISTANCE (220)

void main()
{
    // Rigid torus point in the warped domain (where map() measures).
    vec3 target = aPos + uModelPos;

    // Invert p + 0.6*sin(p.zxy*0.30 + t) = target by fixed-point
    // iteration so the mesh lands on the same surface as the SDF.
    vec3 p = target;
    for (int i = 0; i < 5; ++i)
        p = target - 0.6 * sin(p.zxy * 0.30 + uTime * 0.35);

    vWorld = p;

    vec3 v = transpose(uCamRot) * (p - uCamPos);

    float aspect = uResolution.x / uResolution.y;
    gl_Position = vec4(
        v.x * FOCAL / aspect,
        v.y * FOCAL,
        (v.z * (FAR + NEAR) - 2.0 * FAR * NEAR) / (FAR - NEAR),
        v.z
    );
}
