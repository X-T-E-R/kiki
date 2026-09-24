# Kiki 0.1.1

The first feature update for **Kiki** — a local-first AI coding agent with a TUI, a browser/desktop GUI, and a shared local daemon. Highlights below; the full changelog is in the commit history.

## Highlights

### Agent system

- **Subagent messaging**: message a running or settled subagent directly from its timeline card, wake idle children, and steer them with the same composer as the main agent.
- **`model_alias: inherit`**: profiles can now explicitly follow the dispatching agent's model and thinking effort — no more silent fallbacks or dead profiles after switching providers.
- **First-launch starter profiles**: opt-in `implementer` and `reviewer` example profiles offered during onboarding (never auto-installed).
- **Advisory dispatch policy**: structured dispatch decisions and badges across agent surfaces; `kiki doctor agents` validates profiles.
- **Goal mode** with a durable prompt queue, plus app-wide **cron tasks** with a global scheduled-tasks panel.

### Desktop app

- **Automatic updates**: the desktop app now self-updates from signed release artifacts.
- **Tabbed preview workspace** with fullscreen and embedded agent panels; the **shared right rail** follows whichever agent you're looking at, with an explicit owner badge.
- **Timeline annotations**: quote and comment on any passage; marks and bubbles now reliably appear even when annotating an already-rendered message.
- Searchable **model picker with provider auto-fill**, honest provider catalog refresh, and persisted provider credentials split into a separate file.
- Real **message totals** on session open; historical subagents restore their stored model/effort/status instead of showing "unreported".
- Failure reasons surfaced across timeline, toasts, and agent views; terminal subagents are messageable with Ctrl+Enter.

### CLI and server

- `kiki session show` / `kiki session list` — read-only local session inspection.
- Server startup no longer blocks on session-index and workspace warmups.
- Upstream identity compatibility switch for the CLI.

### Fixes worth noting

- Queued-message cancellation, prompt-queue ordering, and Send-now binding races.
- White screen when the GUI connected through a same-origin websocket endpoint.
- Pane-resize drag handling, timeline row overlap, and task-board progressive loading.

## Downloads

### Windows desktop app (recommended)

- `Kiki_0.1.1_x64-setup.exe` — NSIS installer with the built-in updater.
- `Kiki_0.1.1_x64-setup.exe.sig` — updater signature (already embedded in `latest.json`; you do not need it for a manual install).
- `Kiki_0.1.1_x64-setup.exe.sha256` — SHA-256 checksum of the installer.

### Command-line agent (all platforms)

Standalone single-file executables, no Node.js install required:

| Platform | Archive |
| --- | --- |
| Windows x64 | `kiki-win32-x64.zip` |
| Windows ARM64 | `kiki-win32-arm64.zip` |
| macOS Intel | `kiki-darwin-x64.zip` |
| macOS Apple Silicon | `kiki-darwin-arm64.zip` |
| Linux x64 | `kiki-linux-x64.zip` |
| Linux ARM64 | `kiki-linux-arm64.zip` |

Each archive is paired with a `<archive>.zip.sha256` checksum file.

## Verifying downloads

Every binary above has a SHA-256 checksum file next to it. Verify with:

```sh
# macOS / Linux
shasum -a 256 kiki-darwin-arm64.zip
# then compare with kiki-darwin-arm64.zip.sha256

# Windows (PowerShell)
Get-FileHash Kiki_0.1.1_x64-setup.exe -Algorithm SHA256
# then compare with Kiki_0.1.1_x64-setup.exe.sha256
```

## Windows SmartScreen notice

The Kiki Windows installer is **not code-signed** with an EV certificate, so Windows SmartScreen and Microsoft Defender may show an "unrecognized app" warning on first launch. This is expected for this release.

To install:

1. Run `Kiki_0.1.1_x64-setup.exe`.
2. If SmartScreen shows "Windows protected your PC", click **More info**.
3. Click **Run anyway**.

The installer is verifiable through the SHA-256 checksum above, and the built-in updater only installs artifacts signed by our release key (see `latest.json`). We plan to ship code signing in a later release.

## macOS and Linux desktop apps

The Tauri desktop app is **Windows-only in 0.1.1**. macOS and Linux users can use the command-line executable above; the desktop GUI will follow in a later release. On macOS, the CLI is unsigned, so clear Gatekeeper explicitly for the extracted binary (`xattr -d com.apple.quarantine kiki`) before running it.

## Documentation

Full documentation lives at https://x-t-e-r.github.io/kiki/.

## Feedback

Bugs and feature requests: https://github.com/X-T-E-R/kiki/issues.
