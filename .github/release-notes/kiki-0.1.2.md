# Kiki 0.1.2

The second feature update for **Kiki** — a local-first AI coding agent with a TUI, a browser/desktop GUI, and a shared local daemon. This release is mostly about subagent collaboration you can rely on, a calmer session timeline, and fewer setup steps. Highlights below; the full changelog is in the commit history.

## Highlights

### Subagent collaboration

- **Messages that come back**: a subagent you resume with a message now registers its wake-up correctly, and when it finishes the parent receives the completion notice — no more waiting on a child that already answered.
- **An honest roster**: resumed subagents stay visible in the agent rail, with a time-limited refreshing state while a completed child is recreated (an already-loaded idle child may still be absent until its next task starts). Stalled roster refreshes now expire, and disposed "ghost" agents can no longer surface as live nodes in the agent tree.
- **Scoped stops**: stopping a subagent also stops its live descendants while preserving their resumable scopes, and cancelling one subagent's prompt no longer takes down unrelated active or queued prompts on the same agent.
- **Remaining-work notices**: completion notices and agent-stop results now name the subagents that are still running, so a turn that is not really finished no longer looks clean.
- **`ThreadCreate`**: agents can open a new session themselves, with an optional title, directory, main-agent profile, and starting prompt.

### Session timeline

- **Fold steps**: consecutive tool, shell, and thinking steps collapse into one expandable block, with a settings toggle that applies instantly; folded groups refresh as their members change and keep the original step order.
- **Settings density**: the fold-steps switch moved into the composer card so the General settings section fits a 1280×800 screen again, and legacy transcript-search terms still find it.
- **Unsent annotations survive** switching between conversations.
- **Media previews work again**: images and videos from earlier local reads preview in the timeline, saved tool-image crops replay instead of showing the uncropped original, and local WebP images and videos are served with the MIME types browsers actually preview.

### Workspaces, models, and first run

- **A workspace is optional** when starting a session: kiki creates one automatically on your first send, and rolls it back cleanly when creation or registration fails instead of leaving an unused or duplicated workspace behind.
- **Credentials are editable**: saved provider keys are shown and can be changed, and pulling the model list probes with your unsaved key. Newly pulled models default to a 250k context with thinking and tool use enabled.
- **Shorter first run**: a shorter setup prompt and fixed skill activation in the onboarding wizard.

### Skills and search

- **Built-in skills open as read-only `SKILL.md` preview tabs** from their embedded content; file-backed skills still open from their real paths.
- **nb-search needs no configuration**: repository search works out of the box, with optional keyless web search.
- **Multiple provider keys** rotate across synchronous web-tool calls, and detached jobs schedule their keys independently.

### Agent guidance

- Default profiles now teach bounded delegation and evidence-scoped exploration, require multi-sample reading for form and convention evidence, and carry a short "Content and tone" section.

### Fixes worth noting

- Sessions left locked after their previous process exited can be reopened — expired locks are taken over and swept at startup.
- One damaged session's saved data no longer hides healthy sessions from the session index.
- Disk-backed reads no longer fail during WAL compaction on Windows.
- A model's own thinking default now takes precedence over the global thinking effort.

## Downloads

### Windows desktop app (recommended)

- `Kiki_0.1.2_x64-setup.exe` — NSIS installer with the built-in updater.
- `Kiki_0.1.2_x64-setup.exe.sig` — updater signature (already embedded in `latest.json`; you do not need it for a manual install).
- `Kiki_0.1.2_x64-setup.exe.sha256` — SHA-256 checksum of the installer.

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
Get-FileHash Kiki_0.1.2_x64-setup.exe -Algorithm SHA256
# then compare with Kiki_0.1.2_x64-setup.exe.sha256
```

## Windows SmartScreen notice

The Kiki Windows installer is **not code-signed** with an EV certificate, so Windows SmartScreen and Microsoft Defender may show an "unrecognized app" warning on first launch. This is expected for this release.

To install:

1. Run `Kiki_0.1.2_x64-setup.exe`.
2. If SmartScreen shows "Windows protected your PC", click **More info**.
3. Click **Run anyway**.

The installer is verifiable through the SHA-256 checksum above, and the built-in updater only installs artifacts signed by our release key (see `latest.json`). We plan to ship code signing in a later release.

## macOS and Linux desktop apps

The Tauri desktop app is **Windows-only in 0.1.2**. macOS and Linux users can use the command-line executable above; the desktop GUI will follow in a later release. On macOS, the CLI is unsigned, so clear Gatekeeper explicitly for the extracted binary (`xattr -d com.apple.quarantine kiki`) before running it.

## Documentation

Full documentation lives at https://x-t-e-r.github.io/kiki/.

## Feedback

Bugs and feature requests: https://github.com/X-T-E-R/kiki/issues.
