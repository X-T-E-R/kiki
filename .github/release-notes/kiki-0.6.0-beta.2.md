# Kiki 0.6.0-beta.2

This is the first published beta prerelease on the 0.6.0 line, published on the **Beta** update channel (`https://x-t-e-r.github.io/kiki/updater/beta/latest.json`) and npm `beta` dist-tag without changing the Stable channel (`0.5.1`).

## Highlights

- **Large-session cold open and subagent scale.** Parallel cold-log reads, bounded tail hydration, and uncapped subagent execution eliminate cold-open stalls and live main-thread blocking on high-fanout sessions.
- **Responsive conversation and right rail.** Unified `@base-ui/react` overlays across the GUI, stabilized shared-clock snapshots to prevent live subagent render loops, decoupled composer typing under heavy load, and reduced idle renderer and server CPU overhead.
- **Media, playback, and plugin hot updates.** Direct audio streaming and zero-remount message sending avoid screen flashes, and resident plugin updates on Windows replace active files without `EBUSY` locks.
- **Cross-machine spaces and session mesh.** Unified composer status bar for SSH hosts and session mesh leases/port tunnels, non-destructive config/secret fencing, and stricter peer approval boundaries.
- **In-session branches and compaction.** In-session parallel conversation branches with merge-back summaries, plus `summarize` restored as the default context compaction strategy.
- **Cross-platform release pipeline and Beta channel.** Added Apple Developer ID signing and notarization support (when configured), fixed Android `WebChromeClient` attachment and macOS release bundler heap limits, and completed end-to-end beta channel routing across GitHub Prereleases, the Beta desktop updater feed, and npm `@beta` dist-tags.

## Upgrade

Finish work in other Kiki processes using the same home and close them before upgrading.

Download the desktop or mobile package for your system from this prerelease. Each has an adjacent `.sha256` file:

| System | Asset |
| --- | --- |
| Windows x64, including CLI | `Kiki_0.6.0-beta.2_x64-setup.exe` |
| Linux x64 | `Kiki_0.6.0-beta.2_amd64.AppImage` or `Kiki_0.6.0-beta.2_amd64.deb` |
| macOS Apple Silicon | `Kiki_0.6.0-beta.2_aarch64.dmg` |
| macOS Intel | `Kiki_0.6.0-beta.2_x64.dmg` |
| Android 7.0+ | `Kiki_0.6.0-beta.2_android-release.apk` (with `android-receipt.json`) |

On Windows desktop, existing users can opt in to testing builds from **Settings → About → Update channel → Beta** and click **Check for updates**.

For npm, use Node.js 24.22.1 or later on the 24 line, or 26.12.1 or later; Node.js 25 and earlier 26 releases are not supported:

```sh
npm install -g kiki-agent@beta
```

For CLI/TUI only:

```sh
npm install -g kiki-agent-lite@beta
```

Standalone CLI downloads are `kiki-linux-x64`, `kiki-linux-arm64`, `kiki-darwin-x64`, and `kiki-darwin-arm64`, each with an adjacent `.sha256` file. Windows receives the CLI through its installer or npm.

Windows installers are not Authenticode-signed; SmartScreen may show **Unknown publisher**. Verify the downloaded installer against its adjacent `.sha256` file. Windows x64 automatic updates use a separate release-key signature.

macOS downloads are unsigned and not notarized unless signed with Apple Developer ID credentials. After verifying the hash, mount the dmg, drag Kiki to Applications, then Control-click it and choose **Open** on first launch; confirm **Open** in the dialog. If macOS still blocks that verified copy, run `xattr -dr com.apple.quarantine /Applications/Kiki.app`. See the [installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation#install-the-desktop-app) to link the bundled CLI. Linux and macOS desktop updates use manual replacement.

[Installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation) · [Desktop update channels](https://x-t-e-r.github.io/kiki/en/getting-started/desktop-app) · [Report a problem](https://github.com/X-T-E-R/kiki/issues)
