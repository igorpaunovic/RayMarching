#include <glad/glad.h>
#include <GLFW/glfw3.h>

#include <imgui.h>
#include <imgui_impl_glfw.h>
#include <imgui_impl_opengl3.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

// Framebuffer size, kept up to date by the resize callback so the
// uResolution uniform is always correct.
static int g_framebuffer_width = 800;
static int g_framebuffer_height = 600;

struct Camera
{
    // Position in world space.
    float x = 0.0f;
    float y = 1.5f;
    float z = -5.0f;

    // Orientation (radians). Yaw rotates around the world Y axis,
    // pitch around the camera's right axis.
    float yaw = 0.0f;
    float pitch = 0.0f;
};

static Camera g_camera;

// Last cursor position, used to compute mouse-look deltas.
static double g_last_cursor_x = 0.0;
static double g_last_cursor_y = 0.0;
static bool g_first_cursor_event = true;

// When true the cursor is released and the ImGui menu is shown;
// camera input (mouse-look and WASD) is suspended.
static bool g_menu_open = false;

// Base fly speed in world units per second, adjustable from the menu;
// holding Shift still triples it.
static float g_move_speed = 6.0f;

// ---------------------------------------------------------------------------
// GLFW callbacks
// ---------------------------------------------------------------------------

void framebuffer_size_callback(GLFWwindow*, int width, int height)
{
    g_framebuffer_width = width;
    g_framebuffer_height = height;
    glViewport(0, 0, width, height);
}

void cursor_pos_callback(GLFWwindow*, double xpos, double ypos)
{
    if (g_menu_open)
        return;

    if (g_first_cursor_event)
    {
        g_last_cursor_x = xpos;
        g_last_cursor_y = ypos;
        g_first_cursor_event = false;
        return;
    }

    const double dx = xpos - g_last_cursor_x;
    const double dy = ypos - g_last_cursor_y;
    g_last_cursor_x = xpos;
    g_last_cursor_y = ypos;

    constexpr float sensitivity = 0.0025f;
    g_camera.yaw += static_cast<float>(dx) * sensitivity;
    g_camera.pitch -= static_cast<float>(dy) * sensitivity;

    // Clamp pitch to avoid flipping over the poles.
    constexpr float pitch_limit = 1.55f; // just under pi/2
    if (g_camera.pitch > pitch_limit)
        g_camera.pitch = pitch_limit;
    if (g_camera.pitch < -pitch_limit)
        g_camera.pitch = -pitch_limit;
}

// ---------------------------------------------------------------------------
// Camera basis and movement
// ---------------------------------------------------------------------------

// Builds the camera rotation basis as a column-major 3x3 matrix:
// columns are (right, up, forward). Forward at yaw = 0, pitch = 0 is +Z.
void camera_basis(const Camera& cam, float out[9])
{
    const float cy = std::cos(cam.yaw);
    const float sy = std::sin(cam.yaw);
    const float cp = std::cos(cam.pitch);
    const float sp = std::sin(cam.pitch);

    // Forward vector.
    const float fx = cp * sy;
    const float fy = sp;
    const float fz = cp * cy;

    // Right vector = normalize(cross(forward, world up)); for a
    // yaw/pitch camera this simplifies to a pure yaw rotation of +X.
    const float rx = cy;
    const float ry = 0.0f;
    const float rz = -sy;

    // Up vector = cross(forward, right); with the screen convention
    // (x right, y up, z forward) the basis is left-handed, so this
    // order yields +Y up at zero pitch.
    const float ux = fy * rz - fz * ry;
    const float uy = fz * rx - fx * rz;
    const float uz = fx * ry - fy * rx;

    // Column-major layout for glUniformMatrix3fv.
    out[0] = rx; out[1] = ry; out[2] = rz; // column 0: right
    out[3] = ux; out[4] = uy; out[5] = uz; // column 1: up
    out[6] = fx; out[7] = fy; out[8] = fz; // column 2: forward
}

// Column-major 3x3 rotation helpers for mesh model matrices. These
// match the rotX/rotY conventions used inside the world shaders, so a
// mesh body can invert the shader's world-to-local transform exactly.
void mat3_rot_x(float a, float out[9])
{
    const float c = std::cos(a);
    const float s = std::sin(a);
    out[0] = 1.0f; out[1] = 0.0f; out[2] = 0.0f;
    out[3] = 0.0f; out[4] = c;    out[5] = s;
    out[6] = 0.0f; out[7] = -s;   out[8] = c;
}

void mat3_rot_y(float a, float out[9])
{
    const float c = std::cos(a);
    const float s = std::sin(a);
    out[0] = c;    out[1] = 0.0f; out[2] = -s;
    out[3] = 0.0f; out[4] = 1.0f; out[5] = 0.0f;
    out[6] = s;    out[7] = 0.0f; out[8] = c;
}

// out = a * b (column-major).
void mat3_mul(const float a[9], const float b[9], float out[9])
{
    for (int col = 0; col < 3; ++col)
    {
        for (int row = 0; row < 3; ++row)
        {
            out[col * 3 + row] =
                a[0 * 3 + row] * b[col * 3 + 0]
                + a[1 * 3 + row] * b[col * 3 + 1]
                + a[2 * 3 + row] * b[col * 3 + 2];
        }
    }
}

void process_input(GLFWwindow* window, float delta_time)
{
    if (glfwGetKey(window, GLFW_KEY_ESCAPE) == GLFW_PRESS)
        glfwSetWindowShouldClose(window, true);

    // While the menu is open the keyboard belongs to the UI.
    if (g_menu_open)
        return;

    float speed = g_move_speed * delta_time;
    if (glfwGetKey(window, GLFW_KEY_LEFT_SHIFT) == GLFW_PRESS)
        speed *= 3.0f;

    float basis[9];
    camera_basis(g_camera, basis);

    const float* right = &basis[0];
    const float* forward = &basis[6];

    if (glfwGetKey(window, GLFW_KEY_W) == GLFW_PRESS)
    {
        g_camera.x += forward[0] * speed;
        g_camera.y += forward[1] * speed;
        g_camera.z += forward[2] * speed;
    }
    if (glfwGetKey(window, GLFW_KEY_S) == GLFW_PRESS)
    {
        g_camera.x -= forward[0] * speed;
        g_camera.y -= forward[1] * speed;
        g_camera.z -= forward[2] * speed;
    }
    if (glfwGetKey(window, GLFW_KEY_D) == GLFW_PRESS)
    {
        g_camera.x += right[0] * speed;
        g_camera.y += right[1] * speed;
        g_camera.z += right[2] * speed;
    }
    if (glfwGetKey(window, GLFW_KEY_A) == GLFW_PRESS)
    {
        g_camera.x -= right[0] * speed;
        g_camera.y -= right[1] * speed;
        g_camera.z -= right[2] * speed;
    }
    if (glfwGetKey(window, GLFW_KEY_SPACE) == GLFW_PRESS)
        g_camera.y += speed;
    if (glfwGetKey(window, GLFW_KEY_LEFT_CONTROL) == GLFW_PRESS)
        g_camera.y -= speed;
}

// ---------------------------------------------------------------------------
// Shader loading
// ---------------------------------------------------------------------------

// Loads a shader source file, expanding #include "file" directives
// (paths resolved relative to the including file). #line directives
// are injected around spliced content so GLSL compile errors report
// the correct line in the correct file: the source-string number in
// the error corresponds to include depth (0 = the world shader).
std::string load_shader_source(
    const std::filesystem::path& path,
    int depth = 0)
{
    if (depth > 8)
    {
        std::cerr << "Shader include depth exceeded at: " << path << '\n';
        return {};
    }

    std::ifstream file(path);

    if (!file.is_open())
    {
        std::cerr << "Failed to open shader file: " << path << '\n';
        return {};
    }

    std::ostringstream out;
    std::string line;
    int line_number = 0;

    while (std::getline(file, line))
    {
        ++line_number;

        const size_t start = line.find_first_not_of(" \t");
        const bool is_include =
            start != std::string::npos
            && line.compare(start, 8, "#include") == 0;

        if (!is_include)
        {
            out << line << '\n';
            continue;
        }

        const size_t open = line.find('"', start + 8);
        const size_t close =
            (open == std::string::npos)
                ? std::string::npos
                : line.find('"', open + 1);

        if (close == std::string::npos)
        {
            std::cerr
                << path << ':' << line_number
                << ": malformed #include directive\n";
            return {};
        }

        const std::string name = line.substr(open + 1, close - open - 1);
        const std::string included = load_shader_source(
            path.parent_path() / name,
            depth + 1
        );

        if (included.empty())
            return {};

        out << "#line 1 " << (depth + 1) << '\n'
            << included
            << "#line " << (line_number + 1) << ' ' << depth << '\n';
    }

    return out.str();
}

