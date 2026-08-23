# Kiki desktop release setup

The Windows desktop release workflows target the public repository `X-T-E-R/kiki` and publish per-user NSIS installers for Windows x64. The application updater and Windows Authenticode are separate signing systems: the first public releases require the Tauri updater key, but do not require an Authenticode certificate.

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

The pull-request CI generates an ephemeral updater key and never reads the production private key. The release build embeds `KIKI_UPDATER_PUBLIC_KEY`; only the `publish` job attached to the `release` environment reads the production private key and signs the final installer.

## Publish a version

1. Set all desktop version authorities with the repository script, for example:

   ```powershell
   pnpm --filter @kiki/gui run desktop:version:set -- 0.1.0-beta.1
   pnpm --filter @kiki/gui run desktop:version:check
   ```

2. Land the version change on the commit to release.
3. Create and push an exact matching tag:

   ```powershell
   git tag kiki-v0.1.0-beta.1
   git push origin kiki-v0.1.0-beta.1
   ```

4. The release workflow builds the sidecar and NSIS installer, creates a draft Release, signs and validates the immutable assets, then publishes the Release. It refuses to replace assets on an existing tag.
5. The updater-feed workflow rebuilds GitHub Pages. During the beta-only period it publishes only `updater/beta/latest.json`; the stable feed appears after the first stable release.

Use `-beta.<number>` only for beta tags. Publish two beta versions and verify a real in-app update from the first to the second before tagging `kiki-v0.1.0` stable.

## First-release limitations

The first public Windows installer is not Authenticode-signed. SmartScreen may display **Unknown publisher** even when the installer came from the official GitHub Release. Release notes and user documentation must retain that disclosure and direct manual-download users to verify the adjacent SHA256 file.
