# Kiki 0.5.1

This release shows conversation text sooner, upgrades saved memory to SQLite automatically, and reorganizes settings. It also fixes conversation recovery, message delivery feedback, and task completion wakeups.

## What changed

- **Opening conversations.** Recent main and subagent messages can appear while session details and older history are still loading. Opening a subagent avoids repeated transcript reloads, and sidebar capability lists load when opened.
- **Conversation history.** History tools can return recent turns before preparing the entire conversation. Older conversations retain their prompts when paging through history. Editing and resending earlier turns no longer leaves duplicate messages, and streaming message batches keep each message's text separate. Session forks skip temporary journal locks, and existing Linux conversations with backslashes in their identifiers remain accessible.
- **Saved memory.** Startup automatically imports and validates existing memory in SQLite, preserving original files and the memory on/off setting. Corrected or forgotten memory is removed from later model requests. Complete search results and explicit links in task notes can be reused without repeating the same entry body. Export an entry as Markdown and preview an edited file before importing it; ordinary edits remain undoable, while explicit **Forget permanently** clears historical payloads.
- **Memory Advisor.** An optional model can recommend relevant memory within the existing context budget. Choose its model and confirm the destination for each workspace in **Settings → Memory** before it sends memory out.
- **Questions and task completion.** Locally answered questions stay at their original position through live updates and conversation reopen. Background question history shows the current answer status. Task completion can wake the main agent after runtime goal pauses and turn exits.
- **Models and context.** Main and subagent context overviews update when model limits change. Live history preserves execution settings attached to individual messages. Tool selection no longer reports tools that are already available as policy-denied.
- **External engines and recovery.** Send-now controls follow the engine's reported support for in-turn messages, and delivery receipts remain accurate when a turn finishes. ACP permission-mode confirmation, interrupted model streams, external executor startup recovery, and retries for empty compaction summaries are corrected.
- **Browser and computer settings.** Browser connections share one default selector and open their details in place. Browser-control consent covers both launching and attaching. Computer status follows the selected connection, distinguishes configured external executors from the bundled CUA installation, and retries failed configuration reads. Unused browser sources no longer produce a setup-task count.
- **Other settings.** Sessions are grouped into Conversations, Agent behavior, and Background; external access is grouped into Browser, Other Kiki, and Agents & clients. Saved workspace memory overrides remain editable when global memory is off, with their effective state shown separately. Tool explanations, reviewer tuning, hook files, and raw engine configuration move into help or Advanced.
- **Usage history.** Large date ranges reuse indexed totals instead of scanning every usage row. Loading continues through bounded partial results, and known cost subtotals remain visible while work continues. Period comparisons use the server's returned range, and conversation rewrites invalidate old totals before results are marked complete. A first rebuild still needs to import the saved journals.
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
