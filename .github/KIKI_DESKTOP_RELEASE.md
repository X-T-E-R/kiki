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

   For a deliberately chosen version, including a beta, use `pnpm --filter @kiki/gui run desktop:version:set -- <version>` and rerun the check. The CLI and desktop manifests must match before tagging.

2. Land the version change on the commit to release.
3. Create and push a tag matching the checked version, for example if it is `0.1.0-beta.1`:

   ```powershell
   git tag kiki-v0.1.0-beta.1
   git push origin kiki-v0.1.0-beta.1
   ```

4. The release workflow builds all desktop bundles and six native CLI binaries with the release SEA profile, creates a draft Release, signs and validates Windows updater assets, validates every downloaded CLI/desktop checksum, and stages and smoke-tests the npm CLI before publishing the Release. It uploads only Linux/macOS CLI binaries: Windows users receive one unified installer. It refuses to replace assets on an existing tag. After publishing the Release it publishes `kiki-agent-lite` and `kiki-agent`. Release SEA arguments do not enable Apple signing; the reusable native workflow enables signing separately with `sign-macos`.
5. The updater-feed workflow rebuilds GitHub Pages after a successful desktop release. Every documentation deployment also generates the current feeds before uploading the site; if fetching or validating a feed fails, that deployment stops and the previous site remains live. During the beta-only period only `updater/beta/latest.json` exists; the stable feed appears after the first stable release. Linux/macOS bundles require manual replacement.

Curated notes for a **new** tag go in `.github/release-notes/kiki-<version>.md` and must list `Kiki_*_x64-setup.exe`, `Kiki_*_amd64.AppImage`, `Kiki_*_amd64.deb`, two macOS dmg files, four standalone Linux/macOS executables, each `.sha256`, both npm install commands, and the macOS unsigned first-open steps. Previously published version notes are historical snapshots and must not be rewritten to describe new assets.

Use `-beta.<number>` only for beta tags. Publish two beta versions and verify a real in-app update from the first to the second before tagging `kiki-v0.1.0` stable.

## First-release limitations

The first public Windows installer is not Authenticode-signed. SmartScreen may display **Unknown publisher** even when the installer came from the official GitHub Release. Release notes and user documentation must retain that disclosure and direct manual-download users to verify the adjacent SHA256 file.