unsigned int compile_shader(
    GLenum type,
    const std::string& source,
    const char* label)
{
    const char* source_cstr = source.c_str();
    unsigned int shader = glCreateShader(type);

    glShaderSource(shader, 1, &source_cstr, nullptr);
    glCompileShader(shader);

    int success = 0;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &success);

    if (!success)
    {
        char info_log[512];
        glGetShaderInfoLog(shader, sizeof(info_log), nullptr, info_log);
        std::cerr
            << "Shader compilation failed (" << label << "):\n"
            << info_log
            << '\n';
        glDeleteShader(shader);
        return 0;
    }

    return shader;
}

unsigned int create_shader_program(
    const char* vertex_path,
    const char* fragment_path)
{
    const std::string vertex_source = load_shader_source(vertex_path);
    const std::string fragment_source = load_shader_source(fragment_path);

    if (vertex_source.empty() || fragment_source.empty())
        return 0;

    const unsigned int vertex_shader = compile_shader(
        GL_VERTEX_SHADER,
        vertex_source,
        vertex_path
    );

    const unsigned int fragment_shader = compile_shader(
        GL_FRAGMENT_SHADER,
        fragment_source,
        fragment_path
    );

    if (vertex_shader == 0 || fragment_shader == 0)
    {
        if (vertex_shader != 0)
            glDeleteShader(vertex_shader);
        if (fragment_shader != 0)
            glDeleteShader(fragment_shader);
        return 0;
    }

    unsigned int program = glCreateProgram();
    glAttachShader(program, vertex_shader);
    glAttachShader(program, fragment_shader);
    glLinkProgram(program);

    glDeleteShader(vertex_shader);
    glDeleteShader(fragment_shader);

    int success = 0;
    glGetProgramiv(program, GL_LINK_STATUS, &success);

    if (!success)
    {
        char info_log[512];
        glGetProgramInfoLog(program, sizeof(info_log), nullptr, info_log);
        std::cerr << "Shader program linking failed:\n" << info_log << '\n';
        glDeleteProgram(program);
        return 0;
    }

    return program;
}

// Uniform locations for the ray marching shader. Effect uniforms are
// optional per shader; a location of -1 (absent) is silently ignored
// by glUniform*.
struct Uniforms
{
    int resolution = -1;
    int time = -1;
    int cam_pos = -1;
    int cam_rot = -1;

    int enable_shadows = -1;
    int enable_ao = -1;
    int enable_specular = -1;
    int enable_fog = -1;
    int curve_scale = -1;
};

Uniforms query_uniforms(unsigned int program)
{
    Uniforms u;
    u.resolution = glGetUniformLocation(program, "uResolution");
    u.time = glGetUniformLocation(program, "uTime");
    u.cam_pos = glGetUniformLocation(program, "uCamPos");
    u.cam_rot = glGetUniformLocation(program, "uCamRot");

    u.enable_shadows = glGetUniformLocation(program, "uEnableShadows");
    u.enable_ao = glGetUniformLocation(program, "uEnableAO");
    u.enable_specular = glGetUniformLocation(program, "uEnableSpecular");
    u.enable_fog = glGetUniformLocation(program, "uEnableFog");
    u.curve_scale = glGetUniformLocation(program, "uCurveScale");
    return u;
}

// Menu-controlled rendering effects, applied to any shader that
// declares the matching uniform.
struct Effects
{
    bool shadows = true;
    bool ao = true;
    bool specular = true;
    bool fog = true;
    float curve_scale = 1.0f; // 0 = Euclidean, 1 = world default
};

// Lists all .frag files in the given directory (sorted), so new world
// shaders show up in the menu without code changes.
std::vector<std::string> list_fragment_shaders(const char* directory)
{
    std::vector<std::string> files;

    std::error_code ec;
    for (const auto& entry :
         std::filesystem::directory_iterator(directory, ec))
    {
        if (entry.is_regular_file()
            && entry.path().extension() == ".frag")
        {
            files.push_back(entry.path().generic_string());
        }
    }

    std::sort(files.begin(), files.end());
    return files;
}

// ---------------------------------------------------------------------------
// Traditional rasterization: mesh solar system
//
// The same mini solar system as fractal_galaxy.frag, but built from
// real triangle meshes pushed through a vertex shader with a depth
// buffer, so raymarching and rasterization can be compared directly.
// ---------------------------------------------------------------------------

struct Mesh
{
    unsigned int vao = 0;
    unsigned int vbo = 0;
    unsigned int ebo = 0;
    int index_count = 0;
};

Mesh upload_mesh(
    const std::vector<float>& vertices, // interleaved pos(3) + normal(3)
    const std::vector<unsigned int>& indices)
{
    Mesh mesh;
    mesh.index_count = static_cast<int>(indices.size());

    glGenVertexArrays(1, &mesh.vao);
    glGenBuffers(1, &mesh.vbo);
    glGenBuffers(1, &mesh.ebo);

    glBindVertexArray(mesh.vao);

    glBindBuffer(GL_ARRAY_BUFFER, mesh.vbo);
    glBufferData(
        GL_ARRAY_BUFFER,
        static_cast<GLsizeiptr>(vertices.size() * sizeof(float)),
        vertices.data(),
        GL_STATIC_DRAW
    );

    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, mesh.ebo);
    glBufferData(
        GL_ELEMENT_ARRAY_BUFFER,
        static_cast<GLsizeiptr>(indices.size() * sizeof(unsigned int)),
        indices.data(),
        GL_STATIC_DRAW
    );

    glVertexAttribPointer(
        0, 3, GL_FLOAT, GL_FALSE, 6 * sizeof(float),
        reinterpret_cast<void*>(0)
    );
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(
        1, 3, GL_FLOAT, GL_FALSE, 6 * sizeof(float),
        reinterpret_cast<void*>(3 * sizeof(float))
    );
    glEnableVertexAttribArray(1);

    glBindVertexArray(0);
    return mesh;
}

// Unit UV sphere; normals equal positions.
Mesh create_sphere_mesh(int stacks, int slices)
{
    std::vector<float> vertices;
    std::vector<unsigned int> indices;
    vertices.reserve((stacks + 1) * (slices + 1) * 6);

    constexpr float pi = 3.14159265358979f;

    for (int i = 0; i <= stacks; ++i)
    {
        const float phi = pi * static_cast<float>(i) / stacks;
        const float y = std::cos(phi);
        const float r = std::sin(phi);

        for (int j = 0; j <= slices; ++j)
        {
            const float theta =
                2.0f * pi * static_cast<float>(j) / slices;
            const float x = r * std::cos(theta);
            const float z = r * std::sin(theta);

            vertices.insert(vertices.end(), { x, y, z, x, y, z });
        }
    }

    for (int i = 0; i < stacks; ++i)
    {
        for (int j = 0; j < slices; ++j)
        {
            const unsigned int a = i * (slices + 1) + j;
            const unsigned int b = a + slices + 1;

            indices.insert(indices.end(), { a, b, a + 1 });
            indices.insert(indices.end(), { a + 1, b, b + 1 });
        }
    }

    return upload_mesh(vertices, indices);
}

// Flat annulus in the xz plane (normal +Y), radii in object units.
Mesh create_annulus_mesh(float inner, float outer, int segments)
{
    std::vector<float> vertices;
    std::vector<unsigned int> indices;

    constexpr float pi = 3.14159265358979f;

    for (int j = 0; j <= segments; ++j)
    {
        const float theta = 2.0f * pi * static_cast<float>(j) / segments;
        const float c = std::cos(theta);
        const float s = std::sin(theta);

        vertices.insert(
            vertices.end(),
            { inner * c, 0.0f, inner * s, 0.0f, 1.0f, 0.0f }
        );
        vertices.insert(
            vertices.end(),
            { outer * c, 0.0f, outer * s, 0.0f, 1.0f, 0.0f }
        );
    }

    for (int j = 0; j < segments; ++j)
    {
        const unsigned int a = j * 2;
        indices.insert(indices.end(), { a, a + 1, a + 2 });
        indices.insert(indices.end(), { a + 2, a + 1, a + 3 });
    }

    return upload_mesh(vertices, indices);
}

