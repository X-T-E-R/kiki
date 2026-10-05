# Kiki desktop

The Windows build has a signed in-app updater. macOS and Linux builds do not — updating them means downloading the newer bundle yourself. This page covers both, plus what happens to your data during an update and how to roll back. Installation steps are in [Installation](./installation.md#install-the-desktop-app).

| Platform | Bundle | How you update it |
| --- | --- | --- |
| Windows x64 | `Kiki_*_x64-setup.exe` (per-user NSIS installer, includes the CLI) | In-app updater, or run the newer installer |
| Linux x64 | `Kiki_*_amd64.deb` / `Kiki_*_amd64.AppImage` | Download and install the newer bundle |
| macOS Apple Silicon | `Kiki_*_aarch64.dmg` | Download the newer dmg |
| macOS Intel | `Kiki_*_x64.dmg` | Download the newer dmg |

Windows installers, updater signatures, SHA256 checksums, and updater manifests for every version stay on [GitHub Releases](https://github.com/X-T-E-R/kiki/releases).

::: warning Note
The Windows installer carries no Authenticode signature (Windows' official code signing, which is what displays a verified publisher name). SmartScreen may therefore show an unknown publisher for a file you downloaded from the official Release. See [SmartScreen and updater signing](#smartscreen-and-updater-signing).
:::

## Requirements and release channels

The Windows build installs for the current Windows account without administrator access. If the machine lacks the required runtime, the installer downloads the Microsoft Edge WebView2 bootstrapper (the Microsoft web component the desktop UI renders in).

macOS needs **13.5 or later**, which is the floor of the runtime bundled inside the app. Intel and Apple Silicon are separate downloads, not one universal app. Linux desktop builds are x64 (deb or AppImage); the CLI/TUI also builds for arm64. Nothing in Kiki requires a desktop — the CLI/TUI runs on a machine with no display.

| Channel | What it offers | Update feed |
| --- | --- | --- |
| Stable | The current stable build | `https://x-t-e-r.github.io/kiki/updater/stable/latest.json` |
| Beta | Newer builds that have been tested but are not stable yet | `https://x-t-e-r.github.io/kiki/updater/beta/latest.json` |

Each feed is a JSON file the updater reads; you never need to open it. The stable feed names the highest published stable version, and it stays empty until the first stable release. While only beta builds exist, the beta feed is the one that has content. Once both exist, the beta feed names whichever of the two is higher by SemVer (Semantic Versioning — the rule that compares major, minor, and patch numbers), so selecting Beta can also hand you the current stable build.

## Install and verify

Download from a versioned Release, not from a "latest download" link, so the installer, checksum, and updater metadata all come from the same `kiki-v<version>` tag.

1. Open the [Kiki Releases page](https://github.com/X-T-E-R/kiki/releases) and select the stable or beta version you want.
2. Download the `Kiki_*_x64-setup.exe` installer and the `.sha256` file next to it.
3. In the download directory, open PowerShell and run these two commands, replacing the file name with the one you downloaded. The first prints the checksum the release published, the second computes the checksum of your copy:

   ```powershell
   Get-Content .\Kiki_1.0.0_x64-setup.exe.sha256
   (Get-FileHash .\Kiki_1.0.0_x64-setup.exe -Algorithm SHA256).Hash.ToLower()
   ```

4. Check that the two hexadecimal strings match.
5. Run the installer, then start Kiki from the Windows Start menu.

The `.sig` asset holds the Tauri updater signature (Tauri is the app framework behind the desktop app) that the in-app updater checks. You do not need it for a manual install — the `.sha256` file above is the manual check.

## Update

**Settings → About** is where updates live. It shows the current version, lets you pick the **Update channel** (Stable or Beta), and turns automatic checks on or off. With automatic checks on, Kiki looks for a new version once a day, and the **When an update is found** setting below the switch decides what happens then: **Notify me** shows an update dialog, while **Download and install** goes straight into the install. Either way, a space with running work is never closed without asking you first. **Check for updates** always checks the channel you have selected, whether or not the automatic check is on.

In **Notify me** mode the dialog shows the version and a short summary of what changed, then waits for you. The three buttons are not the same kind of decision:

- **Remind me tomorrow** — the same offer comes back 24 hours later.
- **Skip this version** — Kiki stops asking about that version on that channel, and remembers it. A newer version still comes, and a skip recorded on Stable does not silence Beta.
- **Update now** — install it.

Closing the dialog with the window button or `Esc` dismisses this reminder only; nothing is stored, so the same offer can come back later.

Before installing, Kiki looks the version up on your channel again. If the channel or the version changed since the offer appeared, it refreshes the offer instead of installing something you did not agree to. If any space still has a running session or waiting input, Kiki names those spaces and asks you to confirm before closing anything; declining leaves your sessions running. Once you confirm, Kiki closes the backends it manages, then downloads, verifies and installs. Switching channels never downgrades an install.

If the download or install step fails, Kiki says so and the install button becomes a retry. Whether your sessions need restarting depends on how far it got: retry directly while the update screen is still usable, and restart Kiki only if you need those sessions back. If the automatic check or a channel change cannot be saved, the dialog stays open and tells you to try again.

If the in-app update keeps failing, close Kiki, download the newer installer from the exact Release you were trying to update to, verify its `.sha256` file, and run it. Installing over the existing per-user installation keeps your application data where it is.

On macOS and Linux, quit Kiki, install the newer bundle over the old one, and start it again. If an older Kiki process is still running against the same data home, quit it first — see [`KIKI_HOME`](../configuration/env-vars.md#kiki-home).

## Backend logs

When the desktop app starts its own backend, that backend's error output goes to `desktop-backend.log` in the active space's `logs` directory, beside the server's own `kimi-code.log`. The file rotates at 5 MiB and keeps three numbered backups, where `.1` is the newest.

The backend logs at `warn` by default. To change that, quit the desktop app and set `"logLevel"` in the active space's `desktop.json`, leaving its other fields alone. Accepted values are `fatal`, `error`, `warn`, `info`, `debug`, `trace`, and `silent`. A space without its own `desktop.json` follows the main home. The new level applies the next time the desktop app launches the backend.

## SmartScreen and updater signing

When SmartScreen appears, check the URL and the hash before you go any further: the URL should be under `github.com/X-T-E-R/kiki/releases/`, and the SHA256 value should match the published one. If both check out, use **More info** → **Run anyway**. A copy that arrived through chat, email, or a third-party mirror fails that check by definition — do not install it.

## Windows, tray, and opening files

On Windows and macOS, closing the window hides it to the tray — **Quit** in the tray menu is what actually exits. On Linux with a tray available, the same close minimizes the window so your window manager can bring it back. Where no tray is available, closing the window asks you to confirm the exit instead.

Opening a file from the file menu hands it to the app your system associates with that file type. The menu does not launch these types, because starting them would run code outside the app: `.app` and `.command` on macOS, `.desktop` on Linux, and executables and scripts on Windows. A shortcut pointing at one of those is refused too. Other files, including ordinary text files, open normally, and **Reveal in file manager** is unaffected.

## Roll back

To go back a version, back up any workspace data you care about, close Kiki, then download the previous installer and its `.sha256` file from that exact tag, verify the hash, and run the installer.

If Windows refuses to install the older version over the newer one, uninstall Kiki from **Installed apps** first, then run the older installer. Keep Kiki's application data through that uninstall unless you want to reset your local settings and sessions. After rolling back, stay on the stable channel — otherwise the next update check offers you the beta again.
