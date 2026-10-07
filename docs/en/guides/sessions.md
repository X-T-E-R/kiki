# Workspaces and sessions

Every conversation is saved as a session — its message history and metadata — so you can close the terminal or the browser and pick the work up later. The desktop app, the browser UI and the CLI/TUI all read and write the same sessions. This page covers workspaces, resuming and forking, the task board, compression and export.

## Session storage

Sessions are saved under `$KIKI_HOME/sessions/` (default: `~/.kiki/sessions/`), grouped by working directory. You never need to touch these files to use Kiki; they are here to read when you are debugging or backing up:

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

In the desktop and browser GUI, the model, effort, workspace, working directory and profile (the agent's configuration file) you pick for a new session can be remembered across navigation and refresh. Turn that on with **Composer → Persist composer drafts** in Settings; turning it off clears what was saved. Drafts in the page you currently have open survive the switch, but the next refresh starts with nothing restored. This is separate from the session files above, which is why the two behave differently.

An existing conversation reopens on its committed model and effort. Old composer display values do not undo a later model switch; a new explicit draft choice is retained while its original binding is current. A completed model switch stays completed after recovery and needs neither a retry nor another message to confirm it.

## Task board

The task board lives behind the fixed button at the bottom of the main agent's right panel. Cards hold requirements and the sessions linked to them; an agent's own todo list stays separate and local to that agent.

Cards load a page at a time, so counts and search results cover what has loaded so far while syncing continues. Changing the workspace scope or closing the board stops further loading. In a card form, card detail, or confirmation, `Tab` stays in the topmost dialog and `Esc` closes only that dialog and returns focus to whatever opened it. A dialog cannot be dismissed while its save or delete is still in flight.

Trust the workspace before you create or edit cards there. Where they are stored is set by `taskBoard.storage`: `auto` reuses a compatible workspace store if it finds one and otherwise uses `sessions/<workspaceId>/.board`; `global` uses the `boards` directory under the Kiki home; `fixed` uses an absolute path, or one relative to the workspace, that you provide. Previewing a path does not create it or give Kiki write access — save the setting first. A directory that exists but cannot hold a board is rejected.

Changing the setting does not move existing cards; they keep pointing at the store they were created in. If someone else saved a change first, reload the card and try again — a failed edit keeps your draft. The main agent reads and writes the board with `BoardRead` and `BoardWrite` under the normal tool policy and approval rules; subagents need [explicit permission](../configuration/config-files.md#subagent) for those, keep their own `TodoList`, and Plan mode cannot use `BoardWrite` at all.

After a compaction, the handoff can list up to five cards linked to the session, with ids, titles and statuses. That list needs the board feature and `BoardRead` enabled, and is simply absent if the read fails or takes more than 500 ms. Card status is never updated from todo lists or finished agent runs.

## Starting and resuming sessions

On the **New session** page in the desktop app or browser you can pick an existing workspace, type an absolute project directory, or choose **Automatically create a workspace** (the default when nothing is registered yet). With the automatic option, your first send creates a directory under `$KIKI_HOME/workspaces/` (default: `~/.kiki/workspaces/`), registers it, and opens the session there. If you picked a workspace explicitly and it was deleted since, it stays invalid until you choose another one or switch to automatic — Kiki will not quietly open a different workspace. [Data locations](../configuration/data-locations.md#directory-layout) has the layout and what cleanup touches.

Opening a saved session reads its history without waking an inactive session's agents, and selecting a subagent reads that subagent's history without the main agent's conversation. The session activates when you send, edit or regenerate a message, answer an approval or question, or steer a prompt. If activation fails, nothing is sent and the history stays readable. Reading a session never stops work already running in it.

A subagent resumed with the same model reads **Resumed · continuing with…**, not **Switched to…**. Actual model changes, thinking-effort updates and context rebuilds keep their own labels.

The GUI opens with a small window of the latest messages. Scrolling up loads the next earlier page automatically; staying in the conversation does not load its entire history in the background. When earlier pages remain, **Load earlier messages** is available even if the current window has no visible messages. Visible messages and expanded entries load the details they need. Jumping to an older message or returning to a saved reading position continues loading until that place is found; scrolling yourself cancels the old jump. Older message previews may be fetched again as you scroll to keep the reading cache small. Leaving the conversation cancels its pending reads, not the agent's work. A real read failure keeps the messages already loaded and offers a retry; [Reading timeout](./settings.md#timeouts) controls how long a read may wait.

If only part of the message records has loaded, the composer header shows **More message records**, even when no loaded message is queued. Open it and choose **Continue loading** to read one more page; a failed read offers **Try again** without removing existing queue rows. The progress counts message records, including completed ones, not just messages waiting to send.

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

In the GUI, a saved model, profile or effort that is no longer available stays visible with a diagnostic. Pick a valid value before sending — the GUI will not quietly swap in a different model or profile. An error while the list is still loading, or a failed catalog request, does not mean your saved choice is bad.

## Switching sessions inside the TUI

You can manage sessions without leaving the terminal. The following slash commands are available only when the agent is idle:

- **`/new`** (alias `/clear`): switch to a new session, discarding the current context.
- **`/sessions`** (alias `/resume`): browse and resume a previous session.
- **`/fork`**: fork the current session (see below).
- **`/title <text>`** (alias `/rename`): set a session title for easier identification; without arguments, displays the current title.

## GUI session recovery and activity

A thread created by another thread nests under its creator by default. **Show at top level** in the row's menu lifts it into its own top-level row, and **Show nested** puts it back. The creator relationship stays recorded, and the choice survives a refresh or restart in the same browser or desktop space. The same menu also offers **Copy thread link** for a link to that thread, and **Add to conversation** to drop a reference to it into the conversation you currently have open.

Archiving a thread also archives its attached conversations, including deeper descendants and conversations not loaded in the sidebar. A thread explicitly shown at top level, together with its descendants, stays independent when its ancestor is archived; archiving that top-level thread itself still includes its attached conversations. A filter or workspace group that merely displays a child as a top-level row does not make it independent. Archive preserves history and does not remove worktrees. If only some conversations are archived, retry to finish the remaining ones. Restoring a thread restores only that thread, not every previously archived descendant.

Open **Settings → Sessions → Manage archived conversations** to browse saved archives by title, workspace and time. Search matches titles and workspaces across pages; opening a conversation reads its history without restoring it. Return to the archive manager to continue browsing.

**Delete** permanently removes that conversation and its still-attached archived descendants; explicitly top-level threads remain independent, and unarchived conversations are kept. **Delete all archived conversations** covers every archive in the current connection's home, across all pages and regardless of the search. Both actions ask for confirmation; cancelling leaves the data unchanged. Deletion cannot be undone. The page stays pending until the operation finishes, then refreshes the list. If some items fail, it lists those items rather than reporting complete success; check the refreshed list before retrying.

The sidebar sorts threads by their own update time. A thread shown at top level keeps its own position and time group: activity in it does not move its parent, and activity in the parent does not carry it along. Nested threads still follow their creator's row.

If session recovery fails, the GUI keeps whatever history it had already loaded and shows the error, with a request ID when there is one. **Retry now** next to it reruns the recovery.

Editing a queued prompt's text or delivery timing through Kiki keeps its identity on recovery; you do not need to restore the original text or send a duplicate. If a completed turn cannot be saved because storage is temporarily unavailable, Kiki briefly retries saving the same result without running the turn again. A longer outage keeps the turn waiting for persistence; after storage is writable again, submitting the next prompt retries that save before continuing. A pending save is not confirmation that the result is on disk.

Resolved questions, approvals, markers and finished background tasks stay in the timeline as compact entries. Finished work can be grouped under **Worked**; expand it to see the individual entries. Expanding a question shows the full question and, for an answered one, the saved answer — dismissed and expired questions show their original choices too. Output from completed tasks stays in task history. File references can be previewed, opened or revealed in their folder; a preview is generated on demand, and the original file is still there to open or download.

Images in sent attachments and in tool results appear as soon as they scroll into view — you do not click to load them. Clicking one opens it full size, and a real failure offers a retry. The viewer keeps its own **Download**; there is no second download link under each image.

User messages show linked threads, attachments, quotations and notes as their own readable items, without generated prompt instructions in the bubble. Text you write yourself, including XML, code and blockquotes, stays visible. Older messages without recorded display metadata remain unchanged.

Click a file citation such as `src/example.ts:12:7` or `docs/example.md#L12-L20` in a message to open its tab at that source location. References in inline code and ordinary text are clickable too. Markdown line citations open **Source**; a link such as `[section](docs/example.md#heading)` opens the rendered heading. Inside a Markdown document, `#heading` stays in that document and relative links start from its directory. Reopening a citation reuses the tab and keeps unsaved edits. A missing or out-of-range target leaves the file open with a location notice.

Markdown previews otherwise open rendered. **Source** shows the text, and in the desktop app you can edit it there when a write channel is available. The rendered view handles tables, math, diagrams and images linked relative to the Markdown file. A file above roughly 512 KB starts as its opening portion and keeps loading the rest in the background; it stays read-only at that size, so use **Source** to read it but edit smaller files. If the background read fails, the view says so and offers a retry.

## GUI usage statistics

**Usage → History** opens on today in the browser's local time. A range in the URL overrides that, and a saved all-history view does not replace it. The page keeps its date boundary correct across midnight and when the browser's timezone offset changes.

Start with the cost trend, then select a bar to see the consumption sources for that interval. Group sources by model, provider, agent profile, or workspace; selecting a source narrows that dimension while keeping the date range and other filters. Open its session records on demand and use the recorded turn's link to jump to the original conversation. Returning keeps your usage view. Records without turn attribution say so instead of offering a guessed location.

For a bounded date range, request the previous-period comparison when you need it. Missing prior data is shown as unavailable, not zero; a failed comparison leaves the current period readable. The collapsed live reference remains separate from the selected history.

Token usage and estimated cost each carry their own completeness marker. If a provider returned no usage, Kiki shows that as unknown rather than as a real zero, and mixed results show the recorded subtotal with an incomplete-accounting notice. A missing model price affects the cost estimate only, never the recorded token count. **Data reliability** tells these cases apart from an empty range or a failed request.

## Context compression

As a conversation grows, Kiki automatically compresses the message history when the context approaches the window limit, freeing up token space. You can also trigger compression manually at any time:

```sh
/compact
```

You can pass a hint to tell the model what to prioritize when compressing:

```sh
/compact Keep the discussion about database migrations
```

You can ask for a compaction while the agent is already working. Kiki queues the request and runs it once the current response and the tools it called have finished, without waiting for the rest of the turn. Asking again while a manual compaction is queued or running does nothing — there is only ever one. The line above the context meter says which one you are watching and how far along it is: **Manual compaction queued**, then **running**, then **complete**. A run that cannot compact ends as **failed**. The automatic one from the context limit reads the same way, with *Automatic* in place of *Manual*.

The timeline distinguishes **Compaction queued** from **Generating the summary…** and shows **summary generated** only after the compacted context is committed. Failure, cancellation and an interrupted cold-session run do not count as successes. Consecutive successful commits may share one divider labelled **3 successful compactions**, for example; expand it for each commit's time and recorded reasons. This count is not the number of generation retries.

The context meter under the composer shows the same numbers, lets you set the compaction point, and carries the renewal strategy: **summarize**, **fresh** (restart from the agent's working notes), or **auto** (the built-in main-agent default: restart when the notes safely cover the work, otherwise summarize). `/autocompact` shows or moves the compaction point from the terminal. Facts that must survive compression belong in [memory](./memory.md), which outlives the session.

## Forking a session

`/fork` copies the current session so you can try a different direction without disturbing this one:

```sh
/fork
```

You stay in the original session; the fork is an independent copy you can switch to whenever you like with `/sessions`. A `/goal` you saved does not come along — set one in the fork if you want goal-driven work there. New forks do not inherit scheduled tasks, whether you copy the full session, fork at a turn boundary, or create a child session. Schedules in the original session and existing copies stay unchanged; create a new task explicitly in the new session if needed. The CLI prints a ready-to-run `kiki --resume` command, also on your clipboard, so you can open the fork from a fresh terminal.

## Exporting a session

Use `kiki export` to package a session as a ZIP file — useful for sharing, archiving, or filing a bug report:

```sh
kiki export <sessionId>
```

Omitting `sessionId` exports the most recent session in the current directory (with an interactive confirmation prompt; add `-y` to skip). Use `-o` to specify an output path:

```sh
kiki export <sessionId> -o ~/Desktop/my-session.zip
```

The export includes everything in the session directory, diagnostic logs included, plus the global log at `~/.kiki/logs/kimi-code.log` (the name is inherited from the project's earlier naming). Add `--no-include-global-log` to leave that one out.

You can also export from inside the TUI without leaving the interactive session:

- **`/export-debug-zip`**: produces the same debug ZIP as `kiki export`.
- **`/export-md`** (alias `/export`): exports the conversation as a human-readable Markdown file, suitable for sharing or archiving. Accepts an optional path argument; without one, it writes to `kimi-export-<short-id>-<timestamp>.md` in the current working directory.

In the web UI, `/export` downloads the current session as a diagnostic ZIP: the persisted session data, diagnostic logs, and a bounded metadata-only `logs/kimi-web.jsonl` record of key browser events. Prompt text, WebSocket payloads and console arguments are not copied into that browser log. This is a different command from the TUI `/export` alias above.

::: tip
Exported files may contain code, command output, and file paths that are sensitive. Review the content before sharing.
:::

## Next steps

- [Data locations](../configuration/data-locations.md) — full directory layout for session files
- [kiki command reference](../reference/command.md) — complete parameter reference for `--continue`, `--session`, `export`, and other commands
