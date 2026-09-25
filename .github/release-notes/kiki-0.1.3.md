# Kiki 0.1.3

The third feature update for **Kiki** — a local-first AI coding agent with a TUI, a browser/desktop GUI, and a shared local daemon. This release is mostly about speed: long sessions, big transcripts, and busy agent fleets no longer stall the app. It also brings the desktop app to Linux and macOS, npm installs, and a much shorter first run. Highlights below; the full changelog is in the commit history.

## Highlights

### Performance across the board

- **Faster session switching**: reopening a session no longer re-reads and re-renders its entire saved transcript before showing anything; large sessions open noticeably sooner.
- **Hidden subagent tabs stop replaying**: a background agent tab releases its transcript subscription until you bring it back, instead of continuously replaying the wire log.
- **Cheaper previews**: text previews read only the first ~512 KB of a file, image previews decode a bounded thumbnail, and repeat previews reuse ETag cache hits instead of downloading the file again. Range requests against saved blobs now stream the requested range instead of reading the whole blob.
- **Paginated task lists**: the task board and cron panel load 100 items per page with on-demand "load more", and task status filtering happens on the server.
- **Calmer rendering**: composer drafts batch their writes (400 ms) instead of serializing on every keystroke, the agent tree and floor navigator virtualize long lists, and old timestamps tick once a minute instead of driving a per-second re-render of the whole rail.
- **No redundant auto compaction**: an overflow compaction in auto permission mode no longer triggers a second, pointless compaction (and its extra LLM call) right after.

### First run, redone

- **Three steps, saved as you go**: the onboarding wizard is shorter, **Next saves what you entered**, and model probes run on the server with your unsaved key — no more "probe failed" from an unreachable browser-side request.
- **Default permission mode is now `auto`** (behavior change): new sessions let the agent work autonomously without per-action prompts. If you prefer approving each action, switch to `manual` in the composer mode menu or Settings. The previous hints for `auto`/`yolo` were also corrected — they had been swapped.
- The composer mode trigger shows the current mode and an honest option list.

### Desktop on every platform

- **Linux**: `AppImage` and `.deb` for x64. **macOS**: `dmg` for Apple Silicon and Intel (unsigned, not notarized — see the installation guide for first open).
- **One installer story**: the Windows installer and the full npm package both include the CLI; `kiki desktop` launches the desktop app from the terminal.
- **npm**: `npm install -g kiki-cli` (desktop + CLI) or `kiki-cli-lite` (CLI/TUI only). Requires Node.js 24.15+.

## Known issues

- The main panel's fleet-wide token total shows "unknown" while any completed subagent is present, instead of summing the available agents (the aggregation was narrowed; a fix follows).
- When a cron watch subscription fails, the fallback polling interval is longer than before; scheduled tasks still run, but the panel may refresh less promptly.

## Downloads

### Desktop apps

| Platform | File |
| --- | --- |
| Windows x64 (recommended) | `Kiki_0.1.3_x64-setup.exe` (NSIS, includes the CLI, built-in updater) |
| Linux x64 | `Kiki_0.1.3_amd64.AppImage` / `Kiki_0.1.3_amd64.deb` |
| macOS Apple Silicon | `Kiki_0.1.3_aarch64.dmg` |
| macOS Intel | `Kiki_0.1.3_x64.dmg` |

### Command-line agent

Standalone single-file executables (no archives), each with a `<file>.sha256` checksum:

| Platform | Binary |
| --- | --- |
| Windows x64 / ARM64 | `kiki-win32-x64.exe` / `kiki-win32-arm64.exe` |
| macOS Intel / Apple Silicon | `kiki-darwin-x64` / `kiki-darwin-arm64` |
| Linux x64 / ARM64 | `kiki-linux-x64` / `kiki-linux-arm64` |

Or from npm: `kiki-cli` (desktop + CLI) or `kiki-cli-lite` (CLI/TUI only), Node.js 24.15+.

## Verifying downloads

Every binary has a SHA-256 checksum file next to it:

```sh
# macOS / Linux
shasum -a 256 kiki-darwin-arm64
# then compare with kiki-darwin-arm64.sha256

# Windows (PowerShell)
Get-FileHash Kiki_0.1.3_x64-setup.exe -Algorithm SHA256
# then compare with Kiki_0.1.3_x64-setup.exe.sha256
```

## Signing notice

The Windows installer is **not code-signed** with an EV certificate, so SmartScreen may warn on first launch (**More info → Run anyway**). The macOS dmg files are unsigned and not notarized; on first open, right-click the app and choose **Open**, and see the installation guide for clearing quarantine on CLI binaries. The built-in updater only installs artifacts signed by our release key.

## Documentation

Full documentation lives at https://x-t-e-r.github.io/kiki/.

## Feedback

Bugs and feature requests: https://github.com/X-T-E-R/kiki/issues.
