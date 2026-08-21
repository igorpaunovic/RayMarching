#include <glad/glad.h>
#include <GLFW/glfw3.h>

#include <imgui.h>
#include <imgui_impl_glfw.h>
#include <imgui_impl_opengl3.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
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

void process_input(GLFWwindow* window, float delta_time)
{
    if (glfwGetKey(window, GLFW_KEY_ESCAPE) == GLFW_PRESS)
        glfwSetWindowShouldClose(window, true);

    // While the menu is open the keyboard belongs to the UI.
    if (g_menu_open)
        return;

    float speed = 6.0f * delta_time;
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

// Uniform locations for the ray marching shader.
struct Uniforms
{
    int resolution = -1;
    int time = -1;
    int cam_pos = -1;
    int cam_rot = -1;
};

Uniforms query_uniforms(unsigned int program)
{
    Uniforms u;
    u.resolution = glGetUniformLocation(program, "uResolution");
    u.time = glGetUniformLocation(program, "uTime");
    u.cam_pos = glGetUniformLocation(program, "uCamPos");
    u.cam_rot = glGetUniformLocation(program, "uCamRot");
    return u;
}

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
            if (load_fragment(current_fragment))
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
            ImGui::Separator();

            const std::string current_name =
                std::filesystem::path(current_fragment).filename().string();

            if (ImGui::BeginCombo("World", current_name.c_str()))
            {
                for (const std::string& file : shader_files)
                {
                    const std::string name =
                        std::filesystem::path(file).filename().string();
                    const bool is_selected = (file == current_fragment);

                    if (ImGui::Selectable(name.c_str(), is_selected)
                        && !is_selected)
                    {
                        load_fragment(file);
                    }

                    if (is_selected)
                        ImGui::SetItemDefaultFocus();
                }
                ImGui::EndCombo();
            }

            if (ImGui::Button("Rescan"))
                shader_files = list_fragment_shaders(shader_directory);

            ImGui::SameLine();

            if (ImGui::Button("Reload"))
                load_fragment(current_fragment);

            ImGui::TextDisabled("Tab closes the menu. R reloads.");
            ImGui::End();
        }

        glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);

        glUseProgram(shader_program);

        glUniform2f(
            uniforms.resolution,
            static_cast<float>(g_framebuffer_width),
            static_cast<float>(g_framebuffer_height)
        );
        glUniform1f(uniforms.time, static_cast<float>(now));
        glUniform3f(uniforms.cam_pos, g_camera.x, g_camera.y, g_camera.z);

        float basis[9];
        camera_basis(g_camera, basis);
        glUniformMatrix3fv(uniforms.cam_rot, 1, GL_FALSE, basis);

        glBindVertexArray(VAO);
        glDrawArrays(GL_TRIANGLES, 0, 6);

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

    glfwDestroyWindow(window);
    glfwTerminate();

    return 0;
}
