# Kiki 0.6.0

This release adds a standalone Subscriptions page for multi-source configuration packages, pure-plugin model providers and quota views, official Antigravity 1.5+ multi-account execution, 3D media generation plugins, grouped sidebar sessions, content-addressed attachment storage, and bounded cold-session recovery for multi-gigabyte histories.

## Highlights

- **Subscriptions and portable configuration (`Settings → Subscriptions`).** Subscribe to multiple configuration URLs or import `.tgz` / `.age` archives without using the CLI, including `kiki://subscribe?url=...` deep links. Preview and filter six orthogonal categories (models & connections, plugins/MCP & search, agents & recipes, personas, instructions, and settings), choose between automatic sync, manual check, or one-time import, and explicitly bind referenced models (or defer binding) without silent model fallback.
- **Pure-plugin model providers, 3D media, and live quota views.** Plugins can register first-class LLM providers (`registerLlmProvider`) and quota sources (`registerProviderQuotaSource`) without modifying `config.toml`, while `registerMediaProvider` and built-in media generation add `kind: "3d"` (`.glb` + preview image). **Activity → Quotas** deduplicates shared API credentials and supports multi-window pool and personal usage reporting.
- **Antigravity 1.5+ multi-account bridge.** Install and hot-upgrade the official Antigravity CLI from **Settings → Models**, sign in across isolated named account instances with pasteable authorization codes, view 5-hour and weekly model-pool quotas, steer active runs in place via live prompt supersession, and surface internal subagent steps and unified file diffs.
- **Multi-gigabyte cold restore, bounded event journals, and content-addressed storage.** Cold session restoration and tail history hydration avoid full-wire main-thread scans, server event journals enforce a 256 KiB per-record ceiling with gap recovery, and local/uploaded media attachments deduplicate through home-level content-addressed storage without breaking external executor file references.
- **Workspace shell, grouped sidebar, and session access.** Redesigned Settings, Personas, Rooms, Cron, Memory, Capabilities shelves, and right-rail session previews on `@base-ui/react` primitives; added grouped sidebar projections (`/api/sidebar`), narrow-viewport context meters, idle send-timing options, and scoped `ksa_` session-access v2 controls for companion terminal hosts.

## Upgrade

Finish work in other Kiki processes using the same home and close them before upgrading.

Download the desktop or mobile package for your system from this release. Each has an adjacent `.sha256` file:

| System | Asset |
| --- | --- |
| Windows x64, including CLI | `Kiki_0.6.0_x64-setup.exe` |
| Linux x64 | `Kiki_0.6.0_amd64.AppImage` or `Kiki_0.6.0_amd64.deb` |
| macOS Apple Silicon | `Kiki_0.6.0_aarch64.dmg` |
| macOS Intel | `Kiki_0.6.0_x64.dmg` |
| Android 7.0+ | `Kiki_0.6.0_android-release.apk` (with `android-receipt.json`) |

For npm, use Node.js 24.22.1 or later on the 24 line, or 26.12.1 or later; Node.js 25 and earlier 26 releases are not supported:

```sh
npm install -g kiki-agent@0.6.0
```

For CLI/TUI only:

```sh
npm install -g kiki-agent-lite@0.6.0
```

Standalone CLI downloads are `kiki-linux-x64`, `kiki-linux-arm64`, `kiki-darwin-x64`, and `kiki-darwin-arm64`, each with an adjacent `.sha256` file. Windows receives the CLI through its installer or npm.

Windows installers are not Authenticode-signed; SmartScreen may show **Unknown publisher**. Verify the downloaded installer against its adjacent `.sha256` file. Windows x64 automatic updates use a separate release-key signature.

macOS downloads are unsigned and not notarized unless signed with Apple Developer ID credentials. After verifying the hash, mount the dmg, drag Kiki to Applications, then Control-click it and choose **Open** on first launch; confirm **Open** in the dialog. If macOS still blocks that verified copy, run `xattr -dr com.apple.quarantine /Applications/Kiki.app`. See the [installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation#install-the-desktop-app) to link the bundled CLI. Linux and macOS desktop updates use manual replacement.

[Installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation) · [Desktop update channels](https://x-t-e-r.github.io/kiki/en/getting-started/desktop-app) · [Report a problem](https://github.com/X-T-E-R/kiki/issues)
