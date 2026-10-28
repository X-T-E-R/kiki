# Kiki 0.5.1

This release fixes conversation recovery, message delivery feedback, and task completion wakeups, and simplifies browser and computer control settings.

## What changed

- **Conversation history.** Older conversations retain their prompts when paging through history. Editing and resending earlier turns no longer leaves duplicate messages, and streaming message batches keep each message's text separate. Session forks skip temporary journal locks, and existing Linux conversations with backslashes in their identifiers remain accessible.
- **Questions and task completion.** Locally answered questions stay at their original position through live updates and conversation reopen. Background question history shows the current answer status. Task completion can wake the main agent after runtime goal pauses and turn exits.
- **Models and context.** Main and subagent context overviews update when model limits change. Live history preserves execution settings attached to individual messages. Tool selection no longer reports tools that are already available as policy-denied.
- **External engines and recovery.** Send-now controls follow the engine's reported support for in-turn messages, and delivery receipts remain accurate when a turn finishes. ACP permission-mode confirmation, interrupted model streams, external executor startup recovery, and retries for empty compaction summaries are corrected.
- **Browser and computer settings.** Browser connections share one default selector and open their details in place. Browser-control consent covers both launching and attaching. Computer status follows the selected connection, distinguishes configured external executors from the bundled CUA installation, and retries failed configuration reads. Unused browser sources no longer produce a setup-task count.
- **Usage history.** Loading continues through bounded partial results instead of stalling or repeatedly restarting during updates. Period comparisons use the range returned by the server. Concurrent conversation rewrites invalidate old totals before a result is marked complete. Large historical ranges can still take time to finish loading.
- **Mailbox upgrades and SDK shutdown.** Mailbox upgrades preserve message deduplication and identify the source of an upgrade failure. Legacy activity conflicts no longer stop the upgrade. Closing an SDK client releases mailbox database resources.
- **Plugin IM diagnostics.** Channel settings show plugin receive failures and clear the corresponding diagnostic when its source recovers.

## Upgrade

Finish work in other Kiki processes using the same home and close them before upgrading. If startup reports an active writer, close that process before retrying. Keep mailbox originals and recovery copies until you have verified the upgraded sessions. See [`kiki storage`](https://x-t-e-r.github.io/kiki/en/reference/command#kiki-storage) for status, backup, and rollback.

Download the desktop package for your system from this release: Windows x64 includes the CLI; Linux x64 provides AppImage and deb packages; macOS provides Apple Silicon and Intel dmg packages. Each package has an adjacent `.sha256` file.

For npm, use Node.js 24.22.1 or later on the 24 line, or 26.12.1 or later; Node.js 25 and earlier 26 releases are not supported:

```sh
npm install -g kiki-agent@0.5.1
```

For CLI/TUI only:

```sh
npm install -g kiki-agent-lite@0.5.1
```

Standalone CLI downloads are `kiki-linux-x64`, `kiki-linux-arm64`, `kiki-darwin-x64`, and `kiki-darwin-arm64`, each with an adjacent `.sha256` file. Windows receives the CLI through its installer or npm.

Windows installers are not Authenticode-signed; SmartScreen may show **Unknown publisher**. Windows x64 automatic updates use a separate release-key signature. macOS downloads are unsigned and not notarized; follow the [first-open and CLI-linking steps](https://x-t-e-r.github.io/kiki/en/getting-started/installation#install-the-desktop-app). Linux and macOS desktop updates use manual replacement.

[Installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation) · [Report a problem](https://github.com/X-T-E-R/kiki/issues)
