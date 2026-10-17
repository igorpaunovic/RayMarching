# RayMarching

Master's thesis project comparing **ray marching** against **traditional rasterization** for rendering procedural scenes in real time.

The application is written in C++17 with OpenGL 3.3. Scenes are implemented as GLSL fragment shaders marched on a fullscreen quad - fractals (Mandelbulb, Mandelbox), volumetric clouds, a procedural solar system, and non-Euclidean space. Selected scenes are also implemented with a classic mesh pipeline (including a Mandelbox baked to a triangle mesh via surface nets), so both techniques can be explored and measured in the same scene with a free-flying camera.

## Gallery

### Ray Marching Method

#### Torus world
[torus world](https://github.com/user-attachments/assets/3ef0e770-99dd-47ca-9fa0-f8901b0a91c3
)

[torus world with ray curvature](https://github.com/user-attachments/assets/4e61d6c7-8d95-43f7-9041-8fa8fe506b71
)

[torus world with max ray curvature](https://github.com/user-attachments/assets/e23db322-d575-4203-ad69-e3b00c029585
)

#### Mandelbox fractal

[raymarching mandlebox fractal](https://github.com/user-attachments/assets/d3ee3e9a-b9a2-4864-8885-6bf2bf30d0ed
)

### Classic rasterization method

#### Mandelbox fractal

Raising the mesh detail from 128 to 256 to 512 sharpens the rasterized fractal, but it still falls short of the fine structure ray marching shows. That number is how finely the fractal is turned into a triangle mesh. Higher means a denser model that can hold smaller folds, but takes longer to generate and runs at a lower frame rate.

<img width="1665" height="906" alt="128" src="https://github.com/user-attachments/assets/ba37c056-4484-4196-b2cb-8ee2ac79bedc" />
<img width="1665" height="905" alt="256" src="https://github.com/user-attachments/assets/564407cc-ec46-4724-86cc-f5003d7a7c29" />
<img width="1660" height="911" alt="512" src="https://github.com/user-attachments/assets/a7e2f293-1021-4e06-9c1a-131db60016e9" />

## Controls

| Input | Action |
|---|---|
| Mouse | Look around |
| `W` `A` `S` `D` | Move |
| `Space` / `Left Ctrl` | Up / down |
| `Left Shift` | 3× speed |
| `Tab` | Open/close the menu (scene selection, effect toggles, VSync, FPS) |
| `R` | Hot-reload the current shader |
| `Esc` | Quit |

## Building

Requires CMake ≥ 3.20 and a C++17 compiler (MSVC or MinGW); dependencies (GLFW, Dear ImGui, glad) are vendored. Windows only (links `opengl32`).

**MSVC** (Visual Studio or Build Tools installed):

```powershell
cmake -S . -B build
cmake --build build
cd build
./Debug/RayMarching.exe
```

**MinGW** (the compiler's `bin` directory must be on `PATH` - g++ needs its own DLLs at build time; the GCC runtime is linked statically, so the built exe runs standalone):

```powershell
cmake -S . -B build -G "MinGW Makefiles"
cmake --build build
cd build
./RayMarching.exe
```

Run the exe from the `build` directory - it loads shaders from a relative `assets/` path.
