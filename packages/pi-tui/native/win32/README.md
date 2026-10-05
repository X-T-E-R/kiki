# Windows native prebuilds

The addon here turns on the console's virtual-terminal input mode and answers
modifier-key queries through `GetAsyncKeyState`. Checked-in prebuilds for
`win32-x64` and `win32-arm64` mean you only need to rebuild if you change the C
source in `src/`.

Rebuild both architectures from the repository root:

```sh
node packages/pi-tui/native/win32/build.mjs
```

Run it on Windows. It uses the Microsoft C++ Build Tools from Visual Studio:
`build.mjs` locates `VsDevCmd.bat`, initializes a developer environment for
`amd64` and `arm64`, then builds with `cl.exe` and `link.exe`.

Install the "Desktop development with C++" workload, or at minimum the MSVC
toolset and the Windows SDK. No Node headers are needed — the addon resolves
N-API symbols from the host process.

To cross-build from a non-Windows machine, or to use a different toolchain, set
`PI_TUI_WIN32_TOOLCHAIN=mingw` and point the script at MinGW-compatible
compilers:

```sh
PI_TUI_WIN32_TOOLCHAIN=mingw \
CC_X64=/path/to/x86_64-w64-mingw32-gcc \
CC_ARM64=/path/to/aarch64-w64-mingw32-gcc \
node packages/pi-tui/native/win32/build.mjs
```

`PI_TUI_WIN32_TOOLCHAIN` accepts only `msvc` (the default) or `mingw`.
`node packages/pi-tui/native/win32/build.mjs --help` lists every environment
variable the script reads.

The addon avoids the C runtime and links only against `kernel32`.
