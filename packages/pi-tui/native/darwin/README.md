# Darwin native prebuilds

The addon here maps macOS modifier keys. Checked-in prebuilds for `darwin-arm64`
and `darwin-x64` mean you only need to rebuild if you change the C source in
`src/`.

Rebuild both architectures from the repository root:

```sh
bash packages/pi-tui/native/darwin/build.sh
```

The build targets macOS 11.0 for arm64 and macOS 10.15 for x86_64. Run it on
macOS and it finds Apple clang and the active SDK through `xcrun`; either an
Intel or an Apple Silicon host can produce both outputs.

Building from a non-macOS host needs a complete Darwin cross-toolchain — a
macOS SDK and a Mach-O linker. An osxcross installation, for example, is
selected with `CC` and `SDKROOT`:

```sh
CC=/path/to/osxcross/clang SDKROOT=/path/to/MacOSX.sdk \
  bash packages/pi-tui/native/darwin/build.sh
```

Obtain and use the SDK under Apple's license. Plain Linux or Windows clang is
not enough: the addon includes and links CoreGraphics.

Zig is not used here. It provides neither the Apple SDK nor CoreGraphics
framework stubs, so it does not make this build SDK-independent, and its clang
driver does not handle this Mach-O bundle recipe as a drop-in replacement for
Apple clang.
