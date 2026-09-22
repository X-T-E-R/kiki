# Workspaces and sessions

Kiki persists every conversation as a "session" — storing message history and metadata so you can close the terminal or the browser and pick up right where you left off. The desktop app, browser GUI, and CLI/TUI all read and write the same session data. This page covers how to manage workspaces and sessions, use the requirements board, resume and fork sessions, and export or compress context.

## Session storage

All sessions are saved under `$KIKI_HOME/sessions/` (default: `~/.kiki/sessions/`), grouped by working directory. You do not need to touch these files in daily use — they matter when you need to debug, troubleshoot, or back up sessions:

```text
~/.kiki/
├── config.toml
├── session_index.jsonl
└── sessions/
    └── <workDirKey>/
        └── <sessionId>/
            ├── state.json
            └── agents/
                ├── main/
                │   └── wire.jsonl
                └── <subagentId>/
                    └── wire.jsonl
```

- `state.json`: session metadata such as title and creation time.
- `agents/*/wire.jsonl`: the agent event stream, used for session recovery and replay. It also carries a request trace — the tool definitions, request parameters, and MCP tool listings sent to the model — for debugging.

::: warning
Do not manually edit files inside the `sessions/` directory — doing so may prevent sessions from being restored correctly.
:::

The desktop and browser GUI store new-session choices separately from this CLI directory. When draft persistence is enabled, the GUI remembers the selected model and effort, plus the workspace, working directory, and profile (the agent's configuration file), across navigation and browser refresh. A session's inherited model and a local override are distinct: changing the local effort does not silently replace the model inherited from the current session. The **Composer → Persist composer drafts** toggle in Settings controls whether these selections and the per-session draft text are written to this browser; turning it off clears the saved store. Drafts in the currently open page are unaffected by turning the toggle off; a refresh or restart starts with no restored selection.

> The two GUI paragraphs above do not apply to CLI users — feel free to skip them.

## Requirements board

Open the requirements board from the fixed button at the bottom of the main agent's right panel. The board is fully built into Kiki — no additional installation is needed. Cards organize requirements and their links to sessions, not running agents. Todo lists remain separate and local to each agent.

Cards appear a page at a time; counts and search results cover the cards loaded so far while syncing continues. Switching workspace scope or closing the board cancels further page loading. In a new-card form, card details, or a confirmation, `Tab` stays inside the topmost dialog and `Esc` closes only that dialog, returning focus to its opener. Dialogs cannot be dismissed while their save or delete request is pending.

Trust the workspace before creating or editing cards. Storage is controlled by the `taskBoard.storage` setting: `auto` reuses a compatible workspace store first, or uses `sessions/<workspaceId>/.board`; `global` uses the `boards` directory under the Kiki home; `fixed` uses an absolute path or a path relative to the workspace that you provide. Paths are not executed as scripts. Previewing a location does not create it or grant write access; save the configuration before creating there. Nonempty incompatible directories are rejected.

Changing the storage setting does not migrate cards; existing cards keep referencing their original store. If another edit wins, reload the card before retrying; failed edits retain the draft. The main agent can read and write the board with the `BoardRead` and `BoardWrite` tools under normal tool policy and approval rules; subagents keep TodoList. Plan mode cannot use `BoardWrite`.

## Starting and resuming sessions

Every time you run `kiki` directly it creates a new session. To resume a previous session, use one of the following:

**Resume the most recent session in the current directory (`-c` is the short form of `--continue`, the same `kiki -c` shown in [First launch](../getting-started/first-launch.md)):**

```sh
kiki --continue
```

**Resume a specific session by ID (`abc123` is just an example ID):**

```sh
kiki --session abc123
```

**Interactively browse session history and choose one (what `--session` does without an ID):**

```sh
kiki --session
```

::: warning
`--continue` and `--session` are mutually exclusive.
:::

In the GUI, a saved model, profile, or effort that is no longer available remains visible with a diagnostic. Select a valid value before sending; the GUI does not silently substitute another model or profile. An error shown while the list is still loading or when the catalog request fails does not mean your saved choice is invalid.

## Switching sessions inside the TUI

You can manage sessions without leaving the terminal. The following slash commands are available only when the agent is idle:

- **`/new`** (alias `/clear`): switch to a new session, discarding the current context.
- **`/sessions`** (alias `/resume`): browse and resume a previous session.
- **`/fork`**: fork the current session (see below).
- **`/title <text>`** (alias `/rename`): set a session title for easier identification; without arguments, displays the current title.

## GUI session recovery and activity

When session recovery fails, the GUI keeps the history that was already loaded and shows the error together with a request ID when one is available. A **Retry now** button in the same area calls the recovery action directly.

Resolved questions, approvals, markers, and background-task completion notices stay inline in the timeline at their original position, rendered as compact one-line entries; consecutive entries fold into an expandable "Activity history" row, while failed or cancelled entries always remain individually visible. The timeline focuses on unfinished work; completed task output remains available in task history. File references can be previewed, opened, or shown in their containing folder from the relevant session view.

## GUI usage statistics

Opening **Usage** without filters starts with today in the browser's local time. An explicit range in the URL takes precedence; a previously saved all-history view does not replace this default. The page refreshes its date boundary across midnight and when the browser's timezone offset changes.

Token usage and estimated cost have separate completeness indicators. When a provider does not return usage, Kiki marks it as unknown rather than a real zero. Mixed results show the recorded subtotal with an incomplete-accounting notice. Older zero records without accounting provenance remain ambiguous; Kiki does not reconstruct missing tokens from them. Missing model prices affect cost estimates, not recorded token counts. The **Data reliability** section distinguishes these cases from an empty range or a failed request.

## Context compression

As a conversation grows, Kiki automatically compresses the message history when the context approaches the window limit, freeing up token space. You can also trigger compression manually at any time:

```sh
/compact
```

You can pass a hint to tell the model what to prioritize when compressing:

```sh
/compact Keep the discussion about database migrations
```

## Forking a session

To explore a new direction without disrupting the current conversation, use `/fork`:

```sh
/fork
```

Forking does not switch you away: you stay in the original session and the conversation continues untouched. The fork is an independent copy you can switch to at any time using `/sessions`. A saved `/goal` is not copied to the fork. Start a new goal there if you want autonomous goal work.

After forking, the CLI prints a ready-to-run `kiki --resume` command (also copied to the clipboard) so you can enter the fork directly from a new terminal process.

## Exporting a session

Use `kiki export` to package a session as a ZIP file — useful for sharing, archiving, or filing a bug report:

```sh
kiki export <sessionId>
```

Omitting `sessionId` exports the most recent session in the current directory (with an interactive confirmation prompt; add `-y` to skip). Use `-o` to specify an output path:

```sh
kiki export <sessionId> -o ~/Desktop/my-session.zip
```

The export includes all files in the session directory, including diagnostic logs. The global diagnostic log (`~/.kiki/logs/kimi-code.log` — the file name follows the project's early naming; it is Kiki's global log) is also bundled by default; add `--no-include-global-log` to exclude it.

You can also export from inside the TUI without leaving the interactive session:

- **`/export-debug-zip`**: produces the same debug ZIP as `kiki export`.
- **`/export-md`** (alias `/export`): exports the conversation as a human-readable Markdown file, suitable for sharing or archiving. Accepts an optional path argument; without one, it writes to `kimi-export-<short-id>-<timestamp>.md` in the current working directory.

In the web UI, `/export` downloads the current session as a diagnostic ZIP. It includes the persisted session data, diagnostic logs, and a bounded metadata-only `logs/kimi-web.jsonl` record of key browser events. Prompt text, WebSocket payloads, and console arguments are not copied into this browser log. This web command differs from the TUI `/export` alias above.

::: tip
Exported files may contain code, command output, and file paths that are sensitive. Review the content before sharing.
:::

## Next steps

- [Data locations](../configuration/data-locations.md) — full directory layout for session files
- [kiki command reference](../reference/command.md) — complete parameter reference for `--continue`, `--session`, `export`, and other commands
