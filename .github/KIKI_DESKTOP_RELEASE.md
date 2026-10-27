# Kiki desktop release setup

The `kiki-v*` release workflow targets the public repository `X-T-E-R/kiki`. It publishes a unified Windows x64 NSIS installer (desktop and CLI), Linux x64 AppImage/deb, macOS Apple Silicon and Intel dmg, standalone Linux/macOS CLI executables, and two npm packages. Only the Windows NSIS installer uses the signed application updater; macOS bundles are not Apple-signed or notarized. Windows updater signing and Authenticode publisher identity are separate systems.

## One-time GitHub setup

1. Create the public `X-T-E-R/kiki` repository and push the intended default branch.
2. Generate the production Tauri updater key pair on a trusted machine:

   ```powershell
   pnpm --filter @kiki/gui exec tauri signer generate --write-keys .\kiki-updater.key
   ```

3. In **Settings → Secrets and variables → Actions → Variables**, create the repository variable `KIKI_UPDATER_PUBLIC_KEY` containing the public key line from `kiki-updater.key.pub`.
4. Create a GitHub Actions environment named `release`. In that environment, create the secret `TAURI_SIGNING_PRIVATE_KEY` containing the complete private key file. If the key has a password, also create `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
5. Restrict access to the private key and keep an offline backup. Losing it prevents existing installations from accepting future updates; replacing it requires shipping a manually installed build with a new embedded public key.
6. In **Settings → Pages**, select **GitHub Actions** as the deployment source.
7. Set repository secret `NPM_TOKEN` with publish access to `kiki-agent-lite` and `kiki-agent` on the public npm registry. The local npm registry may be a mirror, but the workflow explicitly publishes to `https://registry.npmjs.org/`. Do not copy npm credentials into the repository.

The pull-request CI generates an ephemeral updater key and never reads the production private key. The Windows release build embeds `KIKI_UPDATER_PUBLIC_KEY`; the `publish` job reads the production private key to sign only the NSIS installer. Before the validated GitHub Release is published, the same job runs a pack-and-install smoke test; after publication it publishes both npm packages.

## Publish a version

Changesets target the workspace package `@kiki/cli` for versioning and changelog entries. The `kiki-v*` workflow uses that version to stage `kiki-agent-lite` (CLI/TUI) and `kiki-agent` (CLI/TUI plus desktop); it publishes only those two distributions, not `@kiki/cli`. The root `pnpm publish` script is a separate workspace-package channel using `changeset publish`, including `@kiki/cli`; it does not stage desktop distributions and must not replace the tag workflow.

1. Consume the approved changesets and synchronize the desktop version from the CLI:

   ```powershell
   pnpm version:release
   pnpm --filter @kiki/gui run desktop:version:check
   ```

   For a deliberately chosen version, including a beta, use `pnpm --filter @kiki/gui run desktop:version:set -- <version>` and rerun the check. The CLI, GUI, Tauri, Cargo and `system.yaml` versions must match before tagging; the frozen input receipt checks all five.

2. Land the version change on the commit to release.
3. Create and push a tag matching the checked version, for example if it is `0.1.0-beta.1`:

   ```powershell
   git tag kiki-v0.1.0-beta.1
   git push origin kiki-v0.1.0-beta.1
   ```

4. The release workflow freezes the source, catalog and toolchain identity once, then builds six native CLI targets with the release SEA profile. Each target runs native smoke tests; the four desktop targets continue directly into bundling with that target's verified native bytes. The publish job verifies all target receipts, signs and validates Windows updater assets, and smoke-tests the staged npm packages before publishing the Release. It uploads only Linux/macOS CLI binaries: Windows users receive one unified installer. After publishing the Release it publishes `kiki-agent-lite` and `kiki-agent`. For a failed run or existing tag, follow [Recover a failed release](#recover-a-failed-release). Release SEA arguments do not enable Apple signing; the reusable native workflow enables signing separately with `sign-macos`.
5. The updater-feed workflow rebuilds GitHub Pages after a successful desktop release. Every documentation deployment also generates the current feeds before uploading the site; if fetching or validating a feed fails, that deployment stops and the previous site remains live. The release index request uses the Actions token because unauthenticated listing can return HTTP 403; `latest.json` manifests are still downloaded without credentials, and draft releases are ignored. During the beta-only period only `updater/beta/latest.json` exists; the stable feed appears after the first stable release. Linux/macOS bundles require manual replacement.

Curated notes for a **new** tag go in `.github/release-notes/kiki-<version>.md` and must list `Kiki_*_x64-setup.exe`, `Kiki_*_amd64.AppImage`, `Kiki_*_amd64.deb`, two macOS dmg files, four standalone Linux/macOS executables, each `.sha256`, both npm install commands, and the macOS unsigned first-open steps. Previously published version notes are historical snapshots and must not be rewritten to describe new assets.

Use `-beta.<number>` only for beta tags. Publish two beta versions and verify a real in-app update from the first to the second before tagging `kiki-v0.1.0` stable.

## Recover a failed release

Use **Re-run failed jobs** on the original Actions run to retain its successful targets and frozen input artifact. Target artifacts are named `kiki-release-target-<run>-<target>-<attempt>`; the publish job selects the latest successful artifact ID for each target within that run. All six receipts must match the original prepare identity, source, catalog, lockfile and release environment. If the input or target artifacts have expired, recovery stops; do not substitute artifacts from another run.

For an existing draft Release, identical assets are reused and missing assets can be uploaded. Different bytes under an existing name stop publication. For an already public Release, missing assets or signatures also stop recovery rather than changing public contents. Both reused and newly generated Windows updater signatures are verified against the exact installer bytes and `KIKI_UPDATER_PUBLIC_KEY`, including the minisign trusted comment. A valid reused signature does not require the private signing key again.

If npm publication was interrupted, rerun the failed publish job. An existing version is accepted only when its registry integrity matches the locally staged package; different integrity stops the run. Release publication still precedes npm publication.

Standalone calls to `_native-build.yml` keep their original per-target build behavior when no prepare artifact is supplied. Local default and explicit `KIKI_SIDECAR_SOURCE` paths retain their existing staging contract. Release-only byte reuse requires explicit `KIKI_SIDECAR_RELEASE_MODE=verified-prebuilt` plus matching native/input receipts and catalog; setting a source path alone does not enable it.

## First-release limitations

The first public Windows installer is not Authenticode-signed. SmartScreen may display **Unknown publisher** even when the installer came from the official GitHub Release. Release notes and user documentation must retain that disclosure and direct manual-download users to verify the adjacent SHA256 file.