// Torus in the xz plane (major radius R, tube radius r), matching the
// SDF in torus_world.frag: length(vec2(length(p.xz) - R, p.y)) - r.
Mesh create_torus_mesh(float R, float r, int segments_major, int segments_tube)
{
    std::vector<float> vertices;
    std::vector<unsigned int> indices;
    vertices.reserve(
        (segments_major + 1) * (segments_tube + 1) * 6
    );

    constexpr float pi = 3.14159265358979f;

    for (int i = 0; i <= segments_major; ++i)
    {
        const float u =
            2.0f * pi * static_cast<float>(i) / segments_major;
        const float cu = std::cos(u);
        const float su = std::sin(u);

        for (int j = 0; j <= segments_tube; ++j)
        {
            const float v =
                2.0f * pi * static_cast<float>(j) / segments_tube;
            const float cv = std::cos(v);
            const float sv = std::sin(v);

            const float x = (R + r * cv) * cu;
            const float y = r * sv;
            const float z = (R + r * cv) * su;

            // Normal points from the tube center ring to the surface.
            const float nx = cv * cu;
            const float ny = sv;
            const float nz = cv * su;

            vertices.insert(
                vertices.end(), { x, y, z, nx, ny, nz }
            );
        }
    }

    for (int i = 0; i < segments_major; ++i)
    {
        for (int j = 0; j < segments_tube; ++j)
        {
            const unsigned int a = i * (segments_tube + 1) + j;
            const unsigned int b = a + segments_tube + 1;

            indices.insert(indices.end(), { a, b, a + 1 });
            indices.insert(indices.end(), { a + 1, b, b + 1 });
        }
    }

    return upload_mesh(vertices, indices);
}

// ---------------------------------------------------------------------------
// Meshed Mandelbox
//
// The same fractal as large_fractal.frag, baked into a triangle mesh:
// the distance estimator is sampled on a grid and an isosurface is
// extracted with surface nets, with normals and ambient occlusion
// computed from the same DE the raymarcher uses.
// ---------------------------------------------------------------------------

// Fractal parameters and placement, identical to large_fractal.frag.
namespace mbox
{
    constexpr float box_scale      = -1.77f;
    constexpr int   iterations     = 13;
    constexpr float min_radius_2   = 0.25f;
    constexpr float fixed_radius_2 = 1.0f;

    // The fractal is evaluated in unit space, blown up by WORLD_SCALE
    // and pushed ahead of the spawn point, like the raymarched world.
    constexpr float world_scale = 12.0f;
    constexpr float pos[3] = { 0.0f, 0.0f, 45.0f };
}

// CPU mirror of mandelboxDE in large_fractal.frag (minus the orbit
// trap, which the mesh fragment shader re-evaluates per pixel).
float mandelbox_de(float px, float py, float pz)
{
    float zx = px;
    float zy = py;
    float zz = pz;
    float dr = 1.0f;

    for (int i = 0; i < mbox::iterations; ++i)
    {
        // Box fold.
        zx = std::clamp(zx, -1.0f, 1.0f) * 2.0f - zx;
        zy = std::clamp(zy, -1.0f, 1.0f) * 2.0f - zy;
        zz = std::clamp(zz, -1.0f, 1.0f) * 2.0f - zz;

        // Sphere fold.
        const float r2 = zx * zx + zy * zy + zz * zz;
        if (r2 < mbox::min_radius_2)
        {
            const float f = mbox::fixed_radius_2 / mbox::min_radius_2;
            zx *= f; zy *= f; zz *= f;
            dr *= f;
        }
        else if (r2 < mbox::fixed_radius_2)
        {
            const float f = mbox::fixed_radius_2 / r2;
            zx *= f; zy *= f; zz *= f;
            dr *= f;
        }

        zx = zx * mbox::box_scale + px;
        zy = zy * mbox::box_scale + py;
        zz = zz * mbox::box_scale + pz;
        dr = dr * std::abs(mbox::box_scale) + 1.0f;
    }

    return std::sqrt(zx * zx + zy * zy + zz * zz) / std::abs(dr);
}

// Splits [0, count) into contiguous ranges and runs fn(begin, end) on
// one thread per hardware core. Used for the expensive DE sampling.
template <typename Fn>
void parallel_ranges(int count, Fn fn)
{
    int num_threads =
        static_cast<int>(std::thread::hardware_concurrency());
    num_threads = std::clamp(num_threads, 1, std::max(count, 1));

    std::vector<std::thread> workers;
    for (int t = 0; t < num_threads; ++t)
    {
        const int begin = count * t / num_threads;
        const int end = count * (t + 1) / num_threads;
        if (begin < end)
            workers.emplace_back(fn, begin, end);
    }

    for (std::thread& w : workers)
        w.join();
}

