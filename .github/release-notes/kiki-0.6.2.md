# Kiki 0.6.2

This release ships a self-contained zero-dependency Windows runtime bundle, resolves the SEA `age` portable-space TDZ failure (`40001`) and eager Git Bash validation error (`50001`), offloads multi-GiB cold `wire.jsonl` journal replay to CPU workers with incremental checkpoints, overhauls branch `Merge` into a non-blocking checkpoint state machine, and hardens URL subscription plugin safety, foreground tool watchdogs, and gateway pool quotas.

## Highlights

- **Zero-dependency Windows desktop installer & lazy shell fallback.** Embedded a self-contained portable `Git Bash`, core `git`, essential POSIX utilities, offline `ripgrep 15.0.0` (`rg.exe`), and a zero-Node SEA `node` hook shim directly into the Windows installer while keeping existing user `PATH` installations first in priority. Fixed the SEA CJS `const require` TDZ crash (`40001`) in `ageCodec` and decoupled workspace/model catalog validation from `Git Bash` presence (`50001`), falling back cleanly to PowerShell when no Bash installation is present.
- **Multi-GiB cold `wire.jsonl` worker replay, incremental checkpoints & SQLite bounds.** Offloaded cold journal UTF-8 framing and JSON parsing onto `ICpuWorkerService` with periodic incremental replay checkpoints (`>= 256 MiB` / `8s`) so interrupted large-session restores resume from verified byte offsets with `< 12 ms` P99 main-thread ticks, and added `4–8 MiB` SQLite value guards to prevent oversized derived rows from starving `ISessionIndex`.
- **Non-blocking branch `Merge` checkpoints & clean timeline folding.** Replaced sealed-branch tool vetoes and implicit queue handbacks with intraturn-watermarked `Merge` checkpoints so branches can run follow-up checks and amendments mid-turn, displaying `已合入 · 可继续` only when idle and fully covered. Folded internal `injection` / `hook_result` / truncated `<system-reminder>` rows immediately, restricted inline quote selection to user/assistant content, fixed cross-turn composer elapsed timers, eliminated non-main space pre-paint skin flashes, and unified live session duration formatting.
- **Subscription security, foreground tool watchdogs & pool quota deduplication.** Held newly added or modified executable plugins during silent background `auto`-sync for interactive confirmation, uninstalled subscription-owned plugins on source purge, added DNS-pinned redirect/IPv6 (NAT64/6to4/Teredo) SSRF guards to `downloadZip`, decoupled resident `pluginHost` cold-boot activation from 3-second prompt-context timeouts, added autonomous watchdogs for foreground tools and Bash pre-registration, deduplicated `/raw/<id>` gateway pool quotas into a single row, and enabled cross-worktree `AGENTS.md` content-hash alias deduplication plus coalesced-step steering cadence.

## Upgrade

Finish work in other Kiki processes using the same home and close them before upgrading.

Download the desktop or mobile package for your system from this release. Each has an adjacent `.sha256` file:

| System | Asset |
| --- | --- |
| Windows x64 (includes Git Bash, Git, `rg`, and CLI) | `Kiki_0.6.2_x64-setup.exe` |
| Linux x64 | `Kiki_0.6.2_amd64.AppImage` or `Kiki_0.6.2_amd64.deb` |
| macOS Apple Silicon | `Kiki_0.6.2_aarch64.dmg` |
| macOS Intel | `Kiki_0.6.2_x64.dmg` |
| Android 7.0+ | `Kiki_0.6.2_android-release.apk` (with `android-receipt.json`) |

For npm, use Node.js 24.22.1 or later on the 24 line, or 26.12.1 or later; Node.js 25 and earlier 26 releases are not supported:

```sh
npm install -g kiki-agent@0.6.2
```

For CLI/TUI only:

```sh
npm install -g kiki-agent-lite@0.6.2
```

Standalone CLI downloads are `kiki-linux-x64`, `kiki-linux-arm64`, `kiki-darwin-x64`, and `kiki-darwin-arm64`, each with an adjacent `.sha256` file. Windows receives the CLI and embedded shell toolchain through its installer, or CLI-only via npm.

Windows installers are not Authenticode-signed; SmartScreen may show **Unknown publisher**. Verify the downloaded installer against its adjacent `.sha256` file. Windows x64 automatic updates use a separate release-key signature.

macOS downloads are unsigned and not notarized unless signed with Apple Developer ID credentials. After verifying the hash, mount the dmg, drag Kiki to Applications, then Control-click it and choose **Open** on first launch; confirm **Open** in the dialog. If macOS still blocks that verified copy, run `xattr -dr com.apple.quarantine /Applications/Kiki.app`. See the [installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation#install-the-desktop-app) to link the bundled CLI. Linux and macOS desktop updates use manual replacement.

[Installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation) · [Desktop update channels](https://x-t-e-r.github.io/kiki/en/getting-started/desktop-app) · [Report a problem](https://github.com/X-T-E-R/kiki/issues)
