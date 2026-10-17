# RayMarching

Master's thesis project comparing **ray marching** against **traditional rasterization** for rendering procedural scenes in real time.

The application is written in C++17 with OpenGL 3.3. Scenes are implemented as GLSL fragment shaders marched on a fullscreen quad - fractals (Mandelbulb, Mandelbox), volumetric clouds, a procedural solar system, and non-Euclidean space. Selected scenes are also implemented with a classic mesh pipeline (including a Mandelbox baked to a triangle mesh via surface nets), so both techniques can be explored and measured in the same scene with a free-flying camera.

## Gallery

<!-- video links go here -->

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
