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

[`kiki session seal`](../reference/command.md#kiki-session) keeps each `wire.jsonl` and does not shrink it. An active session is refused. A read that is already open waits. A damaged seal fails instead of quietly using the raw file, and [`kiki session unseal`](../reference/command.md#kiki-session) removes the seal so later reads use the original file again.

::: warning
Do not manually edit files inside the `sessions/` directory — doing so may prevent sessions from being restored correctly.
:::

In the desktop and browser GUI, the model, effort, workspace, working directory and profile (the agent's configuration file) you pick for a new session can be remembered across navigation and refresh. Turn that on with **Composer → Persist composer drafts** in Settings; turning it off clears what was saved. Drafts in the page you currently have open survive the switch, but the next refresh starts with nothing restored. This is separate from the session files above, which is why the two behave differently.

Before you choose an effort manually, changing the model or profile uses the profile's effort default for the selected model, including matching [`model_profiles` entries](../customization/agent-profiles.md), then the model's own default. A new persona draft uses the persona's own effort pin first. A manual effort choice stays with the draft through model, profile and persona changes and is remembered on refresh.

An existing conversation reopens on its committed model and effort. Old composer display values do not undo a later model switch. A confirmed model choice and its direct, compact or fresh mode stay in the draft through binding refreshes and are applied by the next submitted message; they do not switch the conversation before that message is accepted. A completed model switch remains completed after recovery and needs no retry.

## Task board

The task board is the optional official plugin `kiki-task-board`, requiring a host that supports plugin protocol `0.4.1` or later. [Install and enable the plugin](../customization/plugins.md), then open its workspace panel from **Capabilities → Extensions & tools → Plugins** and select a workspace. Its panel and the agent tools `plugin__kiki_task_board__BoardRead` and `plugin__kiki_task_board__BoardWrite` read and write the same cards.

If the plugin is missing, disabled, or uninstalled, conversations that used it still open and send ordinary messages. Historical `BoardRead` and `BoardWrite` calls and their recorded results remain unchanged. A new attempt to call an unavailable tool reports that it is missing; it does not invent a successful result or replay an old write.

Cards keep their original storage locations. `taskBoard.storage` `auto` reuses a compatible workspace store when it finds one and otherwise uses `sessions/<workspaceId>/.board`; `global` uses `boards` under the Kiki home; `fixed` uses an absolute path or one relative to the workspace. Changing that setting does not move old cards, and reading a card does not rewrite its file. Cards are requirements, separate from background tasks and per-agent todo lists.

Compaction does not automatically append linked cards; ask the agent to read them through the plugin when needed. Card status is never updated from todo lists or finished agent runs.

## Searching conversations

Use the sidebar search or `Ctrl-K` quick switcher to find conversations by title, workspace or message text. `Ctrl-F` searches within the conversation on screen. Message search includes user and assistant text by default; turn on **Include tool output** (the terminal icon in conversation find) to search saved tool results and Shell output too. Thinking blocks, tool names and tool inputs are excluded in both modes. Text you wrote in quotes or code remains searchable.

Changing **Include tool output** updates matches and counts without mixing pages from the other scope. Conversation find can load an earlier matching turn and open its folded output. In Messages view, a tool-output hit offers **View in process**, which opens and highlights the output while keeping your query. Original history remains available to read whether or not it is included in search.

The sidebar and quick switcher distinguish a failed or unavailable content search from no matches. Use **Retry** when offered; local title matches and your query stay in place.

## Starting and resuming sessions

On the **New session** page in the desktop app or browser you can pick an existing workspace, type an absolute project directory, or choose **Automatically create a workspace** (the default when nothing is registered yet). With the automatic option, your first send creates a directory under `$KIKI_HOME/workspaces/` (default: `~/.kiki/workspaces/`), registers it, and opens the session there. If you picked a workspace explicitly and it was deleted since, it stays invalid until you choose another one or switch to automatic — Kiki will not quietly open a different workspace. [Data locations](../configuration/data-locations.md#directory-layout) has the layout and what cleanup touches.

When one workspace is selected in the sidebar, **New session** uses that workspace. A failed workspace list is not an empty list: your draft and choices stay in place. Use **Retry**, explicitly choose automatic creation, or enter an absolute folder path.

In the workspace view, the title row of a real workspace shows a plus while you point at it, focus it, or use a touch screen. The plus starts a draft in that row's workspace, not the workspace of the conversation that is open, and it does not change the default workspace or fold the group. Pinned and ungrouped headings are not workspaces, so they have no plus. An unsaved editor still asks before the page changes, and a draft you already typed stays.

To use a [Profile Markdown file](../customization/agent-profiles.md) directly, open the execution menu beside the composer and choose **Use a profile file…**. Enter its path on the connected host, preview it, then choose **Use this profile**. Relative paths use the selected workspace or directory; automatic workspace creation requires an absolute path. A valid file does not need to appear in the main-profile menu, and selecting it does not register or copy it. If preview fails, keep the draft and retry or choose another profile.

Stopping creation keeps the draft and waits for the request's result; it does not undo a session already created on the server. Once creation is confirmed, send again with the same choices to reuse that session, or choose **Open created session** without sending.

If creation is unconfirmed, sending again with the same choices reuses the original creation request. You can also open that session to check it. With **Persist composer drafts** on, the draft and creation identity survive refresh; refreshing does not resend.

Opening a saved session reads its history without waking an inactive session's agents, and selecting a subagent reads that subagent's history without the main agent's conversation. The session activates when you send, edit or regenerate a message, answer an approval or question, or steer a prompt. If activation fails, nothing is sent and the history stays readable. Reading a session never stops work already running in it.

A subagent resumed with the same model reads **Resumed · continuing with…**, not **Switched to…**. Actual model changes, thinking-effort updates and context rebuilds keep their own labels.

The GUI opens with a small window of the latest messages. Scrolling up loads the next earlier page automatically; staying in the conversation does not load its entire history in the background. When earlier pages remain, **Load earlier messages** is available even if the current window has no visible messages. Loading status stays at the top of the history. If a page fails or loading reaches ten seconds, choose **Retry** to continue from the saved page boundary without losing loaded messages. This limit also applies when [Reading timeout](./settings.md#timeouts) is disabled.

Visible messages and expanded entries load the details they need. Jumping to an older message or returning to a saved reading position continues loading until that place is found; scrolling yourself cancels the old jump. Older message previews may be fetched again as you scroll to keep the reading cache small. Leaving the conversation cancels its pending reads, not the agent's work.

If only part of the message records has loaded, the bottom-right status area shows **More message records**, even when no loaded message is queued. Open it and choose **Continue loading** to read one more page; a failed read offers **Try again** without removing existing queue rows. The progress counts message records, including completed ones, not just messages waiting to send. An empty queue does not leave a blank bar above the composer.

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

A thread created by another thread nests under its creator by default. **Show at top level** in the row's menu lifts it into its own top-level row, and **Show nested** puts it back. This is display only — the creator relationship stays as it is, and the choice survives a refresh or restart in the same browser or desktop space. Sorting by recent activity uses the most recent activity anywhere in a thread's family, so work in a nested thread moves its parent forward even before the next list refresh; each row still shows its own last-message time, and a thread shown at top level keeps its own position and time group.

The same menu also offers **Copy thread link** and **Add to conversation**, which inserts a reference into the conversation you have open.

Archiving a thread also archives its attached conversations, including deeper descendants and conversations not loaded in the sidebar. A thread explicitly shown at top level, together with its descendants, stays independent when its ancestor is archived; archiving that top-level thread itself still includes its attached conversations. A filter or workspace group that merely displays a child as a top-level row does not make it independent. If only some conversations are archived, retry to finish the remaining ones. Restoring a thread restores only that thread, not every previously archived descendant.

Archive preserves history and keeps the worktree unless you select **Also remove its worktree** in the confirmation. If archiving is refused, the dialog shows the reason and keeps your choice for retry; the worktree is not removed. Resolve the reported issue before retrying. After a successful archive, worktree removal still keeps checkouts with uncommitted changes or unpushed commits.

Open **Settings → Sessions → Manage archived conversations** to browse saved archives by title, workspace and time. Search matches titles and workspaces across pages; opening a conversation reads its history without restoring it. Return to the archive manager to continue browsing.

**Delete** permanently removes that conversation and its still-attached archived descendants; explicitly top-level threads remain independent, and unarchived conversations are kept. **Delete all archived conversations** covers every archive in the current connection's home, across all pages and regardless of the search. Both actions ask for confirmation; cancelling leaves the data unchanged. Deletion cannot be undone. The page stays pending until the operation finishes, then refreshes the list. If some items fail, it lists those items rather than reporting complete success; check the refreshed list before retrying.


If opening or refreshing an existing conversation fails, the GUI stays on that conversation and keeps its loaded history and draft. The error appears above the history, with a request ID when available. Choose **Retry** to read the conversation again; a temporary read failure does not create a new session.

Editing a queued prompt's text or delivery timing through Kiki keeps its identity on recovery; you do not need to restore the original text or send a duplicate. Messages not yet launched stay pending when Kiki's backend shuts down normally. After recovery, review and resume the saved queue. Already launched messages are not automatically resent if their result is unknown; check the saved result before resending. Explicitly cancelled requests stay cancelled, including those cancelled by archiving or deleting the session.

A saved session can also retain a message for recovery before the agent accepts it. That save is not a started turn: the page says the server retained the message for recovery and it has not started yet. Resume a held or failed save with the same message instead of sending a new one. A temporary session, or one whose save state is still unknown, does not store that recovery copy and does not count as accepted.

If a completed turn cannot be saved because storage is temporarily unavailable, Kiki briefly retries saving the same result without running the turn again. A longer outage keeps the turn waiting for persistence; after storage is writable again, submitting the next prompt retries that save before continuing. A pending save is not confirmation that the result is on disk.

Resolved questions, approvals, markers and finished background tasks stay in the timeline as compact entries. Finished work can be grouped under **Worked**; expand it to see the individual entries. Expanding a question shows the full question and, for an answered one, the saved answer — dismissed and expired questions show their original choices too. Output from completed tasks stays in task history. File references can be previewed, opened or revealed in their folder; a preview is generated on demand, and the original file is still there to open or download.

Images in sent attachments and in tool results appear as soon as they scroll into view — you do not click to load them. Clicking one opens it full size, and a real failure offers a retry. The viewer keeps its own **Download**; there is no second download link under each image.

User messages show linked threads, attachments, quotations and notes as their own readable items, without generated prompt instructions in the bubble. Text you write yourself, including XML, code and blockquotes, stays visible. Older messages without recorded display metadata remain unchanged.

Click a file citation such as `src/example.ts:12:7` or `docs/example.md#L12-L20` in a message to open its tab at that source location. References in inline code and ordinary text are clickable too. Markdown line citations open **Source**; a link such as `[section](docs/example.md#heading)` opens the rendered heading. Inside a Markdown document, `#heading` stays in that document and relative links start from its directory. Reopening a citation reuses the tab and keeps unsaved edits. A missing or out-of-range target leaves the file open with a location notice.

Markdown previews otherwise open rendered. **Source** shows the text, and in the desktop app you can edit it there when a write channel is available. The rendered view handles tables, math, diagrams and images linked relative to the Markdown file. A file above roughly 512 KB starts as its opening portion and keeps loading the rest in the background; it stays read-only at that size, so use **Source** to read it but edit smaller files. If the background read fails, the view says so and offers a retry.

## GUI usage statistics

**Usage** opens on **Live**, showing model requests, running agents and concurrency rules without loading historical usage. Choose **History** for today in the browser's local time. Existing history, filter and session links still open their historical view; a range in the URL overrides today, and a saved all-history view does not replace it. The page keeps its date boundary correct across midnight and when the browser's timezone offset changes.

Start with the cost trend, then select a bar to see the consumption sources for that interval. Group sources by model, provider, agent profile, or workspace; selecting a source narrows that dimension while keeping the date range and other filters. Open its session records on demand and use the recorded turn's link to jump to the original conversation. Returning keeps your usage view. Records without turn attribution say so instead of offering a guessed location.

For a bounded date range, request the previous-period comparison when you need it. Missing prior data is shown as unavailable, not zero; a failed comparison leaves the current period readable. The collapsed live reference remains separate from the selected history.

When a scan has not finished, the page says so and shows only the counted subtotal; an unfinished empty total appears as a dash, not zero. Scans paused by a time or record limit resume automatically from saved progress. **Continue counting** also resumes that progress rather than starting a full rescan. Leaving History cancels its pending reads.

Token usage and estimated cost each carry their own completeness marker. If a provider returned no usage, Kiki shows that as unknown rather than as a real zero, and mixed results show the recorded subtotal with an incomplete-accounting notice. A missing model price affects the cost estimate only, never the recorded token count. **Data reliability** tells these cases apart from an empty range or a failed request.

In the main conversation, the context card's cumulative tokens and cost cover the whole session. In a subagent conversation, they cover that subagent only. The right panel's **This agent** view covers the selected agent alone, while **Whole tree** also includes its descendants. The context-window gauge is separate: it measures the current engine's occupied window, not cumulative billing tokens or a sum of agent windows.

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

If a summary response is empty or contains only thinking, Kiki retries the same input within the compaction attempt limit (three attempts by default). Filtered responses are not retried. The original context stays intact until a valid result is saved.

The timeline distinguishes **Manual compaction queued · waiting for a safe boundary** from **Compacting context…**. Once context is committed, a summarize run says **summary generated**, while a fresh-context run says **handoff retained**. Older records without an explicit mode say only **Context compacted**. Cancellation leaves context unchanged only before the new context is committed; a later cancellation request keeps the successful result. Failure, cancellation and an interrupted cold-session run do not count as successes. Consecutive successful commits of the same kind may share one divider labelled **3 successful compactions**, for example; expand it for each commit's time and recorded reasons. This count is not the number of generation retries.

The context meter under the composer shows the same numbers, lets you set the compaction point, and carries the renewal strategy: **summarize**, **fresh**, or **auto**. Fresh-context compaction does not call a summarizing model or delete session history. It replaces earlier model context with working notes, history pointers and a handoff, retaining user input and recent messages within their budgets. **Auto** is the built-in main-agent default: use a fresh context when the safety conditions are met, otherwise summarize. The timeline names the mode actually used. `/autocompact` shows or moves the compaction point from the terminal. Facts that must survive compression belong in [memory](./memory.md), which outlives the session.

Both renewal modes keep media in unanswered user input. Historical images, audio and video share a 20,000-token estimated allowance across retained input, the handoff and recent tool output; user-provided media takes priority over tool media. Compaction does not delete session history or saved attachments, so the agent can reread an earlier image when needed. This allowance uses Kiki's media estimate, not the provider's actual image-token count.

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

The export includes everything in the session directory, diagnostic logs included, plus the current home's global log at `<home>/logs/kimi-code.log` (default `~/.kiki/logs/kimi-code.log`; the name is inherited from the project's earlier naming). Add `--no-include-global-log` to leave that one out.

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
