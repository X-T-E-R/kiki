# Kiki 0.2.0

This release makes the desktop workspace easier to navigate and brings more of its setup and recovery controls into the app. It also adds a manual SSH connection path for a Kiki server you already run on another machine.

## Highlights

- **The default send shortcut is now Ctrl/Cmd+Enter.** Enter inserts a new line in the composer; use the send button or Ctrl/Cmd+Enter to submit. External links open in the system browser.
- **Stay oriented across agents and long sessions.** The workspace keeps visible conversation progress when you switch agents or sessions. Earlier history loads on request instead of repeatedly fetching itself. Background tasks have paged lists and output receipts; messages to an external subagent show queued, delivered, or duplicate-acceptance results without discarding a draft on a mailbox conflict. Running agents keep their bound profile when definitions reload.
- **Richer file previews.** Markdown files use Streamdown with CJK text, syntax-highlighted code, math, diagrams, and relative images. Large files start with a bounded preview and offer an explicit way to load the full document.
- **Agent and search fixes.** Compatible ACP executors, starting with Grok, receive their profile as a system prompt. The session-title model can be saved in Settings. Full-text search retains its index after compaction on Windows.
- **Manage connections and search credentials in Settings.** Reveal or replace a saved connection token without losing an in-progress edit. Search provider cards can reveal, replace, or clear server-managed credentials. WebBridge setup offers a guided runtime check and a version-pinned, SHA-256-checked download path; an observed working feature is not presented as proof of daemon identity or plugin authenticity.
- **Preview legacy model parameter changes before writing.** Settings shows proposed copies into model `parameters`, review reasons, and available backup identifiers. Apply and restore are separate confirmed actions. Older fields remain in the config for review. Backups can contain plaintext secrets; keep them private. See the [configuration guide](https://x-t-e-r.github.io/kiki/en/configuration/config-files#explicit-legacy-model-parameter-migration) before restoring a backup after further edits.
- **Connect to an already-running remote Kiki manually.** The desktop SSH profile uses an SSH config host alias, a port, an expected server home ID obtained through a trusted channel, and a bearer token that is not saved. Trust the SSH host key first. This path does not install or upload a remote server; older servers without a home ID need upgrading. Manual remote connections remain experimental; this release has not been exercised against a real remote host.

## Compatibility and known limits

- Update the desktop client and local Kiki server together. Transcript readers require the versioned coverage response; a mixed old/new pair rejects an unconfirmed history read instead of presenting it as complete.
- The usage dashboard can still show a partial total on large histories: its query has scan budgets and cached results, and the session and agent panels use different summaries. Unified persistent accounting across subagents is planned, not part of 0.2.0. NB-IM is also not included.
- Windows installers are not EV code-signed, so SmartScreen may prompt on first launch. The macOS DMGs are unsigned and not notarized; see the [installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation). The built-in Windows updater accepts only release-key-signed artifacts.

## Downloads

| Platform | File |
| --- | --- |
| Windows x64 | `Kiki_0.2.0_x64-setup.exe` (NSIS, includes CLI) |
| Linux x64 | `Kiki_0.2.0_amd64.AppImage` or `Kiki_0.2.0_amd64.deb` |
| macOS Apple Silicon | `Kiki_0.2.0_aarch64.dmg` |
| macOS Intel | `Kiki_0.2.0_x64.dmg` |

Standalone CLI executables are named `kiki-win32-x64.exe`, `kiki-win32-arm64.exe`, `kiki-linux-x64`, `kiki-linux-arm64`, `kiki-darwin-x64`, and `kiki-darwin-arm64`; matching `.sha256` files are supplied. For npm installs, use `kiki-agent` (desktop and CLI) or `kiki-agent-lite` (CLI/TUI only), with Node.js 24.15 or newer.

Compare a download with its adjacent `.sha256` file. On Windows, run `Get-FileHash Kiki_0.2.0_x64-setup.exe -Algorithm SHA256`; on macOS or Linux, run `shasum -a 256 <downloaded-file>`. Documentation: https://x-t-e-r.github.io/kiki/. Bugs and feedback: https://github.com/X-T-E-R/kiki/issues.
