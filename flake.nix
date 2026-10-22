{
  description = "Kiki CLI";

  inputs = {
    # Locked nixos-25.11 still packages nodejs_24 at 24.15.0. On 2026-10-22 the
    # branch tips are 24.18.0 (nixos-25.11) and 24.21.0 (nixos-unstable), both
    # older than Node.js 24.22.1. Moving this pin to either tip would still
    # fail the SEA floor. nodejsFor keeps pkgs.nodejs_24 once that package is
    # >= 24.22.1 and otherwise uses the official 24.22.1 dist with the
    # published SHA-256 from https://nodejs.org/dist/v24.22.1/SHASUMS256.txt.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  };

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems =
        f:
        lib.genAttrs systems (
          system:
          f (import nixpkgs {
            inherit system;
          })
        );

      minNodeVersion = "24.22.1";

      # Official dist used only while pkgs.nodejs_24 is older than the
      # October 2026 security release. Linux binaries are patched onto the
      # Nix dynamic linker; darwin uses the upstream binary as-is.
      officialNodeDist = {
        "x86_64-linux" = {
          file = "node-v24.22.1-linux-x64.tar.xz";
          hash = "sha256-bBcqmrZxj3uAH7WnvUhq8u5eMnWAhqBLhPzOKqdwleY=";
          sourceRoot = "node-v24.22.1-linux-x64";
        };
        "aarch64-linux" = {
          file = "node-v24.22.1-linux-arm64.tar.xz";
          hash = "sha256-26v3ocv5R+YFn/rSwnuABB25feoeVTtir97n8T/KM24=";
          sourceRoot = "node-v24.22.1-linux-arm64";
        };
        "x86_64-darwin" = {
          file = "node-v24.22.1-darwin-x64.tar.gz";
          hash = "sha256-0TJVfn7iuFrwiwyMNDOOZcZDDyI40B9ydyjvQtyDsDU=";
          sourceRoot = "node-v24.22.1-darwin-x64";
        };
        "aarch64-darwin" = {
          file = "node-v24.22.1-darwin-arm64.tar.gz";
          hash = "sha256-icaCWT12zUQjP6U7FWMmTn3py7GJytFpE1xbT637wKc=";
          sourceRoot = "node-v24.22.1-darwin-arm64";
        };
      };

      officialNodejs =
        pkgs:
        let
          system = pkgs.stdenv.hostPlatform.system;
          dist = officialNodeDist.${system} or (throw "No official Node.js ${minNodeVersion} dist for ${system}");
        in
        pkgs.stdenv.mkDerivation {
          pname = "nodejs";
          version = minNodeVersion;
          src = pkgs.fetchurl {
            url = "https://nodejs.org/dist/v${minNodeVersion}/${dist.file}";
            inherit (dist) hash;
          };
          inherit (dist) sourceRoot;
          nativeBuildInputs = lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.patchelf ];
          dontConfigure = true;
          dontBuild = true;
          dontStrip = true;
          dontPatchELF = true;
          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp -a . "$out/"
            runHook postInstall
          '';
          postInstall = lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
            patchelf \
              --set-interpreter ${pkgs.stdenv.cc.bintools.dynamicLinker} \
              --set-rpath ${pkgs.stdenv.cc.cc.lib}/lib \
              "$out/bin/node"
          '';
        };

      # Stay on the 24.x package. A newer nixpkgs nodejs_24 replaces the
      # official dist; an older one must not be copied into the SEA binary.
      nodejsFor =
        pkgs:
        let
          packaged = pkgs.nodejs_24;
        in
        if lib.versionAtLeast packaged.version minNodeVersion then
          packaged
        else
          officialNodejs pkgs;

      pnpmFor =
        pkgs:
        pkgs.pnpm_10.override {
          nodejs = nodejsFor pkgs;
        };

      # -------------------------------------------------------------------
      # Workspace members (kept in sync with pnpm-workspace.yaml).
      #
      # HARD REQUIREMENT: whenever you add or remove a workspace package,
      # you MUST update both lists below. Missing a path will break the Nix
      # build (src fileset silently drops files); missing a name will break
      # pnpmConfigHook (dependencies for that workspace won't be fetched).
      # -------------------------------------------------------------------
      workspacePaths = [
        ./packages/acp-client
        ./packages/acp-server
        ./packages/agent-core-v2
        ./packages/agent-profiles
        ./packages/auth-native
        ./packages/codex-client
        ./packages/kap-server
        ./packages/kaos
        ./packages/klient
        ./packages/minidb
        ./packages/node-sdk
        ./packages/oauth
        ./packages/pi-tui
        ./packages/plugin-sdk
        ./packages/protocol
        ./packages/session-core
        ./packages/transcript
        ./packages/transcript-live
        ./packages/tree-sitter-bash
        ./apps/kimi-code
        ./apps/kiki-gui
        ./apps/vscode
        ./docs
      ];

      workspaceNames = [
        "@kiki/acp-client"
        "@kiki/acp-server"
        "@kiki/agent-core-v2"
        "@kiki/agent-profiles"
        "@kiki/auth-native"
        "@kiki/codex-client"
        "@kiki/kap-server"
        "@kiki/kaos"
        "@kiki/minidb"
        "@kiki/node-sdk"
        "@kiki/oauth"
        "@kiki/klient"
        "@kiki/pi-tui"
        "@kiki/plugin-sdk"
        "@kiki/protocol"
        "@kiki/session-core"
        "@kiki/transcript"
        "@kiki/transcript-live"
        "@kiki/tree-sitter-bash"
        "@kiki/cli"
        "@kiki/gui"
        "kiki"
        "@kiki/docs"
      ];
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          nodejs = nodejsFor pkgs;
          pnpm = pnpmFor pkgs;
          appPackageJson = builtins.fromJSON (builtins.readFile ./apps/kimi-code/package.json);
          nativeTarget =
            if pkgs.stdenv.hostPlatform.isLinux && pkgs.stdenv.hostPlatform.isAarch64 then
              "linux-arm64"
            else if pkgs.stdenv.hostPlatform.isLinux then
              "linux-x64"
            else if pkgs.stdenv.hostPlatform.isDarwin && pkgs.stdenv.hostPlatform.isAarch64 then
              "darwin-arm64"
            else if pkgs.stdenv.hostPlatform.isDarwin then
              "darwin-x64"
            else
              throw "Unsupported Kiki native target for ${pkgs.stdenv.hostPlatform.system}";

          kiki = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "kiki";
            version = appPackageJson.version;

            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions (
                [
                  ./build
                  ./vendor
                  ./.npmrc
                  ./.nvmrc
                  ./package.json
                  ./pnpm-lock.yaml
                  ./pnpm-workspace.yaml
                  ./tsconfig.json
                  ./vitest.config.ts
                  ./LICENSE
                ]
                ++ workspacePaths
              );
            };

            pnpmWorkspaces = [ "." ] ++ workspaceNames;

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src pnpmWorkspaces;
              inherit pnpm;
              fetcherVersion = 3;
              hash = "sha256-NDcCQ5vxsGaSdJ3U0bvq2RkXKwrYTI7/8zZn/x1fvJ8=";
            };

            cargoRoot = "packages/auth-native";
            cargoDeps = pkgs.rustPlatform.importCargoLock {
              lockFile = ./packages/auth-native/Cargo.lock;
            };

            nativeBuildInputs = [
              nodejs
              pnpm
              (pkgs.pnpmConfigHook.override { inherit pnpm; })
              pkgs.cargo
              pkgs.rustc
              pkgs.rustPlatform.cargoSetupHook
              pkgs.makeWrapper
            ]
            # The SEA inject step (postject) invalidates the macOS code
            # signature on the copied Node executable; build.mjs then re-applies
            # an ad-hoc signature via `codesign`. The Nix darwin sandbox does
            # not expose /usr/bin/codesign, so we supply nixpkgs' ad-hoc-only
            # replacement instead.
            ++ lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
              pkgs.darwin.sigtool
            ];

            # The SEA binary is produced by `postject`-injecting a blob into a
            # plain Node executable. Stripping rewrites section tables and can
            # invalidate the injected blob's offsets, so leave the binary
            # untouched after the build.
            dontStrip = true;

            buildPhase = ''
              runHook preBuild
              export KIKI_BUILD_TARGET=${nativeTarget}
              export CARGO_HOME="$TMPDIR/kiki-auth-cargo-home"
              export CARGO_TARGET_DIR="$TMPDIR/kiki-auth-cargo-target"
              export CARGO_NET_OFFLINE=true
              mkdir -p "$CARGO_HOME" "$CARGO_TARGET_DIR"
              ${lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
                # pkgs.darwin.sigtool's codesign supports `--sign -` (ad-hoc)
                # but not the inspection mode (`-dv`) that 05-verify.mjs runs
                # afterwards. Disable the verify step for the Nix build; the
                # release CI keeps it via the unmodified script.
                substituteInPlace apps/kimi-code/scripts/native/build.mjs \
                  --replace-fail \
                    "await runVerifyStep({ requireGatekeeper: false });" \
                    "// runVerifyStep skipped in nix sandbox (sigtool lacks -dv)"
              ''}
              pnpm --filter=@kiki/cli run build:native:sea
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              install -Dm755 \
                "apps/kimi-code/dist-native/bin/${nativeTarget}/kiki" \
                "$out/bin/kiki"

              runHook postInstall
            '';

            postInstall = ''
              wrapProgram $out/bin/kiki --prefix PATH : ${lib.makeBinPath [ pkgs.ripgrep pkgs.fd ]}
            '';

            meta = {
              description = "Kiki CLI";
              homepage = "https://github.com/X-T-E-R/kiki";
              license = lib.licenses.mit;
              mainProgram = "kiki";
              platforms = systems;
            };
          });
        in
        {
          inherit kiki;
          default = kiki;
        }
      );

      apps = forAllSystems (pkgs: {
        kiki = {
          type = "app";
          program = "${self.packages.${pkgs.system}.kiki}/bin/kiki";
        };
        default = self.apps.${pkgs.system}.kiki;
      });

      devShells = forAllSystems (pkgs: {
        default =
          let
            nodejs = nodejsFor pkgs;
            pnpm = pnpmFor pkgs;
          in
          pkgs.mkShell {
            packages = [
              nodejs
              pnpm
              pkgs.ripgrep
              pkgs.fd
            ];
          };
      });
    };
}
