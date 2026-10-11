# Kiki 0.3.2

This release improves long conversations, external engines, memory, and the controls for work that continues in the background.

## Highlights

- **Read large conversations from the latest messages.** Main and subagent histories open with recent messages; older pages load as you read back. Restored activity stays in timeline order and historical agents retain their names. Stale runtime metadata no longer makes cold subagents appear active, and completed work retains its recorded state. Agents without saved history open with an empty transcript rather than failing, and sent images open without an extra loading step.
- **Choose an engine without overriding its defaults.** Run Claude Code, Codex, Grok Build, or another configured external engine directly, with an optional Kiki profile. You can also browse profiles while a turn is running and apply a confirmed change with your next message.
- **Keep queued work and replies recoverable.** Edited and unconfirmed messages survive reloads, queued messages can be reordered, and interrupted model-switch lists recover on reconnect. Final response text is retained when a provider sends it without text deltas. Room notifications already covered by a successful catch-up no longer start duplicate empty turns.
- **Manage memory with its sources attached.** Memory entries retain source and recheck information. Lists and review inboxes continue loading automatically, approvals and undo remain recoverable, and an active memory can be replaced when the store is at capacity. Unchanged memory guidance no longer causes repeated snapshot updates.
- **Know when the whole conversation's work is finished.** Completion notifications are on by default and wait for finite background work and its results, rather than firing at every turn end. Scheduled tasks have editable schedules, full prompts, and next-run details. The cockpit shows activity across the session's agents and tasks.
- **Set up capabilities in place.** Browser control guides you through component installation and connection. The plugin marketplace supports search, preview, installation, and updates; Kiki Documents is now Kiki Extract, with installed settings and data preserved. Plugin tools also start correctly from the native executable.
- **Use a quieter workbench.** Automatic rules disappear from the agent rail when none are configured, while real errors remain visible. Expanded call details show their content directly. Thinking levels are ordered consistently, running conversations have customizable navigation shortcuts, and usage totals refresh after new requests.

## Upgrade and compatibility

Update the desktop app and its server together. Desktop update checks run automatically; notification preferences are saved per release channel. The built-in context-renewal default for main agents is now Auto. Manual compaction requested during active work is queued and shown separately from automatic compaction.

External engines keep their own authentication and configuration unless you choose a Kiki override. Optional Kiki context tools and subagent delegation depend on the selected engine. Claude Code and Grok tool round trips have been verified; Codex tool injection remains unverified end to end after stream-disconnection failures. VibeCafe sign-in and usage-upload controls are included, but the live service round trip has not been verified.

Windows installers are not EV code-signed, so SmartScreen may prompt. Windows x64 automatic updates use release-key-signed artifacts; this is separate from Windows code signing. macOS downloads are unsigned and not notarized. Linux and macOS desktop updates are manual.

## Downloads

Use the installer or desktop package for your platform from this release's assets. Windows x64 includes the CLI in the NSIS installer. Standalone CLI downloads cover Linux x64/arm64 and macOS x64/arm64; Windows CLI installation is also available through npm.

For npm installations, use `kiki-agent` for desktop and CLI, or `kiki-agent-lite` for CLI/TUI only, with Node.js 24.15 or newer. Verify downloads against their adjacent `.sha256` files.

[Installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation) · [Feature guides](https://x-t-e-r.github.io/kiki/en/features/) · [Report a problem](https://github.com/X-T-E-R/kiki/issues)
