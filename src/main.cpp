#include <glad/glad.h>
#include <GLFW/glfw3.h>

#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

void framebuffer_size_callback(GLFWwindow*, int width, int height)
{
    glViewport(0, 0, width, height);
}

void process_input(GLFWwindow *window)
{
    if(glfwGetKey(window, GLFW_KEY_ESCAPE) == GLFW_PRESS)
        glfwSetWindowShouldClose(window, true);
}

std::string load_shader_source(const char* path)
{
    std::ifstream file(path);

    if (!file.is_open())
    {
        std::cerr << "Failed to open shader file: " << path << '\n';
        return {};
    }

    std::stringstream buffer;
    buffer << file.rdbuf();
    return buffer.str();
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

int main()
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

    // Get the actual framebuffer dimensions.
    // These may differ from the requested window dimensions on high-DPI screens.
    int framebufferWidth = 0;
    int framebufferHeight = 0;

    glfwGetFramebufferSize(
        window,
        &framebufferWidth,
        &framebufferHeight
    );

    // Configure the initial OpenGL viewport.
    glViewport(
        0,
        0,
        framebufferWidth,
        framebufferHeight
    );

    // Update the viewport whenever the framebuffer is resized.
    glfwSetFramebufferSizeCallback(
        window,
        framebuffer_size_callback
    );

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

    const unsigned int shader_program = create_shader_program(
        "assets/shaders/basic.glsl",
        "assets/shaders/basic.frag"
    );

    if (shader_program == 0)
    {
        glfwDestroyWindow(window);
        glfwTerminate();
        return 1;
    }

    float vertices[] = {
        -0.5f, -0.5f, 0.0f,
         0.5f, -0.5f, 0.0f,
         0.0f,  0.5f, 0.0f
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

    while (!glfwWindowShouldClose(window))
    {
        process_input(window);

        glClearColor(0.2f, 0.3f, 0.3f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);

        glUseProgram(shader_program);
        glBindVertexArray(VAO);
        glDrawArrays(GL_TRIANGLES, 0, 3);

        glfwSwapBuffers(window);
        glfwPollEvents();
    }

    glDeleteVertexArrays(1, &VAO);
    glDeleteBuffers(1, &VBO);
    glDeleteProgram(shader_program);

    glfwDestroyWindow(window);
    glfwTerminate();

    return 0;
}