// Bakes the Mandelbox into a triangle mesh in fractal (unit) space.
// res is the sample count along the longest axis of the fractal's
// bounding box; the isosurface DE = half a cell stands in for the
// raymarcher's hit threshold. Every vertex also gets a normal from
// the DE gradient (like calcNormal). iso_world_out receives the
// world-space DE value the surface was extracted at, so the fragment
// shader can re-root the field on the mesh for shadow and AO rays.
Mesh create_mandelbox_mesh(int res, float& iso_world_out)
{
    const auto t0 = std::chrono::steady_clock::now();

    // --- Pass 1: tight bounding box from a coarse scan. Because the
    // DE never overestimates the true distance, every surface point
    // has DE <= half a coarse cell diagonal at its nearest coarse
    // sample, so this threshold provably cannot cut geometry off.
    constexpr int coarse_n = 64;
    constexpr float domain = 8.0f; // generous outer bound
    constexpr float coarse_h = 2.0f * domain / (coarse_n - 1);
    constexpr float coarse_thresh = coarse_h * 0.87f + 0.05f;

    float bb_min[3] = { domain, domain, domain };
    float bb_max[3] = { -domain, -domain, -domain };

    for (int k = 0; k < coarse_n; ++k)
    for (int j = 0; j < coarse_n; ++j)
    for (int i = 0; i < coarse_n; ++i)
    {
        const float x = -domain + coarse_h * i;
        const float y = -domain + coarse_h * j;
        const float z = -domain + coarse_h * k;

        if (mandelbox_de(x, y, z) > coarse_thresh)
            continue;

        bb_min[0] = std::min(bb_min[0], x - coarse_h);
        bb_min[1] = std::min(bb_min[1], y - coarse_h);
        bb_min[2] = std::min(bb_min[2], z - coarse_h);
        bb_max[0] = std::max(bb_max[0], x + coarse_h);
        bb_max[1] = std::max(bb_max[1], y + coarse_h);
        bb_max[2] = std::max(bb_max[2], z + coarse_h);
    }

    // --- Pass 2: sample the DE on a fine grid over the bounding box
    // (cubic cells, res samples along the longest axis), threaded.
    float max_extent = 0.0f;
    for (int a = 0; a < 3; ++a)
        max_extent = std::max(max_extent, bb_max[a] - bb_min[a]);

    const float cell = max_extent / static_cast<float>(res - 1);
    const float iso = cell * 0.5f;
    iso_world_out = iso * mbox::world_scale;

    int ns[3]; // samples per axis
    for (int a = 0; a < 3; ++a)
        ns[a] = static_cast<int>(
            std::ceil((bb_max[a] - bb_min[a]) / cell)) + 1;

    const int n0 = ns[0];
    const int n1 = ns[1];
    const int n2 = ns[2];

    std::vector<float> field(
        static_cast<size_t>(n0) * n1 * n2);

    auto sample_index = [n0, n1](int i, int j, int k) -> size_t
    {
        return (static_cast<size_t>(k) * n1 + j) * n0 + i;
    };

    parallel_ranges(n2, [&](int k_begin, int k_end)
    {
        for (int k = k_begin; k < k_end; ++k)
        for (int j = 0; j < n1; ++j)
        for (int i = 0; i < n0; ++i)
        {
            field[sample_index(i, j, k)] = mandelbox_de(
                bb_min[0] + cell * i,
                bb_min[1] + cell * j,
                bb_min[2] + cell * k
            );
        }
    });

    // --- Pass 3: surface nets. Every cell whose corners straddle the
    // isosurface gets one vertex at the average of its edge crossings;
    // every grid edge that crosses the isosurface connects the four
    // cells around it with a quad.
    const int c0 = n0 - 1;
    const int c1 = n1 - 1;
    const int c2 = n2 - 1;

    std::vector<int> cell_vertex(
        static_cast<size_t>(c0) * c1 * c2, -1);

    auto cell_index = [c0, c1](int i, int j, int k) -> size_t
    {
        return (static_cast<size_t>(k) * c1 + j) * c0 + i;
    };

    // Cube corners as (x, y, z) bit offsets, and the 12 edges as
    // corner index pairs.
    constexpr int edge[12][2] = {
        { 0, 1 }, { 2, 3 }, { 4, 5 }, { 6, 7 }, // along x
        { 0, 2 }, { 1, 3 }, { 4, 6 }, { 5, 7 }, // along y
        { 0, 4 }, { 1, 5 }, { 2, 6 }, { 3, 7 }  // along z
    };

    std::vector<float> vertices; // pos(3) + normal(3)
    std::vector<unsigned int> indices;

    for (int k = 0; k < c2; ++k)
    for (int j = 0; j < c1; ++j)
    for (int i = 0; i < c0; ++i)
    {
        float d[8];
        int inside_mask = 0;
        for (int c = 0; c < 8; ++c)
        {
            d[c] = field[sample_index(
                i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
            if (d[c] < iso)
                inside_mask |= 1 << c;
        }

        if (inside_mask == 0 || inside_mask == 255)
            continue;

        // Average of the isosurface crossings on this cell's edges,
        // in local corner coordinates [0, 1]^3.
        float px = 0.0f;
        float py = 0.0f;
        float pz = 0.0f;
        int crossings = 0;

        for (const auto& e : edge)
        {
            const float da = d[e[0]];
            const float db = d[e[1]];
            if ((da < iso) == (db < iso))
                continue;

            const float t = (iso - da) / (db - da);
            const float ax = static_cast<float>(e[0] & 1);
            const float ay = static_cast<float>((e[0] >> 1) & 1);
            const float az = static_cast<float>((e[0] >> 2) & 1);
            const float bx = static_cast<float>(e[1] & 1);
            const float by = static_cast<float>((e[1] >> 1) & 1);
            const float bz = static_cast<float>((e[1] >> 2) & 1);

            px += ax + (bx - ax) * t;
            py += ay + (by - ay) * t;
            pz += az + (bz - az) * t;
            ++crossings;
        }

        const float inv = 1.0f / static_cast<float>(crossings);
        cell_vertex[cell_index(i, j, k)] =
            static_cast<int>(vertices.size() / 6);

        vertices.insert(vertices.end(), {
            bb_min[0] + cell * (i + px * inv),
            bb_min[1] + cell * (j + py * inv),
            bb_min[2] + cell * (k + pz * inv),
            0.0f, 0.0f, 0.0f // normal, filled in pass 4
        });
    }

    // Quads: one per sign-changing grid edge, joining the vertices of
    // the four cells that share the edge (winding is irrelevant: the
    // mesh is drawn without face culling and normals come from the DE
    // gradient, not the triangles).
    auto emit_quad = [&](int va, int vb, int vc, int vd)
    {
        const unsigned int a = static_cast<unsigned int>(va);
        const unsigned int b = static_cast<unsigned int>(vb);
        const unsigned int c = static_cast<unsigned int>(vc);
        const unsigned int dd = static_cast<unsigned int>(vd);
        indices.insert(indices.end(), { a, b, c, a, c, dd });
    };

    for (int k = 0; k < n2; ++k)
    for (int j = 0; j < n1; ++j)
    for (int i = 0; i < n0; ++i)
    {
        const bool in0 = field[sample_index(i, j, k)] < iso;

        // Edge along x.
        if (i + 1 < n0 && j > 0 && k > 0 && j < c1 && k < c2
            && (field[sample_index(i + 1, j, k)] < iso) != in0)
        {
            emit_quad(
                cell_vertex[cell_index(i, j - 1, k - 1)],
                cell_vertex[cell_index(i, j, k - 1)],
                cell_vertex[cell_index(i, j, k)],
                cell_vertex[cell_index(i, j - 1, k)]
            );
        }

        // Edge along y.
        if (j + 1 < n1 && i > 0 && k > 0 && i < c0 && k < c2
            && (field[sample_index(i, j + 1, k)] < iso) != in0)
        {
            emit_quad(
                cell_vertex[cell_index(i - 1, j, k - 1)],
                cell_vertex[cell_index(i, j, k - 1)],
                cell_vertex[cell_index(i, j, k)],
                cell_vertex[cell_index(i - 1, j, k)]
            );
        }

        // Edge along z.
        if (k + 1 < n2 && i > 0 && j > 0 && i < c0 && j < c1
            && (field[sample_index(i, j, k + 1)] < iso) != in0)
        {
            emit_quad(
                cell_vertex[cell_index(i - 1, j - 1, k)],
                cell_vertex[cell_index(i, j - 1, k)],
                cell_vertex[cell_index(i, j, k)],
                cell_vertex[cell_index(i - 1, j, k)]
            );
        }
    }

    // --- Pass 4: per-vertex normals from the DE gradient (central
    // differences, like worldlib's calcNormal), threaded. Shadows and
    // ambient occlusion are not baked: the fragment shader marches
    // the same DE per pixel, exactly like the raymarched world.
    const int vertex_count = static_cast<int>(vertices.size() / 6);
    const float eps = cell * 0.5f;

    parallel_ranges(vertex_count, [&](int begin, int end)
    {
        for (int v = begin; v < end; ++v)
        {
            float* vert = &vertices[static_cast<size_t>(v) * 6];
            const float x = vert[0];
            const float y = vert[1];
            const float z = vert[2];

            float nx = mandelbox_de(x + eps, y, z)
                     - mandelbox_de(x - eps, y, z);
            float ny = mandelbox_de(x, y + eps, z)
                     - mandelbox_de(x, y - eps, z);
            float nz = mandelbox_de(x, y, z + eps)
                     - mandelbox_de(x, y, z - eps);

            const float len =
                std::sqrt(nx * nx + ny * ny + nz * nz);
            if (len > 1e-12f)
            {
                nx /= len;
                ny /= len;
                nz /= len;
            }
            else
            {
                nx = 0.0f;
                ny = 1.0f;
                nz = 0.0f;
            }

            vert[3] = nx;
            vert[4] = ny;
            vert[5] = nz;
        }
    });

    const auto t1 = std::chrono::steady_clock::now();
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        t1 - t0).count();

    std::cout
        << "Mandelbox mesh (res " << res << ", grid "
        << n0 << "x" << n1 << "x" << n2 << "): "
        << indices.size() / 3 << " triangles, "
        << vertex_count << " vertices, baked in " << ms << " ms\n";

    return upload_mesh(vertices, indices);
}

void delete_mesh(Mesh& mesh)
{
    glDeleteVertexArrays(1, &mesh.vao);
    glDeleteBuffers(1, &mesh.vbo);
    glDeleteBuffers(1, &mesh.ebo);
    mesh = Mesh{};
}

struct RasterUniforms
{
    int cam_pos = -1;
    int cam_rot = -1;
    int resolution = -1;
    int time = -1;
    int model_rot = -1;
    int model_pos = -1;
    int scale = -1;
    int body_id = -1;
    int ring_inner = -1;
    int ring_outer = -1;

    // Hybrid effects (the meshed Mandelbox marches its DE for these);
    // -1 (absent) in programs that don't declare them.
    int iso_offset = -1;
    int enable_shadows = -1;
    int enable_ao = -1;
    int enable_specular = -1;
    int enable_fog = -1;

    // Torus-world lattice cell (integer coords for per-cell coloring).
    int cell = -1;
};

RasterUniforms query_raster_uniforms(unsigned int program)
{
    RasterUniforms u;
    u.cam_pos = glGetUniformLocation(program, "uCamPos");
    u.cam_rot = glGetUniformLocation(program, "uCamRot");
    u.resolution = glGetUniformLocation(program, "uResolution");
    u.time = glGetUniformLocation(program, "uTime");
    u.model_rot = glGetUniformLocation(program, "uModelRot");
    u.model_pos = glGetUniformLocation(program, "uModelPos");
    u.scale = glGetUniformLocation(program, "uScale");
    u.body_id = glGetUniformLocation(program, "uBodyId");
    u.ring_inner = glGetUniformLocation(program, "uRingInner");
    u.ring_outer = glGetUniformLocation(program, "uRingOuter");

    u.iso_offset = glGetUniformLocation(program, "uIsoOffset");
    u.enable_shadows = glGetUniformLocation(program, "uEnableShadows");
    u.enable_ao = glGetUniformLocation(program, "uEnableAO");
    u.enable_specular = glGetUniformLocation(program, "uEnableSpecular");
    u.enable_fog = glGetUniformLocation(program, "uEnableFog");
    u.cell = glGetUniformLocation(program, "uCell");
    return u;
}

// Orbital parameters, mirroring the constants in fractal_galaxy.frag.
namespace solar
{
    constexpr int num_planets = 8;
    constexpr float sun_pos[3] = { 0.0f, 2.0f, 90.0f };
    constexpr float sun_radius = 10.0f;

    constexpr float orbit_r[8] =
        { 16.0f, 22.0f, 28.0f, 34.0f, 46.0f, 58.0f, 68.0f, 77.0f };
    constexpr float size[8] =
        { 1.3f, 2.2f, 2.4f, 1.7f, 6.0f, 5.0f, 3.4f, 3.3f };
    constexpr float omega[8] =
        { 0.625f, 0.388f, 0.270f, 0.202f, 0.128f, 0.090f, 0.071f, 0.059f };
    constexpr float phase[8] =
        { 0.0f, 0.9f, 2.1f, 3.4f, 4.2f, 5.1f, 0.6f, 2.8f };
    constexpr float tilt[8] =
        { 0.05f, 3.09f, 0.41f, 0.44f, 0.05f, 0.47f, 1.71f, 0.49f };
    constexpr float spin[8] =
        { 0.08f, -0.03f, 0.35f, 0.33f, 0.60f, 0.55f, -0.40f, 0.45f };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

int main(int argc, char** argv)
{
    if (!glfwInit())
    {
        std::cerr << "Failed to initialize GLFW\n";
        return 1;
    }

    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 3);
    glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);

    GLFWwindow* window = glfwCreateWindow(
        800,
        600,
        "RayMarching",
        nullptr,
        nullptr
    );

    if (window == nullptr)
    {
        std::cerr << "Failed to create GLFW window\n";
        glfwTerminate();
        return 1;
    }

    glfwMakeContextCurrent(window);

    if (!gladLoadGLLoader(
            reinterpret_cast<GLADloadproc>(glfwGetProcAddress)))
    {
        std::cerr << "Failed to initialize GLAD\n";
        glfwDestroyWindow(window);
        glfwTerminate();
        return 1;
    }

    glfwGetFramebufferSize(
        window,
        &g_framebuffer_width,
        &g_framebuffer_height
    );

    glViewport(
        0,
        0,
        g_framebuffer_width,
        g_framebuffer_height
    );

    glfwSetFramebufferSizeCallback(
        window,
        framebuffer_size_callback
    );

    // Capture the cursor for mouse-look. Raw motion (when available)
    // avoids OS cursor acceleration affecting the camera.
    glfwSetInputMode(window, GLFW_CURSOR, GLFW_CURSOR_DISABLED);
    if (glfwRawMouseMotionSupported())
        glfwSetInputMode(window, GLFW_RAW_MOUSE_MOTION, GLFW_TRUE);

    // Seed the last-cursor position so the first mouse event does not
    // produce a huge spurious camera rotation.
    glfwGetCursorPos(window, &g_last_cursor_x, &g_last_cursor_y);
    g_first_cursor_event = false;

    glfwSetCursorPosCallback(window, cursor_pos_callback);

    // Dear ImGui setup. Installing callbacks after ours are registered
    // lets the backend chain to them instead of replacing them.
    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGui::GetIO().IniFilename = nullptr; // no imgui.ini clutter
    ImGui::StyleColorsDark();
    ImGui_ImplGlfw_InitForOpenGL(window, true);
    ImGui_ImplOpenGL3_Init("#version 330");

    std::cout
        << "OpenGL version: "
        << reinterpret_cast<const char*>(glGetString(GL_VERSION))
        << '\n';

    std::cout
        << "GPU: "
        << reinterpret_cast<const char*>(glGetString(GL_RENDERER))
        << '\n';

    std::cout
        << "Vendor: "
        << reinterpret_cast<const char*>(glGetString(GL_VENDOR))
        << '\n';

    std::cout
        << "GLSL version: "
        << reinterpret_cast<const char*>(
               glGetString(GL_SHADING_LANGUAGE_VERSION)
           )
        << '\n';

    const char* vertex_path = "assets/shaders/basic.glsl";
    const char* shader_directory = "assets/shaders";

    // An optional command-line argument selects the startup world,
    // e.g. `RayMarching assets/shaders/fractal.frag`.
    std::string current_fragment = (argc > 1)
        ? argv[1]
        : "assets/shaders/raymarch.frag";
    std::vector<std::string> shader_files =
        list_fragment_shaders(shader_directory);

    unsigned int shader_program = create_shader_program(
        vertex_path,
        current_fragment.c_str()
    );

    if (shader_program == 0)
    {
        glfwDestroyWindow(window);
        glfwTerminate();
        return 1;
    }

    Uniforms uniforms = query_uniforms(shader_program);
    Effects effects;

    // --- Traditional rasterization pipeline (mesh solar system). ---
    const char* raster_vertex_path = "assets/shaders/raster/planets.vert";
    const char* raster_fragment_path = "assets/shaders/raster/planets.frag";
    const char* raster_sky_path = "assets/shaders/raster/sky.frag";

    // Which world the mesh pipeline renders instead of the fullscreen
    // raymarching quad.
    constexpr int kRasterNone = -1;   // raymarching active
    constexpr int kRasterSolar = 0;   // mesh solar system
    constexpr int kRasterMandelbox = 1;  // meshed Mandelbox
    constexpr int kRasterTorus = 2;   // torus world lattice
    int raster_scene = kRasterNone;

    unsigned int raster_program = 0;
    unsigned int sky_program = 0;
    RasterUniforms raster_uniforms;
    int sky_u_resolution = -1;
    int sky_u_time = -1;
    int sky_u_cam_rot = -1;

    auto load_raster_programs = [&]() -> bool
    {
        const unsigned int new_raster = create_shader_program(
            raster_vertex_path,
            raster_fragment_path
        );
        // The sky pass reuses the fullscreen-quad vertex shader.
        const unsigned int new_sky = create_shader_program(
            vertex_path,
            raster_sky_path
        );

        if (new_raster == 0 || new_sky == 0)
        {
            if (new_raster != 0)
                glDeleteProgram(new_raster);
            if (new_sky != 0)
                glDeleteProgram(new_sky);
            std::cerr
                << "Raster shader load failed; "
                << "keeping previous programs.\n";
            return false;
        }

        if (raster_program != 0)
            glDeleteProgram(raster_program);
        if (sky_program != 0)
            glDeleteProgram(sky_program);

        raster_program = new_raster;
        sky_program = new_sky;
        raster_uniforms = query_raster_uniforms(raster_program);
        sky_u_resolution = glGetUniformLocation(sky_program, "uResolution");
        sky_u_time = glGetUniformLocation(sky_program, "uTime");
        sky_u_cam_rot = glGetUniformLocation(sky_program, "uCamRot");
        return true;
    };

    load_raster_programs();

    // --- Mandelbox raster pipeline (own vertex format: baked AO). ---
    const char* mbox_vertex_path = "assets/shaders/raster/mandelbox.vert";
    const char* mbox_fragment_path = "assets/shaders/raster/mandelbox.frag";
    const char* mbox_sky_path = "assets/shaders/raster/mandelbox_sky.frag";

    unsigned int mbox_program = 0;
    unsigned int mbox_sky_program = 0;
    RasterUniforms mbox_uniforms;
    int mbox_sky_u_resolution = -1;
    int mbox_sky_u_cam_rot = -1;
    int mbox_sky_u_cam_pos = -1;

    auto load_mbox_programs = [&]() -> bool
    {
        const unsigned int new_mbox = create_shader_program(
            mbox_vertex_path,
            mbox_fragment_path
        );
        // The sky pass reuses the fullscreen-quad vertex shader.
        const unsigned int new_sky = create_shader_program(
            vertex_path,
            mbox_sky_path
        );

        if (new_mbox == 0 || new_sky == 0)
        {
            if (new_mbox != 0)
                glDeleteProgram(new_mbox);
            if (new_sky != 0)
                glDeleteProgram(new_sky);
            std::cerr
                << "Mandelbox shader load failed; "
                << "keeping previous programs.\n";
            return false;
        }

        if (mbox_program != 0)
            glDeleteProgram(mbox_program);
        if (mbox_sky_program != 0)
            glDeleteProgram(mbox_sky_program);

        mbox_program = new_mbox;
        mbox_sky_program = new_sky;
        mbox_uniforms = query_raster_uniforms(mbox_program);
        mbox_sky_u_resolution =
            glGetUniformLocation(mbox_sky_program, "uResolution");
        mbox_sky_u_cam_rot =
            glGetUniformLocation(mbox_sky_program, "uCamRot");
        mbox_sky_u_cam_pos =
            glGetUniformLocation(mbox_sky_program, "uCamPos");
        return true;
    };

    load_mbox_programs();

    // --- Torus-world raster pipeline (lattice of mesh tori). ---
    const char* torus_vertex_path = "assets/shaders/raster/torus.vert";
    const char* torus_fragment_path = "assets/shaders/raster/torus.frag";
    const char* torus_sky_path = "assets/shaders/raster/torus_sky.frag";

    unsigned int torus_program = 0;
    unsigned int torus_sky_program = 0;
    RasterUniforms torus_uniforms;
    int torus_sky_u_resolution = -1;
    int torus_sky_u_time = -1;
    int torus_sky_u_cam_rot = -1;
    int torus_sky_u_cam_pos = -1;

    auto load_torus_programs = [&]() -> bool
    {
        const unsigned int new_torus = create_shader_program(
            torus_vertex_path,
            torus_fragment_path
        );
        const unsigned int new_sky = create_shader_program(
            vertex_path,
            torus_sky_path
        );

        if (new_torus == 0 || new_sky == 0)
        {
            if (new_torus != 0)
                glDeleteProgram(new_torus);
            if (new_sky != 0)
                glDeleteProgram(new_sky);
            std::cerr
                << "Torus-world shader load failed; "
                << "keeping previous programs.\n";
            return false;
        }

        if (torus_program != 0)
            glDeleteProgram(torus_program);
        if (torus_sky_program != 0)
            glDeleteProgram(torus_sky_program);

        torus_program = new_torus;
        torus_sky_program = new_sky;
        torus_uniforms = query_raster_uniforms(torus_program);
        torus_sky_u_resolution =
            glGetUniformLocation(torus_sky_program, "uResolution");
        torus_sky_u_time =
            glGetUniformLocation(torus_sky_program, "uTime");
        torus_sky_u_cam_rot =
            glGetUniformLocation(torus_sky_program, "uCamRot");
        torus_sky_u_cam_pos =
            glGetUniformLocation(torus_sky_program, "uCamPos");
        return true;
    };

    load_torus_programs();

    // Compiles the given fragment shader and swaps it in on success;
    // on failure the current program keeps running.
    auto load_fragment = [&](const std::string& fragment_path) -> bool
    {
        const unsigned int new_program = create_shader_program(
            vertex_path,
            fragment_path.c_str()
        );

        if (new_program == 0)
        {
            std::cerr
                << "Shader load failed; keeping previous program.\n";
            return false;
        }

        glDeleteProgram(shader_program);
        shader_program = new_program;
        uniforms = query_uniforms(shader_program);

        // Switching to a different world resets the camera to the
        // starting pose; reloading the current one keeps it.
        if (fragment_path != current_fragment)
            g_camera = Camera{};

        current_fragment = fragment_path;
        return true;
    };

    // Full-screen quad in normalized device coordinates
    // (two triangles covering [-1, 1] x [-1, 1]).
    float vertices[] = {
        -1.0f, -1.0f, 0.0f,
         1.0f, -1.0f, 0.0f,
         1.0f,  1.0f, 0.0f,

        -1.0f, -1.0f, 0.0f,
         1.0f,  1.0f, 0.0f,
        -1.0f,  1.0f, 0.0f
    };

    unsigned int VAO = 0;
    unsigned int VBO = 0;

    glGenVertexArrays(1, &VAO);
    glGenBuffers(1, &VBO);

    glBindVertexArray(VAO);

    glBindBuffer(GL_ARRAY_BUFFER, VBO);
    glBufferData(GL_ARRAY_BUFFER, sizeof(vertices), vertices, GL_STATIC_DRAW);

    glVertexAttribPointer(
        0,
        3,
        GL_FLOAT,
        GL_FALSE,
        3 * sizeof(float),
        reinterpret_cast<void*>(0)
    );
    glEnableVertexAttribArray(0);

    glBindVertexArray(0);

    // Meshes for the rasterized solar system. One shared unit sphere
    // for every round body; annuli at each planet's ring proportions.
    Mesh sphere_mesh = create_sphere_mesh(64, 128);
    Mesh saturn_ring_mesh = create_annulus_mesh(1.35f, 2.10f, 128);
    Mesh uranus_ring_mesh = create_annulus_mesh(1.45f, 1.75f, 128);

    // Torus matching torus_world.frag (major 2, tube 0.6).
    Mesh torus_mesh = create_torus_mesh(2.0f, 0.6f, 64, 32);

    // The Mandelbox mesh is baked lazily on first selection and
    // rebaked when the resolution changes (sampling the DE on a
    // ~384^3 grid takes several seconds, so don't pay it at startup).
    int mbox_res = 384;
    float mbox_iso_world = 0.0f;
    Mesh mbox_mesh;

    // VSync on by default; turn it off in the menu when comparing
    // framerates, otherwise both renderers cap at the refresh rate.
    bool vsync = true;
    glfwSwapInterval(1);

    double last_frame_time = glfwGetTime();

    // FPS counter state.
    double fps_timer = last_frame_time;
    int fps_frame_count = 0;

    // Edge detection for the hot-reload and menu toggle keys.
    bool reload_key_was_down = false;
    bool menu_key_was_down = false;

    while (!glfwWindowShouldClose(window))
    {
        const double now = glfwGetTime();
        const float delta_time = static_cast<float>(now - last_frame_time);
        last_frame_time = now;

        process_input(window, delta_time);

        // Tab toggles the menu: release the cursor for the UI, or
        // recapture it for mouse-look.
        const bool menu_key_down =
            glfwGetKey(window, GLFW_KEY_TAB) == GLFW_PRESS;

        if (menu_key_down && !menu_key_was_down)
        {
            g_menu_open = !g_menu_open;

            if (g_menu_open)
            {
                glfwSetInputMode(window, GLFW_CURSOR, GLFW_CURSOR_NORMAL);
            }
            else
            {
                glfwSetInputMode(window, GLFW_CURSOR, GLFW_CURSOR_DISABLED);
                // Discard the next cursor delta so the camera does not
                // jump to wherever the cursor was while the menu was open.
                g_first_cursor_event = true;
            }
        }
        menu_key_was_down = menu_key_down;

        // Shader hot-reload on R (rising edge). On failure the old
        // program is kept so development can continue uninterrupted.
        const bool reload_key_down =
            glfwGetKey(window, GLFW_KEY_R) == GLFW_PRESS;

        if (reload_key_down && !reload_key_was_down)
        {
            bool ok = false;
            if (raster_scene == kRasterSolar)
                ok = load_raster_programs();
            else if (raster_scene == kRasterMandelbox)
                ok = load_mbox_programs();
            else if (raster_scene == kRasterTorus)
                ok = load_torus_programs();
            else
                ok = load_fragment(current_fragment);
            if (ok)
                std::cout << "Shaders reloaded.\n";
        }
        reload_key_was_down = reload_key_down;

        // Build the UI for this frame.
        ImGui_ImplOpenGL3_NewFrame();
        ImGui_ImplGlfw_NewFrame();
        ImGui::NewFrame();

        if (g_menu_open)
        {
            ImGui::SetNextWindowPos(
                ImVec2(10.0f, 10.0f),
                ImGuiCond_FirstUseEver
            );
            ImGui::Begin(
                "Menu",
                nullptr,
                ImGuiWindowFlags_AlwaysAutoResize
            );

            const float fps = ImGui::GetIO().Framerate;
            ImGui::Text(
                "%.1f FPS (%.2f ms)",
                fps,
                fps > 0.0f ? 1000.0f / fps : 0.0f
            );

            if (ImGui::Checkbox("VSync", &vsync))
                glfwSwapInterval(vsync ? 1 : 0);

            ImGui::Separator();

            // Worlds, grouped by rendering technique. Selecting an
            // entry from the other group switches pipelines (and
            // resets the camera, like any world change).
            if (ImGui::CollapsingHeader(
                    "Ray marching (fragment shader)",
                    ImGuiTreeNodeFlags_DefaultOpen))
            {
                for (const std::string& file : shader_files)
                {
                    const std::string name =
                        std::filesystem::path(file).filename().string();
                    const bool is_selected =
                        raster_scene == kRasterNone
                        && (file == current_fragment);

                    if (ImGui::Selectable(name.c_str(), is_selected)
                        && !is_selected)
                    {
                        if (raster_scene != kRasterNone)
                        {
                            raster_scene = kRasterNone;
                            // Same world, different pipeline: still a
                            // fresh start.
                            if (file == current_fragment)
                                g_camera = Camera{};
                        }
                        load_fragment(file);
                    }
                }
            }

            if (ImGui::CollapsingHeader(
                    "Rasterization (vertex + fragment)",
                    ImGuiTreeNodeFlags_DefaultOpen))
            {
                if (ImGui::Selectable(
                        "solar_system (mesh)",
                        raster_scene == kRasterSolar)
                    && raster_scene != kRasterSolar)
                {
                    if (raster_program == 0)
                        load_raster_programs();

                    if (raster_program != 0)
                    {
                        raster_scene = kRasterSolar;
                        g_camera = Camera{};
                    }
                }

                if (raster_program == 0)
                    ImGui::TextColored(
                        ImVec4(1.0f, 0.4f, 0.4f, 1.0f),
                        "raster shaders failed to compile"
                    );

                if (ImGui::Selectable(
                        "large_fractal (mesh)",
                        raster_scene == kRasterMandelbox)
                    && raster_scene != kRasterMandelbox)
                {
                    if (mbox_program == 0)
                        load_mbox_programs();

                    if (mbox_program != 0)
                    {
                        if (mbox_mesh.index_count == 0)
                            mbox_mesh = create_mandelbox_mesh(
                                mbox_res, mbox_iso_world);
                        raster_scene = kRasterMandelbox;
                        g_camera = Camera{};
                    }
                }

                if (mbox_program == 0)
                    ImGui::TextColored(
                        ImVec4(1.0f, 0.4f, 0.4f, 1.0f),
                        "mandelbox shaders failed to compile"
                    );

                // Bake resolution (samples along the longest axis);
                // rebaking takes a moment, so wait for slider release.
                if (raster_scene == kRasterMandelbox)
                {
                    ImGui::SliderInt(
                        "Mesh resolution", &mbox_res, 96, 512);
                    if (ImGui::IsItemDeactivatedAfterEdit())
                    {
                        delete_mesh(mbox_mesh);
                        mbox_mesh = create_mandelbox_mesh(
                            mbox_res, mbox_iso_world);
                    }
                }

                if (ImGui::Selectable(
                        "torus_world (mesh)",
                        raster_scene == kRasterTorus)
                    && raster_scene != kRasterTorus)
                {
                    if (torus_program == 0)
                        load_torus_programs();

                    if (torus_program != 0)
                    {
                        raster_scene = kRasterTorus;
                        g_camera = Camera{};
                    }
                }

                if (torus_program == 0)
                    ImGui::TextColored(
                        ImVec4(1.0f, 0.4f, 0.4f, 1.0f),
                        "torus shaders failed to compile"
                    );
            }

            if (ImGui::Button("Rescan"))
                shader_files = list_fragment_shaders(shader_directory);

            ImGui::SameLine();

            if (ImGui::Button("Reload"))
            {
                if (raster_scene == kRasterSolar)
                    load_raster_programs();
                else if (raster_scene == kRasterMandelbox)
                    load_mbox_programs();
                else if (raster_scene == kRasterTorus)
                    load_torus_programs();
                else
                    load_fragment(current_fragment);
            }

            ImGui::Separator();
            ImGui::TextDisabled("Controls");
            ImGui::SliderFloat(
                "Move speed",
                &g_move_speed,
                0.5f,
                600.0f,
                "%.1f",
                ImGuiSliderFlags_Logarithmic
            );

            // Effect toggles; worlds that lack the matching uniform
            // simply ignore them.
            ImGui::Separator();
            ImGui::TextDisabled("Effects");
            ImGui::Checkbox("Shadows", &effects.shadows);
            ImGui::Checkbox("Ambient occlusion", &effects.ao);
            ImGui::Checkbox("Specular", &effects.specular);
            ImGui::Checkbox("Fog", &effects.fog);
            ImGui::SliderFloat(
                "Curvature",
                &effects.curve_scale,
                0.0f,
                2.0f,
                "%.2f"
            );

            ImGui::TextDisabled("Tab closes the menu. R reloads.");
            ImGui::End();
        }

        glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

        const float res_x = static_cast<float>(g_framebuffer_width);
        const float res_y = static_cast<float>(g_framebuffer_height);
        const float time = static_cast<float>(now);

        float basis[9];
        camera_basis(g_camera, basis);

        if (raster_scene == kRasterSolar && raster_program != 0)
        {
            // Background first, without depth writes, then the meshes
            // with a real depth buffer.
            glDisable(GL_DEPTH_TEST);
            glUseProgram(sky_program);
            glUniform2f(sky_u_resolution, res_x, res_y);
            glUniform1f(sky_u_time, time);
            glUniformMatrix3fv(sky_u_cam_rot, 1, GL_FALSE, basis);
            glBindVertexArray(VAO);
            glDrawArrays(GL_TRIANGLES, 0, 6);

            glEnable(GL_DEPTH_TEST);
            glUseProgram(raster_program);
            const RasterUniforms& ru = raster_uniforms;
            glUniform2f(ru.resolution, res_x, res_y);
            glUniform1f(ru.time, time);
            glUniform3f(ru.cam_pos, g_camera.x, g_camera.y, g_camera.z);
            glUniformMatrix3fv(ru.cam_rot, 1, GL_FALSE, basis);

            auto draw_body = [&](
                const Mesh& mesh,
                int body_id,
                const float rot[9],
                float px, float py, float pz,
                float scale,
                float ring_inner, float ring_outer)
            {
                glUniformMatrix3fv(ru.model_rot, 1, GL_FALSE, rot);
                glUniform3f(ru.model_pos, px, py, pz);
                glUniform1f(ru.scale, scale);
                glUniform1i(ru.body_id, body_id);
                glUniform1f(ru.ring_inner, ring_inner);
                glUniform1f(ru.ring_outer, ring_outer);
                glBindVertexArray(mesh.vao);
                glDrawElements(
                    GL_TRIANGLES,
                    mesh.index_count,
                    GL_UNSIGNED_INT,
                    nullptr
                );
            };

            const float identity[9] =
                { 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f };

            draw_body(
                sphere_mesh, 8, identity,
                solar::sun_pos[0], solar::sun_pos[1], solar::sun_pos[2],
                solar::sun_radius, 0.0f, 0.0f
            );

            for (int i = 0; i < solar::num_planets; ++i)
            {
                const float a = solar::phase[i] + time * solar::omega[i];
                const float cx =
                    solar::sun_pos[0] + std::cos(a) * solar::orbit_r[i];
                const float cy = solar::sun_pos[1];
                const float cz =
                    solar::sun_pos[2] + std::sin(a) * solar::orbit_r[i];

                // The shader maps world to local with
                // rotY(spin t) * rotX(tilt); the mesh model rotation
                // is the inverse: rotX(-tilt) * rotY(-spin t).
                float rx[9];
                float ry[9];
                float rot[9];
                mat3_rot_x(-solar::tilt[i], rx);
                mat3_rot_y(-time * solar::spin[i], ry);
                mat3_mul(rx, ry, rot);

                draw_body(
                    sphere_mesh, i, rot,
                    cx, cy, cz, solar::size[i], 0.0f, 0.0f
                );

                if (i == 2) // Earth's Moon
                {
                    const float ma = time * 0.45f + 1.3f;
                    draw_body(
                        sphere_mesh, 9, identity,
                        cx + std::cos(ma) * 4.3f,
                        cy + 0.18f * std::sin(ma * 0.7f) * 4.3f,
                        cz + std::sin(ma) * 4.3f,
                        0.6f, 0.0f, 0.0f
                    );
                }

                // Rings tilt with the planet but do not spin (they are
                // rotationally symmetric).
                if (i == 5)
                    draw_body(
                        saturn_ring_mesh, 10, rx,
                        cx, cy, cz, solar::size[i], 1.35f, 2.10f
                    );
                if (i == 6)
                    draw_body(
                        uranus_ring_mesh, 11, rx,
                        cx, cy, cz, solar::size[i], 1.45f, 1.75f
                    );
            }

            glDisable(GL_DEPTH_TEST);
        }
        else if (raster_scene == kRasterMandelbox && mbox_program != 0)
        {
            // Background first, without depth writes, then the mesh
            // with a real depth buffer.
            glDisable(GL_DEPTH_TEST);
            glUseProgram(mbox_sky_program);
            glUniform2f(mbox_sky_u_resolution, res_x, res_y);
            glUniformMatrix3fv(mbox_sky_u_cam_rot, 1, GL_FALSE, basis);
            glUniform3f(
                mbox_sky_u_cam_pos, g_camera.x, g_camera.y, g_camera.z);
            glBindVertexArray(VAO);
            glDrawArrays(GL_TRIANGLES, 0, 6);

            glEnable(GL_DEPTH_TEST);
            glUseProgram(mbox_program);
            const RasterUniforms& mu = mbox_uniforms;
            glUniform2f(mu.resolution, res_x, res_y);
            glUniform3f(mu.cam_pos, g_camera.x, g_camera.y, g_camera.z);
            glUniformMatrix3fv(mu.cam_rot, 1, GL_FALSE, basis);

            // Static, like the raymarched world: identity rotation,
            // same offset and uniform scale as large_fractal's map().
            const float identity[9] =
                { 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f };
            glUniformMatrix3fv(mu.model_rot, 1, GL_FALSE, identity);
            glUniform3f(
                mu.model_pos,
                mbox::pos[0], mbox::pos[1], mbox::pos[2]
            );
            glUniform1f(mu.scale, mbox::world_scale);

            // Hybrid effects: the fragment shader marches the DE for
            // shadows and AO, honoring the same menu toggles as the
            // raymarched worlds.
            glUniform1f(mu.iso_offset, mbox_iso_world);
            glUniform1i(mu.enable_shadows, effects.shadows ? 1 : 0);
            glUniform1i(mu.enable_ao, effects.ao ? 1 : 0);
            glUniform1i(mu.enable_specular, effects.specular ? 1 : 0);
            glUniform1i(mu.enable_fog, effects.fog ? 1 : 0);

            glBindVertexArray(mbox_mesh.vao);
            glDrawElements(
                GL_TRIANGLES,
                mbox_mesh.index_count,
                GL_UNSIGNED_INT,
                nullptr
            );

            glDisable(GL_DEPTH_TEST);
        }
        else if (raster_scene == kRasterTorus && torus_program != 0)
        {
            // Background first (sky + grazing glow), then a lattice of
            // mesh tori covering the same MAX_DISTANCE = 220 as the
            // raymarched world. Instances are centered on the camera
            // cell and distance-culled so fog can hide the far edge.
            // Curved rays still cannot be reproduced with a depth
            // buffer - set Curvature to 0 for the closest match.
            glDisable(GL_DEPTH_TEST);
            glUseProgram(torus_sky_program);
            glUniform2f(torus_sky_u_resolution, res_x, res_y);
            glUniform1f(torus_sky_u_time, time);
            glUniformMatrix3fv(torus_sky_u_cam_rot, 1, GL_FALSE, basis);
            glUniform3f(
                torus_sky_u_cam_pos, g_camera.x, g_camera.y, g_camera.z);
            glBindVertexArray(VAO);
            glDrawArrays(GL_TRIANGLES, 0, 6);

            glEnable(GL_DEPTH_TEST);
            glUseProgram(torus_program);
            const RasterUniforms& tu = torus_uniforms;
            glUniform2f(tu.resolution, res_x, res_y);
            glUniform1f(tu.time, time);
            glUniform3f(tu.cam_pos, g_camera.x, g_camera.y, g_camera.z);
            glUniformMatrix3fv(tu.cam_rot, 1, GL_FALSE, basis);
            glUniform1i(tu.enable_shadows, effects.shadows ? 1 : 0);
            glUniform1i(tu.enable_ao, effects.ao ? 1 : 0);
            glUniform1i(tu.enable_specular, effects.specular ? 1 : 0);
            glUniform1i(tu.enable_fog, effects.fog ? 1 : 0);

            // Match torus_world.frag: REPEAT 9, MAX_DISTANCE 220.
            constexpr float kRepeat = 9.0f;
            constexpr float kMaxDist = 220.0f;
            constexpr float kTorusReach = 2.6f; // major + tube
            constexpr int kHalf = 25; // ceil(220 / 9)

            const int cell_x = static_cast<int>(std::floor(
                (g_camera.x + 0.5f * kRepeat) / kRepeat));
            const int cell_y = static_cast<int>(std::floor(
                (g_camera.y + 0.5f * kRepeat) / kRepeat));
            const int cell_z = static_cast<int>(std::floor(
                (g_camera.z + 0.5f * kRepeat) / kRepeat));

            const float cull_r = kMaxDist + kTorusReach;
            const float cull_r2 = cull_r * cull_r;

            glBindVertexArray(torus_mesh.vao);

            for (int dz = -kHalf; dz <= kHalf; ++dz)
            for (int dy = -kHalf; dy <= kHalf; ++dy)
            for (int dx = -kHalf; dx <= kHalf; ++dx)
            {
                const float px =
                    static_cast<float>(cell_x + dx) * kRepeat;
                const float py =
                    static_cast<float>(cell_y + dy) * kRepeat;
                const float pz =
                    static_cast<float>(cell_z + dz) * kRepeat;

                const float ox = px - g_camera.x;
                const float oy = py - g_camera.y;
                const float oz = pz - g_camera.z;
                if (ox * ox + oy * oy + oz * oz > cull_r2)
                    continue;

                glUniform3f(tu.model_pos, px, py, pz);
                glDrawElements(
                    GL_TRIANGLES,
                    torus_mesh.index_count,
                    GL_UNSIGNED_INT,
                    nullptr
                );
            }

            glDisable(GL_DEPTH_TEST);
        }
        else
        {
            glDisable(GL_DEPTH_TEST);
            glUseProgram(shader_program);

            glUniform2f(uniforms.resolution, res_x, res_y);
            glUniform1f(uniforms.time, time);
            glUniform3f(
                uniforms.cam_pos, g_camera.x, g_camera.y, g_camera.z);

            glUniform1i(uniforms.enable_shadows, effects.shadows ? 1 : 0);
            glUniform1i(uniforms.enable_ao, effects.ao ? 1 : 0);
            glUniform1i(
                uniforms.enable_specular, effects.specular ? 1 : 0);
            glUniform1i(uniforms.enable_fog, effects.fog ? 1 : 0);
            glUniform1f(uniforms.curve_scale, effects.curve_scale);

            glUniformMatrix3fv(uniforms.cam_rot, 1, GL_FALSE, basis);

            glBindVertexArray(VAO);
            glDrawArrays(GL_TRIANGLES, 0, 6);
        }

        ImGui::Render();
        ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());

        glfwSwapBuffers(window);
        glfwPollEvents();

        // Update the FPS counter in the window title once per second.
        ++fps_frame_count;
        if (now - fps_timer >= 1.0)
        {
            const double fps = fps_frame_count / (now - fps_timer);
            const double frame_ms = 1000.0 / (fps > 0.0 ? fps : 1.0);

            char title[128];
            std::snprintf(
                title,
                sizeof(title),
                "RayMarching - %.1f FPS (%.2f ms)",
                fps,
                frame_ms
            );
            glfwSetWindowTitle(window, title);

            fps_timer = now;
            fps_frame_count = 0;
        }
    }

    ImGui_ImplOpenGL3_Shutdown();
    ImGui_ImplGlfw_Shutdown();
    ImGui::DestroyContext();

    glDeleteVertexArrays(1, &VAO);
    glDeleteBuffers(1, &VBO);
    glDeleteProgram(shader_program);

    delete_mesh(sphere_mesh);
    delete_mesh(saturn_ring_mesh);
    delete_mesh(uranus_ring_mesh);
    delete_mesh(mbox_mesh);
    delete_mesh(torus_mesh);
    if (raster_program != 0)
        glDeleteProgram(raster_program);
    if (sky_program != 0)
        glDeleteProgram(sky_program);
    if (mbox_program != 0)
        glDeleteProgram(mbox_program);
    if (mbox_sky_program != 0)
        glDeleteProgram(mbox_sky_program);
    if (torus_program != 0)
        glDeleteProgram(torus_program);
    if (torus_sky_program != 0)
        glDeleteProgram(torus_sky_program);

    glfwDestroyWindow(window);
    glfwTerminate();

    return 0;
}
