# Installation

Kiki ships in three forms that share one daemon (the background process Kiki keeps running so all forms share session data) and one session store: the **Kiki desktop app** for Windows, Linux, and macOS, the **CLI/TUI** (TUI — the text-based interface inside the terminal) for the terminal, and a local **server** for browser and API clients. This page covers how to install and update each form; see [First launch](./first-launch.md) for what to do after installation.

::: tip Before you install
Kiki's terminal form runs fine in any modern terminal — Windows Terminal and your system's built-in terminal need no adjustments.

For the best visual experience (sharper font rendering and icon display), use a terminal with true-color and ligature support, such as [Kitty](https://sw.kovidgoyal.net/kitty/) or [Ghostty](https://ghostty.org/). This is optional; everything works without it.
:::

## Install the desktop app

The desktop app bundles the Kiki server and CLI/TUI. On Windows and with the Linux deb, installation makes `kiki` available in a new terminal; an AppImage or dmg does not modify your shell's `PATH` (the list of directories searched for executables).

| Platform | Desktop bundle | CLI on `PATH` after installation |
| --- | --- | --- |
| Windows x64 | `Kiki_*_x64-setup.exe` | Yes, in a new terminal |
| Linux x64 | `Kiki_*_amd64.deb` / `Kiki_*_amd64.AppImage` | deb: yes unless `/usr/local/bin/kiki` already belongs to another tool; AppImage: no |
| macOS Apple Silicon | `Kiki_*_aarch64.dmg` | No, link the bundled CLI manually |
| macOS Intel | `Kiki_*_x64.dmg` | No, link the bundled CLI manually |

1. Open the [Kiki Releases page](https://github.com/X-T-E-R/kiki/releases) and select the required stable or beta `kiki-v<version>` tag.
2. Download the desktop bundle for your system and its adjacent `.sha256` file. Compare the published hash with your downloaded file (`shasum -a 256 <file>` on macOS, `sha256sum <file>` on Linux, or `Get-FileHash <file> -Algorithm SHA256` in Windows PowerShell).
3. Install it: run the Windows installer or `sudo apt install ./Kiki_*.deb`; on Linux AppImage, run `chmod +x Kiki_*.AppImage` then `./Kiki_*.AppImage`; on macOS, mount the dmg and drag Kiki to Applications.

The macOS dmg is **not Apple-signed or notarized**. After verifying it, Control-click the app in Applications and choose **Open** on first launch, then confirm **Open** in the dialog. If macOS still blocks it and you trust the verified download, remove quarantine with `xattr -dr com.apple.quarantine /Applications/Kiki.app`; this disables Gatekeeper's quarantine check for that app copy. To run its CLI from a terminal, first check that `/usr/local/bin/kiki` does not already exist, then run `sudo mkdir -p /usr/local/bin` followed by `sudo ln -s /Applications/Kiki.app/Contents/MacOS/kiki-server /usr/local/bin/kiki`. The Windows SmartScreen note and updater details are in [Kiki desktop](./desktop-app.md).

## Install the CLI

For a terminal-only install, choose a standalone executable on [GitHub Releases](https://github.com/X-T-E-R/kiki/releases) under `kiki-v<version>`. There is no separate Windows CLI download; the Windows desktop installer provides `kiki`.

| Platform | Standalone file |
| --- | --- |
| Linux x64 / ARM64 | `kiki-linux-x64` / `kiki-linux-arm64` |
| macOS Intel / Apple Silicon | `kiki-darwin-x64` / `kiki-darwin-arm64` |

Download its `<filename>.sha256` file, compare its hash, rename the downloaded executable to `kiki`, set executable permission with `chmod +x kiki`, and put it on your `PATH`. A standalone SEA executable does not require Node.js. `kiki desktop` launches the desktop app when installed, or shows an installation link when absent.

With Node.js 24.15.0 or later, npm offers two alternatives:

```sh
npm install -g kiki-cli       # CLI/TUI and the matching desktop build
npm install -g kiki-cli-lite  # CLI/TUI only
kiki --version
```

Choose one npm package, not both at the same time: each supplies the same `kiki` command. The full package downloads and SHA-256-verifies the platform desktop asset during installation, so it needs network access and supports Windows/Linux x64 and macOS Intel/Apple Silicon; the lite package does not download a desktop bundle. On Windows, [Git for Windows](https://gitforwindows.org/) is a required shell dependency for both install routes. Install it before first launch; if Git Bash is installed in a custom location, set `KIKI_SHELL_PATH` to the absolute path of `bash.exe`.

### Development from source

Kiki's source repository is a pnpm (a Node.js package manager) workspace. Developing from source is for users who want to hack on or debug the CLI itself. It requires Node.js `24.15.0` or later and pnpm `10.33.0`. From the repository root:

```sh
node --version
pnpm --version
pnpm install
pnpm dev:cli -- --help
```

The root `dev:cli` script starts the local development environment and forwards `--help` to the CLI entry point; no published package or global install is required.

## Update and uninstall

For a release build, verify the installed version before upgrading:

```sh
kiki --version
```

**Update**: replace a standalone `kiki` executable with the matching newer Release asset, or run `npm install -g kiki-cli@latest` / `npm install -g kiki-cli-lite@latest` for an npm installation. On Windows, the desktop app can also check and install signed NSIS updates from **Settings → About** — see [Kiki desktop](./desktop-app.md#update). Linux and macOS desktop bundles require a new manual download; they do not use that Windows updater feed.

**Uninstall**: remove a standalone `kiki` executable from your `PATH`, or run `npm uninstall -g kiki-cli` / `npm uninstall -g kiki-cli-lite`. npm uninstall does not remove an app copied to Applications or a Windows installer it ran; uninstall those through the OS. Source development is removed by deleting the checkout. For the desktop bundles, use **Installed apps** in Windows Settings, your package manager for a Linux deb, or delete Kiki.app from Applications on macOS. Removing the executable does not delete your data — session history and configuration live under `~/.kiki/` and stay available to the next installation; see [Data locations](../configuration/data-locations.md) if you want to remove it as well.

## Next steps

- [First launch](./first-launch.md) — start the daemon-backed UI, log in, and run your first conversation
- [Kiki desktop](./desktop-app.md) — desktop install channels, updates, rollback, and SmartScreen details
