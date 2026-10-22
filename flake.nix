{
  description = "Kiki CLI";

  inputs = {
    # Locked nixos-25.11 packages nodejs_24 at 24.15.0. On 2026-10-22 the
    # branch tips are 24.18.0 (nixos-25.11) and 24.21.0 (nixos-unstable), both
    # older than Node.js 24.22.1, so this pin stays. nodejsFor keeps
    # pkgs.nodejs_24 and, while that package is older, overrides its version
    # and source tarball. That keeps the nixpkgs source build, including
    # headers, npm, and platform outputs. The patch list is the one nixpkgs
    # uses for nodejs 24.21; the 24.15-only configure-emulator and OpenSSL
    # fetchpatches are not applied.
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
      # node-v24.22.1.tar.xz from https://nodejs.org/dist/v24.22.1/SHASUMS256.txt
      nodejsSourceHash = "sha256-T1N5eWKAza6wwvNY/QS2oWzE+336g7WoyRqdljtDUjE=";

      # Stay on the 24.x source derivation. A packaged nodejs_24 at or above
      # the floor is used as-is. An older one is rebuilt from the official
      # 24.22.1 source so SEA does not copy the vulnerable 24.15.0 binary.
      nodejsFor =
        pkgs:
        let
          packaged = pkgs.nodejs_24;
          patchDir = "${pkgs.path}/pkgs/development/web/nodejs";
          host = pkgs.stdenv.hostPlatform;
          build = pkgs.stdenv.buildPlatform;
        in
        if lib.versionAtLeast packaged.version minNodeVersion then
          packaged
        else
          packaged.overrideAttrs (old: {
            version = minNodeVersion;
            src = pkgs.fetchurl {
              url = "https://nodejs.org/dist/v${minNodeVersion}/node-v${minNodeVersion}.tar.xz";
              hash = nodejsSourceHash;
            };
            # Node.js 24.22.1 uses f_frsize from its bundled libuv. The locked
            # nixpkgs libuv is 1.51.0, before that field was added, so keep the
            # official bundled-libuv configure mode instead of patching Node or
            # changing the whole nixpkgs input.
            # Node's node:sqlite tests also require percentile, which is enabled
            # by the bundled SQLite but not by the pinned nixpkgs build. Keep
            # that official bundled-SQLite mode instead of changing the input.
            configureFlags = lib.filter (
              flag:
              flag != "--shared-libuv"
              && !(lib.strings.hasPrefix "--shared-libuv-libpath=" flag)
              && flag != "--shared-sqlite"
              && !(lib.strings.hasPrefix "--shared-sqlite-libpath=" flag)
            ) old.configureFlags;
            # Do not expose shared dependency headers over Node's bundled
            # headers; node-gyp must see the same ABI headers as the binary.
            buildInputs = lib.filter (
              input:
              input != pkgs.libuv
              && input != pkgs.sqlite
            ) old.buildInputs;
            postInstall = lib.replaceStrings [
              "${lib.getDev pkgs.libuv}/include/*"
              "${lib.getDev pkgs.sqlite}/include/*"
            ] [ "" "" ] old.postInstall;
            patches =
              (lib.optional (!(host.emulatorAvailable pkgs.buildPackages)) (pkgs.fetchpatch2 {
                url = "https://raw.githubusercontent.com/buildroot/buildroot/2f0c31bffdb59fb224387e35134a6d5e09a81d57/package/nodejs/nodejs-src/0003-include-obj-name-in-shared-intermediate.patch";
                hash = "sha256-3g4aS+NmmUYNOYRNc6UMJKYoaTlpP5Knt9UHegx+o0Y=";
              }))
              ++ lib.optionals (host != build && host.isFreeBSD) [
                (pkgs.fetchpatch2 {
                  url = "https://raw.githubusercontent.com/rubyjs/libv8-node/62476a398d4c9c1a670240a3b070d69544be3761/patch/v8-no-assert-trivially-copyable.patch";
                  hash = "sha256-hSTLljmVzYmc3WAVeRq9EPYluXGXFeWVXkykufGQPVw=";
                })
              ]
              ++ [
                "${patchDir}/configure-armv6-vfpv2.patch"
                "${patchDir}/node-npm-build-npm-package-logic.patch"
                "${patchDir}/use-correct-env-in-tests.patch"
                "${patchDir}/bin-sh-node-run-v22.patch"
                "${patchDir}/use-nix-codesign.patch"
              ]
              ++ lib.optionals build.isDarwin [
                "${patchDir}/gyp-patches-set-fallback-value-for-CLT-darwin.patch"
              ]
              ++ lib.optionals (!build.isDarwin) [
                (pkgs.fetchpatch2 {
                  url = "https://github.com/nodejs/node/commit/869d0cbca3b0b5e594b3254869a34d549664e089.patch?full_index=1";
                  hash = "sha256-BBBShQwU20TSY8GtPehQ9i3AH4ZKUGIr8O0bRsgrpNo=";
                  revert = true;
                })
              ];
          });

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
              hash = "sha256-Oqn9xEyHKjGx7V/oK4icta4SpRMSedX0SRAsUwEg5Y0=";
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
              # pnpmConfigHook installs with --ignore-scripts, so the
              # @kiki/plugin-sdk prepare step never emits dist. Package
              # exports point only at that dist, and the GUI vite build
              # inside build:native:sea resolves every subpath from it.
              pnpm --filter=@kiki/plugin-sdk run build
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
          ci-nodejs = nodejs;
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
