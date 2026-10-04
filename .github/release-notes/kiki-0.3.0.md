# Kiki 0.3.0

This release brings the workbench, connections, and long-running work into a more consistent interface. It also lets you bring conversations from other agent tools into Kiki and continue them without installing an import plugin.

## Highlights

- **A clearer workbench.** Finished stretches of tool calls fold into readable timeline entries; failures stay visible. Message annotations, a "Needs you" tray, and an agent-focused right rail keep drafts, approvals, questions, and subagent work together. The usage page separates History and Live views and marks missing usage as unknown rather than zero. Live request details open by default with model, provider, and role views you can switch between. Model settings pair short fields, and WebBridge shows its status and actions without a diagnostic panel.
- **More control over long work.** Adjust the compaction point and choose Summarize, Fresh, or Auto context renewal. Fresh restarts from reviewed working notes only when the handoff is safe. Goals, per-message send timing, scheduled prompts, and persistent task-board cards help work continue across turns. Memory has global, workspace, and persona scopes, with a review inbox and undoable edits.
- **Personas and conversations stay connected.** Each persona has a stable daily conversation, its own memory, and additional conversations you can switch between. Rooms let personas and existing threads discuss one topic with a host, pause/continue controls, and a message budget.
- **Spaces, remote Kikis, and browser access have separate controls.** Spaces can share or isolate credentials. Remote connections require target-side approval; thread bridges grant only their named message operations. Web access offers temporary or persistent access through a one-time sign-in link and revocable browser sessions. A Web access link grants full access to this Kiki: share it only with someone you trust, and use HTTPS outside a trusted network. Session SSH hosts remain session resources rather than repeated message attachments.
- **Connections are one list.** Add an API, local server, or account sign-in from the same flow. First-model setup opens connection settings for OAuth sign-in or API-key configuration. OAuth sign-in and recovery stay on each connection's row. ChatGPT (Codex) and Grok Build can reuse a sign-in on the server machine after you inspect the account; disconnecting it in Kiki removes Kiki's reference without signing out the other app.
- **Bring your history with you.** Import Claude Code, Codex, Pi, Grok Build, OpenCode exports, or custom JSON/scripts as a continuable Kiki session or a read-only archive. Preview retained content and losses before importing; source files are unchanged. Old tool calls become history text, never replayed actions or permissions. Custom import scripts run as your account, not in a sandbox—choose only code you trust. See [history import](https://x-t-e-r.github.io/kiki/en/customization/plugins#session-history-import).
- **Inspect and extend capabilities.** Search & retrieval shows the effective source, named lanes, and readiness. Kiki Documents extracts local files into Markdown; Kiki Notion connects to Notion's hosted MCP service. Plugins, skills, MCP servers, and prompt-field overrides remain separate extension choices. Plugin tools now retain media supplied by URL. Experimental media sources add image, video, and speech settings and job receipts, but generation is off by default; stopping a job ends the local wait, not necessarily provider work or charges.
- **Make the window your own.** Six built-in light/dark skins, local picture or video backgrounds, appearance packs, and font/density controls apply without changing permissions. New illustrated [feature guides](https://x-t-e-r.github.io/kiki/en/features/) cover the workbench, long work, personas, spaces, customization, and extensions.

## Upgrade and compatibility

- **Migrate older agent-authoring fields before using them.** The author fields `subagents` and `subagent_policy`, and host settings `main_dispatch_policy` and `subagent_dispatch_policy`, are removed. Use `preferred_subagents` for advice, `allowed_subagents` / `deny_subagents` for preset boundaries, and `can_spawn_subagents: false` for a leaf role. Explicit Markdown definitions remain independent of preset-name lists; saved bindings retain their role, model, prompt, and source snapshot, and existing conversation history is not erased. See [subagent permissions](https://x-t-e-r.github.io/kiki/en/customization/agents#agent-file-format).
- **Hard model lists are now literal boundaries.** If `allowed_models`, `deny_models`, or `allowed_efforts` were only recommendations, move that advice to `preferred_models`, `discouraged_models`, or `preferred_efforts`. A saved binding outside a hard rule is rejected on resume; select an allowed value or deliberately revise the rule.
- Fix packaged desktop startup with the shared daemon and intermittent failures when sending API responses. Server shutdown now closes unused TCP connections.
- Fix missing messages when restoring older session snapshots and incorrect cursors when paging through saved history. Reading a nonexistent transcript no longer adds a phantom agent to the roster. Keep checkpoint indexes consistent for records updated during a checkpoint build.
- Keep withdrawn input out of fresh model switches, activate capability changes before tool selection, and read saved session details without resuming sessions. ACP reports each session's actual permission mode on creation or restore.
- Keep existing settings and credentials files owner-only on Unix during configuration updates.
- Update desktop and server together. History import does not copy attachments, account credentials, approvals, or running tasks; read the preview's loss list before continuing an imported session. Scheduled prompts fire only while Kiki holds their session open.
- Windows installers are not EV code-signed, so SmartScreen may prompt. The Windows x64 updater requires release-key-signed artifacts; this is not Windows code signing. macOS DMGs and standalone CLI files are unsigned and not notarized. Linux and macOS desktop updates are manual; see the [installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation).

## Downloads

| Platform | Desktop file |
| --- | --- |
| Windows x64 | `Kiki_0.3.0_x64-setup.exe` (NSIS, includes CLI) |
| Linux x64 | `Kiki_0.3.0_amd64.AppImage` or `Kiki_0.3.0_amd64.deb` |
| macOS Apple Silicon | `Kiki_0.3.0_aarch64.dmg` |
| macOS Intel | `Kiki_0.3.0_x64.dmg` |

Standalone CLI downloads are `kiki-linux-x64`, `kiki-linux-arm64`, `kiki-darwin-x64`, and `kiki-darwin-arm64`, each with a matching `.sha256` file. Windows x64 gets the CLI through the NSIS installer; separate Windows CLI executables are not uploaded to this Release. For npm installs, use `kiki-agent` (desktop and CLI) or `kiki-agent-lite` (CLI/TUI only), with Node.js 24.15 or newer.

Compare each download with its adjacent `.sha256` file. On Windows, run `Get-FileHash Kiki_0.3.0_x64-setup.exe -Algorithm SHA256`; on macOS or Linux, run `shasum -a 256 <downloaded-file>`. Documentation: https://x-t-e-r.github.io/kiki/. Bugs and feedback: https://github.com/X-T-E-R/kiki/issues.
