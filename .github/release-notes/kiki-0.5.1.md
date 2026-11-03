# Kiki 0.5.1

This release makes large conversations easier to read and annotate, preserves your work across desktop reconnects, and lets saved conversations rebuild their context without changing identity. It also upgrades saved memory to SQLite automatically and reorganizes settings.

## What changed

- **Opening conversations.** Recent main and subagent messages can appear while session details and older history are still loading. Opening a subagent avoids repeated transcript reloads, and sidebar capability lists load when opened.
- **Conversation history.** Scroll back through large conversations without losing older text or your reading position. Older-history pages default to 40 turns with a 512 KiB budget; expanding partially loaded messages or tool results automatically continues reading. History tools can return recent turns before preparing the entire conversation. Editing and resending earlier turns no longer leaves duplicate messages, and streaming message batches keep each message's text separate. Session forks skip temporary journal locks, and existing Linux conversations with backslashes in their identifiers remain accessible.
- **Saved-conversation context.** Rebuild context in an inactive saved conversation without creating a new session. The same session ID, bindings, permissions, and history are retained, current instruction sources are reloaded, and rebuilding sends no model request.
- **Desktop exit and reconnect.** Tray **Quit** stops the desktop-managed local service and exits; closing the window leaves the service running. Reconnecting to the verified same-home service preserves your draft and reading position. Externally managed and remote services keep their existing ownership.
- **Annotations and composing.** Saving selection annotations does less repeated work in large conversations. Add multiple ordered selections with optional comments, including quote-only selections. Applying composer edits keeps the text and caret together instead of moving the cursor unexpectedly.
- **Saved memory.** Startup automatically imports and validates existing memory in SQLite, preserving original files and the memory on/off setting. Corrected or forgotten memory is removed from later model requests. Complete search results and explicit links in task notes can be reused without repeating the same entry body. Export an entry as Markdown and preview an edited file before importing it; ordinary edits remain undoable, while explicit **Forget permanently** clears historical payloads.
- **Memory Advisor.** An optional model can recommend relevant memory within the existing context budget. Choose its model and confirm the destination for each workspace in **Settings → Memory** before it sends memory out.
- **Questions and task completion.** Locally answered questions stay at their original position through live updates and conversation reopen. Background question history shows the current answer status. Task completion can wake the main agent after runtime goal pauses and turn exits.
- **Storage recovery.** After disk-full or temporary storage failures, agents keep retrying pending saves at low frequency. Once storage recovers, the original task and notification finish without repeating model or tool work. Partially written records are checked before only their missing bytes are appended; changed journal bytes remain blocked for inspection.
- **Models and context.** Main and subagent context overviews update when model limits change. Live history preserves execution settings attached to individual messages. Tool selection no longer reports tools that are already available as policy-denied.
- **External engines and recovery.** Native vendor tools use the external engine's own permission controls without a duplicate Kiki approval gate; explicit caller restrictions and authorization for Kiki tools remain in force. Send-now controls follow the engine's reported support for in-turn messages, and delivery receipts remain accurate when a turn finishes. ACP permission-mode confirmation, interrupted model streams, external executor startup recovery, and retries for empty compaction summaries are corrected.
- **Resuming subagents.** `AgentRun` accepts `context_mode: direct`, `compact`, or `fresh` when resuming an idle child. `direct` keeps its current context; `compact` summarizes it with the current model; `fresh` rebuilds from saved task state and history without calling the old model. All keep the same child ID, Todo, history, and workspace. Context rebuilding is supported by native Kiki executions.
- **Browser and computer settings.** Browser connections share one default selector and open their details in place. Browser-control consent covers both launching and attaching. Computer status follows the selected connection, distinguishes configured external executors from the bundled CUA installation, and retries failed configuration reads. Unused browser sources no longer produce a setup-task count.
- **Other settings.** Sessions are grouped into Conversations, Agent behavior, and Background; external access is grouped into Browser, Other Kiki, and Agents & clients. Saved workspace memory overrides remain editable when global memory is off, with their effective state shown separately. Tool explanations, reviewer tuning, hook files, and raw engine configuration move into help or Advanced.
- **Usage.** A compact page title keeps the dashboard in view. Live sessions show their titles with a short-ID fallback, and multiple running sessions fold by default while paused, failed, and action-needed rows stay visible. Large date ranges reuse indexed totals instead of scanning every usage row. Loading continues through bounded partial results, and known cost subtotals remain visible while work continues. Period comparisons use the server's returned range, and conversation rewrites invalidate old totals before results are marked complete. A first rebuild still needs to import the saved journals.
- **Provider failure details.** Late Responses WebSocket errors no longer crash the Node process; active-stream provider errors remain visible. Exhausted retries are reported as `Retry attempts exhausted (N/M).` in final turn and task failures, alongside the original error.
- **Mailbox upgrades and SDK shutdown.** Mailbox upgrades preserve message deduplication and identify the source of an upgrade failure. Legacy activity conflicts no longer stop the upgrade. Closing an SDK client releases mailbox database resources.
- **Plugin IM diagnostics.** Channel settings show plugin receive failures and clear the corresponding diagnostic when its source recovers.

## Upgrade

Finish work in other Kiki processes using the same home and close them before upgrading. If startup reports an active writer, close that process before retrying. Keep mailbox originals and recovery copies until you have verified the upgraded sessions. See [`kiki storage`](https://x-t-e-r.github.io/kiki/en/reference/command#kiki-storage) for status, backup, and rollback.

Download the desktop package for your system from this release. Each has an adjacent `.sha256` file:

| System | Asset |
| --- | --- |
| Windows x64, including CLI | `Kiki_0.5.1_x64-setup.exe` |
| Linux x64 | `Kiki_0.5.1_amd64.AppImage` or `Kiki_0.5.1_amd64.deb` |
| macOS Apple Silicon | `Kiki_0.5.1_aarch64.dmg` |
| macOS Intel | `Kiki_0.5.1_x64.dmg` |

For npm, use Node.js 24.22.1 or later on the 24 line, or 26.12.1 or later; Node.js 25 and earlier 26 releases are not supported:

```sh
npm install -g kiki-agent@0.5.1
```

For CLI/TUI only:

```sh
npm install -g kiki-agent-lite@0.5.1
```

Standalone CLI downloads are `kiki-linux-x64`, `kiki-linux-arm64`, `kiki-darwin-x64`, and `kiki-darwin-arm64`, each with an adjacent `.sha256` file. Windows receives the CLI through its installer or npm.

Windows installers are not Authenticode-signed; SmartScreen may show **Unknown publisher**. Verify the downloaded installer against its adjacent `.sha256` file. Windows x64 automatic updates use a separate release-key signature.

macOS downloads are unsigned and not notarized. After verifying the hash, mount the dmg, drag Kiki to Applications, then Control-click it and choose **Open** on first launch; confirm **Open** in the dialog. If macOS still blocks that verified copy, run `xattr -dr com.apple.quarantine /Applications/Kiki.app`. See the [installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation#install-the-desktop-app) to link the bundled CLI. Linux and macOS desktop updates use manual replacement.

[Installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation) · [Report a problem](https://github.com/X-T-E-R/kiki/issues)
