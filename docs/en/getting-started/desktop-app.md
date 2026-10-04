# Kiki desktop

Kiki desktop is available for Windows x64 (a per-user NSIS installer), Linux x64 (AppImage and deb), and macOS Apple Silicon or Intel (dmg). The Windows installer includes the CLI/TUI and adds `kiki` to your user `PATH`; Linux deb includes it too. This page explains the Windows-specific signed updater; Linux/macOS bundles use manual updates and their installation steps are in [Installation](./installation.md#install-the-desktop-app). Windows installers, updater signatures, SHA256 checksums, and versioned updater manifests are retained on [GitHub Releases](https://github.com/X-T-E-R/kiki/releases).

::: warning Note
Kiki Windows installers are not Authenticode-signed (Windows' official code signing for verifying the publisher) in the first public release. Windows SmartScreen may therefore identify the publisher as unknown even when the file came from the official Release.
:::

## Requirements and release channels

The desktop build supports Windows x64 and installs for the current Windows account without administrator access in the normal case. Windows may download the Microsoft Edge WebView2 bootstrapper (the Microsoft web component the desktop UI depends on) during installation if the required runtime is missing.

On macOS the desktop app needs **13.5 or later**, because that is the bundled runtime's own floor. Intel and Apple Silicon are separate downloads, not one universal app. On Linux the desktop app is x64 (deb or AppImage); the CLI/TUI also builds for arm64. Terminal chat and other headless use need no desktop or display of any kind.

| Channel | Intended use | Public feed (the metadata URL for each update channel — not an RSS feed) |
| --- | --- | --- |
| Stable | Normal daily use | `https://x-t-e-r.github.io/kiki/updater/stable/latest.json` |
| Beta | Early access to a newer tested build | `https://x-t-e-r.github.io/kiki/updater/beta/latest.json` |

The stable feed points to the highest published stable version and is absent until the first stable release. The beta feed is available during the public beta period; after stable exists, it compares the highest stable and beta versions using SemVer (Semantic Versioning — the rule that compares major, minor, and patch numbers) and points to whichever is newer.

## Install and verify

Installation starts from a versioned Release rather than an unversioned download link. This keeps the installer, checksum, and updater metadata tied to the same `kiki-v<version>` tag.

1. Open the [Kiki Releases page](https://github.com/X-T-E-R/kiki/releases) and select the required stable or beta version.
2. Download the `Kiki_*_x64-setup.exe` installer and its adjacent `.sha256` file.
3. In PowerShell, paste and run the following commands from the download directory, replacing the file name with the downloaded installer (the first command shows the checksum the release published, the second computes the checksum of your download — the two outputs must match):

   ```powershell
   Get-Content .\Kiki_1.0.0_x64-setup.exe.sha256
   (Get-FileHash .\Kiki_1.0.0_x64-setup.exe -Algorithm SHA256).Hash.ToLower()
   ```

4. Confirm that the two hexadecimal hashes are identical.
5. Run the installer and start Kiki from the Windows Start menu.

The `.sig` asset contains the complete Tauri updater signature (Tauri is the app framework behind the Kiki desktop app; this signature is consumed by its built-in updater). It is separate from the SHA256 checksum used for a manual download check.

## Update

Kiki checks the selected update channel once after desktop startup. You can also choose Stable or Beta and run a manual check from **Settings → About**. When an update is available, Kiki shows its version and release notes before asking for confirmation.

Installing an update exits the Kiki desktop process and its bundled sidecar (the background service process that runs alongside the desktop UI), verifies the signed installer, and runs the NSIS update. Running work is interrupted, so finish or stop important tasks before confirming. Kiki does not automatically downgrade when you switch channels.

If the in-app update fails, close Kiki, download the newer installer from its exact Release, verify its SHA256 file, and run it manually. Installing a newer version over the existing per-user installation keeps the normal application data location intact.

The in-app update above is the Windows updater. On macOS and Linux, updating the desktop app means downloading the newer bundle yourself, so quit Kiki first, install the new bundle over the old one, and start it again. After replacing the app on macOS or Linux, quit any older Kiki process still using the same data home before starting the new build — see [`KIKI_HOME`](../configuration/env-vars.md#kiki-home).

The public `latest.json` files provide signed updater metadata for stable and beta clients. Each manifest points to an installer under a specific `kiki-v<version>` tag rather than a mutable latest-download URL, and its `signature` field is the content of that installer's `.sig` asset.

## Backend logs

When desktop starts its own backend, it records diagnostic stderr (the process's error-output stream) in `desktop-backend.log` inside the active space's `logs` directory (the home's log folder, beside the server's own `kimi-code.log`). The current file rotates at 5 MiB and keeps three numbered backups (`.1` is the newest). Rotation also runs when opening an oversized existing log; that older file is retained as a backup. A single oversized new line is truncated to its UTF-8 tail. Logging failures do not stop the backend; startup diagnostics still retain the last 100 nonempty lines in memory.

The backend defaults to `warn`. To change it before the settings control is connected, quit desktop and set `"logLevel": "debug"` in the active space's `desktop.json`, preserving its other fields. Supported values are `fatal`, `error`, `warn`, `info`, `debug`, `trace`, and `silent`. A space inherits the main home's level unless it has its own override. The change applies on the next desktop-owned backend launch, not to an already running or externally managed server. Log-directory and path commands are available to desktop integrations; a browser connected to a remote server cannot open its host directory.

## SmartScreen and updater signing

SmartScreen reputation and updater signing answer two different questions: SmartScreen asks "who published this installer?", while the updater signature asks "was this file tampered with?". Because the installer has no Authenticode signature, Windows cannot display a verified publisher identity; the Tauri `.sig` allows the built-in updater to verify that the downloaded installer was signed with the Kiki updater key. The two facts are complementary, not contradictory.

If SmartScreen appears, first confirm that the URL is under `github.com/X-T-E-R/kiki/releases/` and that the SHA256 value matches. Only then use **More info** and **Run anyway** if you accept the unknown-publisher warning. Do not install a copy received through chat, email, or a third-party mirror.

## Windows, tray, and opening files

Closing the window hides it to the tray on Windows and macOS; use **Quit** from the tray menu, or the usual exit command, to actually exit. If the tray icon cannot be created, Kiki still opens normally and closing the window asks you to confirm the exit instead. On Linux, when a tray is available the same close minimizes the window so your window manager can bring it back; where there is no tray, closing asks you to confirm the exit. Global shortcuts are a convenience — if one cannot be registered, the app still starts.

Opening a file from the file menu hands it to the system application associated with that file type. The menu refuses a list of known launch targets rather than opening them: `.app` and `.command` on macOS, `.desktop` on Linux, and executables and scripts on Windows — including a link whose real target is one of those. Ordinary text files open normally, and *Reveal in file manager* and saving are unaffected. Treat the refusal list as covering those named types, not as a general promise about every file association.

## Roll back

Rollback uses the immutable assets retained on the Releases page. Back up any important workspace data first, close Kiki, download the previous installer and `.sha256` file from its exact tag, verify the hash, and run that installer.

If Windows refuses to install an older version over a newer one, uninstall Kiki from **Installed apps** and then run the older installer. Do not delete Kiki's application data while uninstalling unless you also intend to reset local settings and sessions. After rollback, use the stable feed or continue updating manually from stable Releases to avoid immediately selecting a newer beta again.
