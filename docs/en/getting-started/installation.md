# Installation

Kiki ships in three forms that share one daemon (the background process Kiki keeps running so all forms share session data) and one session store: the **Kiki desktop app** for Windows, the **CLI/TUI** (TUI — the text-based interface inside the terminal) for the terminal, and a local **server** for browser and API clients. This page covers how to install and update each form; see [First launch](./first-launch.md) for what to do after installation.

::: tip Before you install
Kiki's terminal form runs fine in any modern terminal — Windows Terminal and your system's built-in terminal need no adjustments.

For the best visual experience (sharper font rendering and icon display), use a terminal with true-color and ligature support, such as [Kitty](https://sw.kovidgoyal.net/kitty/) or [Ghostty](https://ghostty.org/). This is optional; everything works without it.
:::

## Install the desktop app

The desktop app is the recommended way to try Kiki. It installs Kiki and runs a bundled server, so you can work from a graphical interface without touching the terminal.

1. Open the [Kiki Releases page](https://github.com/X-T-E-R/kiki/releases) and select the required stable or beta version.
2. Download the `Kiki_*_x64-setup.exe` installer and its adjacent `.sha256` file.
3. Verify the SHA256 checksum and run the installer — the detailed steps, update channels, and the Windows SmartScreen note are covered in [Kiki desktop](./desktop-app.md).

## Install the CLI

The CLI is published on [GitHub Releases](https://github.com/X-T-E-R/kiki/releases) as versioned release artifacts under the `kiki-v<version>` tag. Kiki `0.1.0` and later are available there.

::: warning Windows SmartScreen
The release binaries are not code-signed, so Windows SmartScreen may flag the publisher as unknown even when the file comes from the official Release. Confirm the download URL is under `github.com/X-T-E-R/kiki/releases/` before running it.
:::

1. Open the [Kiki Releases page](https://github.com/X-T-E-R/kiki/releases) and pick a version.
2. Download the CLI artifact for your platform from that release's assets.
3. Place the `kiki` executable on your `PATH` (the list of directories the system searches for executables, so you can run `kiki` from anywhere), then verify it:

```sh
kiki --version
```

> On Windows, install [Git for Windows](https://gitforwindows.org/) before first launch. Kiki uses the bundled Git Bash as its shell environment; if Git Bash is installed in a custom location, set `KIKI_SHELL_PATH` to the absolute path of `bash.exe`.

The CLI is not published to npm; use the release artifacts, or run from source while developing.

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

**Update**: follow the instructions and artifact names in the relevant [GitHub Releases](https://github.com/X-T-E-R/kiki/releases) entry. Replace the `kiki` executable with the newer artifact. The desktop app can also check and install updates from **Settings → About** — see [Kiki desktop](./desktop-app.md#update).

**Uninstall**: delete the `kiki` executable from your `PATH`. Source development is removed by deleting the checkout. The desktop app is uninstalled from **Installed apps** in Windows Settings. Removing the executable does not delete your data — session history and configuration live under `~/.kiki/` and stay available to the next installation; see [Data locations](../configuration/data-locations.md) if you want to remove it as well.

## Next steps

- [First launch](./first-launch.md) — start the daemon-backed UI, log in, and run your first conversation
- [Kiki desktop](./desktop-app.md) — desktop install channels, updates, rollback, and SmartScreen details
