# Kiki 0.6.1

This release focuses on desktop responsiveness, timeline clarity, live concurrency visibility, foreground-to-background steering reliability, and macOS/Windows runtime performance under heavy multi-session load.

## Highlights

- **Flat two-state sidebar, 400/700 CJK typography, and live concurrency view.** Simplified the session sidebar to flat active/idle scannability without default-collapsed folders, standardized 400/700 CJK sans typography across surfaces, and surfaced 24px live concurrency counts with `active / limit` breakdowns on **Activity → Live**.
- **Unified timeline dividers, copyable error callouts, and `Model Steer` attribution.** Consolidated timeline horizontal rules, replaced unselectable failure hairlines with copyable `TimelineErrorCallout` cards, and labeled model-steering injections distinctly from ordinary system reminders.
- **Session state machine, foreground auto-detach, and `--tray-only` daemon visibility.** Hardened prompt delivery and duplicate-bubble deduplication, restored reliable 15-second foreground-to-background detachment and instant `Send now` steering across tools, fixed video pre-compression short-circuiting in `ReadMediaFile`, and preserved a lightweight `--tray-only` system tray indicator for pure-background runs.
- **macOS & Windows high-concurrency performance hardening.** Eliminated synchronous macOS notification XPC main-thread stalls, cached loopback CORS preflights (`Access-Control-Max-Age`), bounded `WorkspacePathIndex` watcher/trigram batches during heavy builds, moved cold goal scans and large wire projections off the server event loop, and resolved 170+ static/deep-scan performance, timeline, and injection findings.

## Upgrade

Finish work in other Kiki processes using the same home and close them before upgrading.

Download the desktop or mobile package for your system from this release. Each has an adjacent `.sha256` file:

| System | Asset |
| --- | --- |
| Windows x64, including CLI | `Kiki_0.6.1_x64-setup.exe` |
| Linux x64 | `Kiki_0.6.1_amd64.AppImage` or `Kiki_0.6.1_amd64.deb` |
| macOS Apple Silicon | `Kiki_0.6.1_aarch64.dmg` |
| macOS Intel | `Kiki_0.6.1_x64.dmg` |
| Android 7.0+ | `Kiki_0.6.1_android-release.apk` (with `android-receipt.json`) |

For npm, use Node.js 24.22.1 or later on the 24 line, or 26.12.1 or later; Node.js 25 and earlier 26 releases are not supported:

```sh
npm install -g kiki-agent@0.6.1
```

For CLI/TUI only:

```sh
npm install -g kiki-agent-lite@0.6.1
```

Standalone CLI downloads are `kiki-linux-x64`, `kiki-linux-arm64`, `kiki-darwin-x64`, and `kiki-darwin-arm64`, each with an adjacent `.sha256` file. Windows receives the CLI through its installer or npm.

Windows installers are not Authenticode-signed; SmartScreen may show **Unknown publisher**. Verify the downloaded installer against its adjacent `.sha256` file. Windows x64 automatic updates use a separate release-key signature.

macOS downloads are unsigned and not notarized unless signed with Apple Developer ID credentials. After verifying the hash, mount the dmg, drag Kiki to Applications, then Control-click it and choose **Open** on first launch; confirm **Open** in the dialog. If macOS still blocks that verified copy, run `xattr -dr com.apple.quarantine /Applications/Kiki.app`. See the [installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation#install-the-desktop-app) to link the bundled CLI. Linux and macOS desktop updates use manual replacement.

[Installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation) · [Desktop update channels](https://x-t-e-r.github.io/kiki/en/getting-started/desktop-app) · [Report a problem](https://github.com/X-T-E-R/kiki/issues)
