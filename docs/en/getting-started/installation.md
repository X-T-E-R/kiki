# Installation

Kiki ships as three forms — the **Kiki desktop app** for Windows, Linux, and macOS, the **CLI/TUI** (TUI — the text interface you type into inside a terminal), and a local **server** for browser and API clients. They share one background daemon (the process Kiki keeps running so every form sees the same session data) and one session store, so you can start a task in the terminal and pick it up in the desktop app.

This page covers installing and updating each form. [First launch](./first-launch.md) covers what to do next.

::: tip Before you install
Kiki's terminal form runs in any modern terminal. Windows Terminal and your system's built-in terminal need no changes.

A terminal with true-color and font ligatures renders the interface more crisply — [Kitty](https://sw.kovidgoyal.net/kitty/) and [Ghostty](https://ghostty.org/) are two good choices. Any terminal works if you skip this.
:::

## Install the desktop app

The desktop app bundles the Kiki server and CLI/TUI. On Windows and with the Linux deb, installation makes `kiki` available in a new terminal; an AppImage or dmg does not modify your shell's `PATH` (the list of directories searched for executables).

| Platform | Desktop bundle | CLI on `PATH` after installation |
| --- | --- | --- |
| Windows x64 | `Kiki_*_x64-setup.exe` | Yes, in a new terminal |
| Linux x64 | `Kiki_*_amd64.deb` / `Kiki_*_amd64.AppImage` | deb: yes unless `/usr/local/bin/kiki` already belongs to another tool; AppImage: no |
| macOS Apple Silicon | `Kiki_*_aarch64.dmg` | No, link the bundled CLI manually |
| macOS Intel | `Kiki_*_x64.dmg` | No, link the bundled CLI manually |

macOS needs **13.5 or later**; that floor comes from the bundled runtime, so it applies however you install. Intel and Apple Silicon are separate downloads — pick the one matching your Mac. Linux desktop bundles are x64 only (deb or AppImage); the Linux CLI/TUI additionally builds for arm64.

1. Open the [Kiki Releases page](https://github.com/X-T-E-R/kiki/releases) and select the required stable or beta `kiki-v<version>` tag.
2. Download the desktop bundle for your system and its adjacent `.sha256` file. Compare the published hash with your downloaded file (`shasum -a 256 <file>` on macOS, `sha256sum <file>` on Linux, or `Get-FileHash <file> -Algorithm SHA256` in Windows PowerShell).
3. Install it: run the Windows installer or `sudo apt install ./Kiki_*.deb`; on Linux AppImage, run `chmod +x Kiki_*.AppImage` then `./Kiki_*.AppImage`; on macOS, mount the dmg and drag Kiki to Applications.

The macOS dmg is **not Apple-signed or notarized**. After verifying the hash, Control-click the app in Applications and choose **Open** on first launch, then confirm **Open** in the dialog. If macOS still blocks it, remove the quarantine flag from that copy with `xattr -dr com.apple.quarantine /Applications/Kiki.app`.

The dmg puts no `kiki` command on your `PATH`. To use the bundled CLI from a terminal, first check that `/usr/local/bin/kiki` does not already exist, then run:

```sh
sudo mkdir -p /usr/local/bin
sudo ln -s /Applications/Kiki.app/Contents/MacOS/kiki-server /usr/local/bin/kiki
```

For the Windows SmartScreen prompt and updater details, see [Kiki desktop](./desktop-app.md).

## Install the CLI

For a terminal-only install, pick the standalone executable for your platform from a `kiki-v<version>` tag on [GitHub Releases](https://github.com/X-T-E-R/kiki/releases). Windows has no standalone CLI file; the desktop installer provides `kiki` there.

| Platform | Standalone file |
| --- | --- |
| Linux x64 / ARM64 | `kiki-linux-x64` / `kiki-linux-arm64` |
| macOS Intel / Apple Silicon | `kiki-darwin-x64` / `kiki-darwin-arm64` |

Download the file together with its `<filename>.sha256` companion, compare the two hashes, rename the executable to `kiki`, run `chmod +x kiki`, and put it somewhere on your `PATH`. A standalone executable needs no Node.js. Once the desktop app is installed, `kiki desktop` opens it; without an installation it prints a download link.

With Node.js 24.15.0 or later you can install from npm instead:

```sh
npm install -g kiki-agent       # CLI/TUI and the matching desktop build
npm install -g kiki-agent-lite  # CLI/TUI only
kiki --version
```

Install one of the two, not both — each one provides the same `kiki` command. `kiki-agent` also downloads the desktop build for your platform and verifies its SHA-256, so it needs network access during install and covers Windows and Linux x64 plus macOS Intel and Apple Silicon. `kiki-agent-lite` ships the CLI only.

On Windows, both packages need [Git for Windows](https://gitforwindows.org/) for their shell dependency — install it before your first run. If you installed Git Bash somewhere other than the default location, set `KIKI_SHELL_PATH` to the absolute path of `bash.exe`.

### Development from source

Working on the CLI itself needs Node.js `24.15.0` or later and pnpm `10.33.0`. The repository is a pnpm (Node.js package manager) workspace; from its root:

```sh
node --version
pnpm --version
pnpm install
pnpm dev:cli -- --help
```

`dev:cli` starts the local development build and forwards `--help` to the CLI entry point, so nothing needs to be published or installed globally.

## Update and uninstall

For a release build, verify the installed version before upgrading:

```sh
kiki --version
```

**Update**: replace a standalone `kiki` executable with the newer file from the matching Release asset, or run `npm install -g kiki-agent@latest` / `npm install -g kiki-agent-lite@latest` for an npm install. On Windows the desktop app can also check for and install signed NSIS updates from **Settings → About**; see [Kiki desktop](./desktop-app.md#update). Linux and macOS desktop bundles have no in-app updater, so download the newer bundle yourself.

**Uninstall**: delete a standalone `kiki` executable from your `PATH`, or run `npm uninstall -g kiki-agent` / `npm uninstall -g kiki-agent-lite`. That removes the CLI only — remove the desktop app through the system: **Installed apps** in Windows Settings, your package manager for a Linux deb, or dragging Kiki.app out of Applications on macOS. To stop working on the source, delete your checkout.

None of these steps touch your data. Session history and configuration live under `~/.kiki/` and are still there after you reinstall; [Data locations](../configuration/data-locations.md) explains how to remove them deliberately.

## Next steps

- [First launch](./first-launch.md) — start the daemon-backed UI, log in, and run your first conversation
- [Kiki desktop](./desktop-app.md) — desktop install channels, updates, rollback, and SmartScreen details
