# Built-in Tools

Built-in tools are the tool set provided by Kiki alongside its core engine — no MCP server installation required. The Agent automatically selects and calls these tools based on the task at hand during each conversation; users can inspect the details of each tool call through the approval interface.

Compared to MCP tools, built-in tools are managed directly by the runtime, their lifecycle is bound to the session, and no external process is required. Both follow the same unified approval mechanism: **read-only tools** (such as `Read`, `Grep`, `Glob`) are automatically allowed by default, while **execution tools** (such as `Bash`) require user approval by default. File writes follow the workspace trust model: in a trusted working directory, `Write` / `Edit` inside that directory run without per-file approval; external targets require approval. Sensitive targets are checked at their resolved location: manual and Auto modes ask for approval, while YOLO mode skips the prompt unless an explicit deny rule applies. Plan mode exit approval is not affected.

## File Tools

File tools handle reading, writing, and searching the local filesystem — the foundation for code analysis and modification tasks.

| Tool | Default Approval | Description |
| --- | --- | --- |
| `Read` | Auto-allow | Read a text file's contents |
| `Write` | Auto-allow inside a trusted workspace; blocked or approval outside | Create or overwrite a file |
| `Edit` | Auto-allow inside a trusted workspace; blocked or approval outside | Precise string replacement |
| `Grep` | Auto-allow | Full-text search powered by ripgrep |
| `Glob` | Auto-allow | Find files by glob pattern |
| `ReadMediaFile` | Auto-allow | Read an image or video file |

**`Read`** accepts a file path (`path`) plus optional `line_offset` (starting line number; negative values count from the end) and `n_lines` (maximum number of lines to read). Returns at most 1000 lines or 100 KB per call; content beyond that limit comes with a truncation notice. UTF-8 and UTF-16 text are supported, with UTF-16 converted for display. If the file is an image or video, the tool suggests using `ReadMediaFile` instead.

The result shows line numbers and reports the original line endings. A pure CRLF file appears as LF in `Read`, and `Edit` preserves CRLF when you edit that view; a file with mixed line endings needs the visible `\r` characters matched exactly.

An explicit absolute path can read outside the workspace, subject to sensitive-file approval. Registered user Skill and agent definition roots (including linked installations) are readable by default, while an ordinary workspace link to an external file requires approval. Under `~/.kiki`, only `agents`, `skills`, `commands`, and `docs` count as definition or documentation roots; other paths there still need an explicit path and remain subject to the sensitive-file rules.

**`Write`** accepts `path`, `content`, and an optional `mode` (`overwrite` or `append`; defaults to overwrite). Missing parent directories are created automatically; `append` mode appends content to the end of the file without automatically adding a newline.

**`Edit`** accepts `path`, `old_string` (the exact text to replace), and `new_string` (the replacement text). By default it replaces only one unique match; if the same content appears multiple times in the file, the tool returns an error and suggests using `replace_all: true`. `old_string` and `new_string` must not be identical. `Write` and `Edit` resolve links before approval: a link in a skill directory does not grant permission to write its target. If a target changes between approval and execution, retry the call after reviewing the new target.

**`Grep`** invokes ripgrep to search file contents, supporting regular expressions (`pattern`), a search path (`path`), file type filtering (`type`, e.g., `ts`, `py`), glob filtering (`glob`), and output mode (`output_mode`: `files_with_matches` / `content` / `count_matches`; defaults to `files_with_matches`). `content` mode supports context lines (`-A`, `-B`, `-C`), case-insensitive matching (`-i`), line numbers (`-n`, default true), and multiline matching (`multiline`). All modes support `offset` + `head_limit` pagination; `head_limit` defaults to 250 and `0` means unlimited. Sensitive files such as `.env` files and private keys are automatically filtered out; set `include_ignored=true` to search files ignored by `.gitignore`, though sensitive files remain filtered.

**`Glob`** matches files in a specified directory (`path`; defaults to the working directory) by glob pattern (`pattern`). Results are sorted by modification time in descending order, returning 100 entries by default. It respects `.gitignore`, `.ignore`, and `.rgignore` by default; set `include_ignored=true` to include ignored files such as build outputs, while sensitive files remain filtered. Brace patterns such as `*.{ts,tsx}` are supported, and broad wildcard patterns are allowed.

Use `offset` (default 0) and `head_limit` (default 100) to page through matching paths; the result provides the next offset when more matches are available. Set `head_limit: 0` to remove the match-count limit. The character limit still applies: pages end at a complete path and provide the next offset when necessary. Large pages are saved to a file that the agent can read with `Read`. Each call searches the current filesystem again, so file changes can shift results between pages. Timeouts, unreadable directories, or the output capture limit can still leave the search incomplete; the result warns about these cases, and increasing the offset cannot recover uncollected paths.

**`ReadMediaFile`** sends an image or video to the model as multimodal content. It accepts `path`, plus optional image-detail controls such as `region` and `full_resolution`; the file size limit is 100 MB. Default image reads are compressed to the configured model limits. If automatic compression cannot meet those limits safely, the tool returns an error without sending the original image and directs the model to create and read a smaller copy. Availability depends on the current model's vision capabilities (`image_in` / `video_in`).

## Shell

| Tool | Default Approval | Description |
| --- | --- | --- |
| `Bash` | Requires approval | Execute a shell command |

**`Bash`** is the most permission-demanding tool and also the most general-purpose. Its argument patterns and compound-command checks are described in [permission rules](../configuration/config-files.md#permission); use `kiki permission test 'Bash(...)'` to inspect a rule without executing the command. Parameters:

- `command` (required): the shell command to execute
- `cwd`: working directory. With a local runtime and the agent's effective permission mode set to YOLO, an explicit absolute path may be outside the workspace. This does not bypass agent permission ceilings or actual remote/container isolation; manual/auto modes and relative traversal retain their workspace boundaries.
- `timeout`: timeout in milliseconds; foreground default is 60 seconds, maximum is 5 minutes
- `run_in_background`: whether to run as a background task; background tasks default to a 10-minute timeout (no timeout by default in print mode `kiki -p`)
- `description`: background task description; required when `run_in_background=true`
- `disable_timeout`: whether to remove the timeout limit for background tasks

When a command is only a file read, search, or text-file write, `Bash` still runs it but may append a one-line hint pointing to `Read`, `Grep`/`Glob`, or `Write`/`Edit`. Each hint category appears at most three times per session. Set `bash_file_tool_hints = false` under [`[background]`](../configuration/config-files.md#background) to suppress these hints; execution and approval behavior are unchanged.

**Foreground** mode blocks the current turn until the command completes or times out, and the TUI streams stdout and stderr into the running `Bash` tool card while the command is still active. **Background** mode returns a task ID immediately and automatically notifies the Agent when the task finishes.

A foreground command that hits its timeout is not killed by default: it keeps running as a background task, with a fresh copy of the 600s background budget. Set [`bash_auto_background_on_timeout`](../configuration/config-files.md#background) to `false` under `[background]` to kill timed-out foreground commands instead, and change the background budget itself with [`bash_task_timeout_s`](../configuration/config-files.md#background) (`0` = no timeout; print mode defaults to no timeout).

stdin is always closed, so an interactive command receives EOF immediately. A stopped or timed-out task is terminated with SIGTERM, then SIGKILL after the 5-second grace period. On Windows, Git Bash is used by default.

## Dynamic tools

MCP and plugin tools are announced by name and a short description. Use `SelectTools` with an announced name; its schema reaches the model on the next step. Ordinary tools already in the tool list need no selection. On Kimi providers selected schemas travel in message-level tool declarations; on OpenAI chat, OpenAI Responses, and Anthropic providers they travel in system text, with `CallTool` available as a stable bridge while deferred tools are active. The model can also call an already-loaded tool directly by its real name. Approval, access checks, and the UI tool card use that real name. The `tool-select` flag is enabled by default for these providers when the model supports tool calling; `dynamically_loaded_tools` does not need to be declared. Turning the flag off restores inline tool availability.

If no deferred MCP or plugin tools are active, neither `SelectTools` nor `CallTool` appears in the tool list. While at least one deferred tool remains active, reconnects and plugin changes update the announcement without changing the top-level tool list. A profile-directory change is likewise announced on the next user turn only when an agent gains, loses, or changes a profile it can actually dispatch. Explicit user changes to tool-group, MCP-server, or memory settings are applied with the next user message and may change the top-level tool list.

## History tools

`HistorySearch`, `HistoryRead`, and `HistoryList` are resident built-in tools in the `history` group. When enabled, they are included directly in the tool list and can be called without `SelectTools`. They read transcript history under the existing workspace access policy; a source `ref` identifies evidence, not a permission grant.

`HistorySearch({"query":"distinctive words"})` searches the current session and current agent with `mode: "auto"` (complete phrase matching). Every result echoes `scope_used`, `mode_used`, and `target` — read them instead of assuming a default. To search the way earlier Kiki versions did, pass `{"scope":"workspace","mode":"terms"}`; `scope: "this_session"` remains a locked-current-session alias, and another `session_id` selects a known older session.

When a session-scoped page has fewer hits than its limit, `expand_hint.next_call` gives you a ready-to-use `scope: "workspace"` retry; for `auto` / `all` / `any` it explicitly switches to indexed `mode: "terms"` (token-AND), and the response echoes that changed matching mode. Name an `agent_id` or set `include_subagents` to widen the agent range. Check `coverage` and `next_cursor`: a partial empty page means the scanned or indexed domain is incomplete. A scan cursor resumes a bounded segment, and if it has expired, restart the original query.

For server transcript fallback, `sort: "newest"` and `"oldest"` order matching text by timestamp, with stable source-ID ties across pages; missing timestamps sort as zero. Navigation first prepares the current visibility through a fixed source watermark, so a cold large session may return empty `navigation_building` preparation pages before any hits. Continue with `next_cursor`; preparation and text reads share the same per-call budget. Once navigation is ready, newest-first search reads recent text spans directly rather than scanning the wire prefix.

The default `sort: "relevance"` ranks lexical match scores only among the hits collected on the current bounded page: full-query matches and additional matching clauses raise the score, then newer timestamps and stable IDs break ties. Pages are scanned newest-first, not globally ordered by relevance; a later page may contain a stronger match. Partial pages disclose `page_local_relevance` in coverage.

A new scan cursor pins the historical range this query started over. Normal appends to the source still allow paging, but the newly added content is not in this result set — re-run the query to see it. If the pinned source content changes, the query conditions change, or the shared navigation advances past this range, restart the query as the response instructs. Older scan cursors continue to read under their original compatibility rules.

Normal appends during a transcript search do not require the writer to stop: the read finishes over its captured range, not the latest content. `HistorySearch` returns `source_changed` if that range changes or the source is replaced or truncated; follow `error.next_call` to restart without a cursor. A cursor that no longer matches its source, shared navigation, or query likewise requires a fresh query. Neither error reuses an old location against different content.

Calls that omit the newer scope and mode arguments use the current session and `auto` matching. Read `scope_used` and `mode_used` in the response rather than assuming a historical default; when the result is too narrow, follow `expand_hint.next_call` and retry with `scope: "workspace"`.

Use `HistoryList` to browse short turn excerpts or archived agents when you lack search words. A turn entry's `ref` opens the whole turn as source blocks with `HistoryRead`; `turn` and `step_id` also select bounded turn/step blocks. While the navigation directory is still being built, the response is a `partial` preparation page that reports the scanned portion and carries a cursor — continue with it instead of assuming the list is complete. Use `HistoryRead({"step_id":"t42.3"})` for a known step. For a Search hit on a text block, `HistoryRead({"ref":"<hit.ref>"})` starts near the match. Each block includes its own `ref` and UTF-16 `range`; continue with `cursor`, or reopen a block with its `ref` and `start_char` set to the previous `range.end` if the cursor expires. A stale or removed source returns an error instead of another turn's content. Existing v1 Read cursors continue their legacy JSON paging; restart with a ref, turn, or step_id for blocks.

`HistoryRead` reports a normal `partial` read with the blocks it scanned and a cursor to continue. `no_match` means the scan finished and the selector has nothing there. `source_pending` means the persisted transcript ends in an unfinished record, so the lookup cannot yet say whether the selector matches; retry it once the writer settles. When the navigation directory is still being prepared, the same `partial` status comes back with a preparation cursor and progress, and an empty block list there means not scanned yet, not absent — continue with that cursor before reading it as `no_match`. If the agent's persisted transcript is unavailable altogether, the error points you at `HistoryList` with `kind: "agents"` to check the agent id. A source that has changed returns an error rather than another turn's content.

To search only cross-thread messages, use `HistorySearch({"query":"handoff","scope":"peer"})`. It searches both directions within the current workspace, or the explicitly approved `workspace_id`; an optional `session_id` narrows to one session. Peer search reuses the lexical matching modes but is newest-first, so omit `sort` or use `"newest"`. It excludes subagents and ordinary user input, does not accept `source: "transcript"`, and accepts only `agent_id: "main"`.

The response has `source: "mailbox"`; hits carry `communication` metadata with message identity, endpoints, and delivery state. Use the [communication-history REST read](../server/rest-api.md#communication-history) for the full message and navigation identity. Continue a partial or empty page using `next_cursor`; the view covers retained mailbox records, not older messages already evicted by previous versions.

In non-interactive prompt runs (`kiki -p`), `HistoryList` reads a bounded prefix of the persisted transcript without starting a server or search worker: at most 2 MiB, 10,000 records and 256 KiB per record; agent rosters inspect at most 256 directory entries. Results explicitly report `partial` coverage and do not contain navigation `ref` values. You can list the current session or specify another persisted `session_id`. `HistorySearch` and `HistoryRead` remain unavailable in this print host; use an interactive session or the server for indexed search and full history reads.

## Web Tools

Both web tools are backed by Kiki's built-in search and retrieval module, which ships with the product — there is nothing to install. General-web search and URL fetching work without configuration or an API key. See [`nb_search`](../configuration/config-files.md#nb-search) for configuration.

| Tool | Default Approval | Description |
| --- | --- | --- |
| `WebSearch` | Auto-allow | Web search |
| `FetchURL` | Auto-allow | Fetch the content of a specified URL |

### `WebSearch`

Search the web through Kiki's built-in search and retrieval module (`nb-search`). The minimal call is `{ "query": "search terms" }`, which selects `action: "run"` and lets everything else fall back to your `[nb_search]` defaults. `query` may be a single string or an array of strings.

Without configuration, this call uses `duckduckgo.search` for general-web results, with no registration, API key or lane selection. The public HTML endpoint may issue a challenge or rate limit; wait before retrying, or explicitly choose another configured source. These failures are errors, not empty results. Choose `github.repositories` for repository search or `context7.docs` for library documentation (a typed result). If the default lane is explicitly removed, the tool still fails closed unless a `lane`, `lanes`, or `preset` is named. Explicit selections override the default and never silently switch providers when invalid or unavailable.

`run` accepts these parameter groups that actually change behavior:

- `lane`, `lanes`, `preset` — mutually exclusive; pick exactly one. Use `lanes` or `preset` to combine ranked sources; a typed result requires a single `lane`.
- `freshness`, `max_results` — content filtering.
- `timeout_ms` — per-call deadline.
- `execution`, `idempotency_key` — see the async section below.

Results are either ranked source links with snippets or typed research or documentation answers. Provider output is not independent verification — cite the actual URLs inline and use `FetchURL` when you need primary-source full text.

With multiple provider keys, synchronous `WebSearch` and `FetchURL` calls on the same server share key rotation and cooldown across calls and sessions; detached async jobs start independent schedulers. See [`nb_search`](../configuration/config-files.md#nb-search) for the key format, settings, and existing single-key compatibility.

```json
{ "query": "kimi-code release notes" }
```

```json
{ "query": "kimi-code architecture", "lane": "<your-configured-lane>", "execution": "sync" }
```

### `FetchURL`

Fetch or extract content from a URL through Kiki's built-in search and retrieval module (`nb-search`). `direct.fetch` retrieves a given URL; it is not a `WebSearch` search lane. The minimal call is `{ "url": "https://example.com" }`, the URL shorthand for `action: "run"`; do not mix shorthand `url` with the `source` form. The keyless URL default tries `direct.fetch` first, then `jina.reader` for extraction if direct fails. A successful but unusable direct response requires explicit quality rules to trigger fallback. The chain returns Markdown; HTML responses are extracted to body text, and plain text or Markdown pages are passed through.

`run` accepts these parameter groups that actually change behavior:

- `source` — `kind: "url"` for a remote page, `kind: "inline_text"` or `kind: "inline_bytes"` for content already in the call, or `kind: "file"` for a path inside a configured file scope.
- `pipeline`, `representation` — override the default fetch chain.
- `timeout_ms`, `max_content_chars` — bounds.
- `execution`, `idempotency_key` — see the async section below.

The tool reports the fetch outcome and any content truncation. Structured results distinguish the operation status from document metadata; minimal calls provide readable notices. When citing truncated or partial results, state that the content is incomplete and link the actual source URL.

The URL shorthand accepts the same options as the `source` form. Inline and file content cannot be sent through egress pipelines; unsupported source/pipeline/mode combinations return an error rather than a silent substitution.

```json
{ "url": "https://example.com/docs" }
```

```json
{ "action": "run", "source": { "kind": "url", "url": "https://example.com/long" }, "execution": "async", "idempotency_key": "fetch-long-1" }
```

#### Async runs and job-id operations

Both tools share the same execution model:

- Execution defaults to **sync**. Pass `execution: "async"` together with `idempotency_key` to start a background job; sync calls must not include `idempotency_key`.
- An async call returns a job receipt — not a Kiki background task. Pass the same `idempotency_key` to retry the same submission.
- Use the same tool with `action: "get"`, `"read"`, or `"cancel"` and the `job_id` to follow up on a job.
- `read` returns the job's artifact chunks as `data_base64` with byte offsets and optional `page_size` / cursor pagination / `next_cursor`. These chunks are not plain-text page content; decode them with the encoding the schema reports.
- Honor `poll_after_ms` rather than busy-polling. A completed job can still contain a partial operation result.

#### `FetchURL` file sources

`source.kind: "file"` requires a configured scope in `[nb_search.fetch.file_scopes]`, a path relative to that scope, and Kiki filesystem/path admission. Admission binds the canonical path and the file-object identity at call time; execution reads the same identity, so in-place updates made to the file are visible. Atomic replacement or any change to the file object is rejected — submit a new tool call for fresh approval rather than retrying the old job. Filesystems that cannot supply a usable file identity report an error. A configured scope does not grant arbitrary host-file access or bypass sensitive-file protection.

```json
{ "action": "run", "source": { "kind": "file", "scope": "<your-file-scope>", "path": "design/notes.md" } }
```

## Browser Tools

Browser tools appear only when the `native_browser` experimental flag is on, and they drive saved connections through the managed agent-browser backend on the Kiki server. See [Browser control](../guides/settings.md#browser-control) for the settings page and what each connection style targets.

**`BrowserConnections`** works on the connection itself: `action: "list"` (the default) returns the saved connections and the new-session default, `"select"` binds the connection this agent will use, `"status"` and `"check"` read runtime state, `"connect"` and `"disconnect"` start or attach and release it, and `"tools"` loads the backend's page operations on demand. A connection is named by its saved id; a display name is never resolved to an id. Omitting `browser` uses this agent's bound connection or the new-session default — never a guessed or merely ready browser.

`"tools"` registers only the groups or tool names you ask for. Each loaded operation becomes a tool named `browser__agent_browser_<name>`, keeps the backend's own schema, and additionally takes `browser` and `browserTab`. Element references from a snapshot are valid only in the browser, tab and frame that produced them, so read a new snapshot after the page changes. Browser installation, plugin, and cross-session administration operations are not offered as page tools.

**`BrowserTabs`** manages the target inside one connection: `list`, `open`, `window`, `select`, `close`, and `frame` (`main` returns to the top frame). Targets are the backend's CDP target IDs, not tab positions or labels, and these tools never follow the user's foreground tab. After changing tab or frame, or reconnecting, element references need a fresh snapshot.

Results carry the resolved connection, runtime session, tab and frame. An artifact Kiki named for the call — a screenshot, HAR, trace, profiler output or recording — is attached to the timeline up to 20 MiB; a larger file stays on the execution host and has to be retrieved over the existing file channel. A timeout does not confirm the action: observe the same target again before repeating it.

Cancelling a tool call stops the browser work when the cancellation lands before the action is sent — while the call is still queued, and again after the target is found but before the action goes out. A cancelled call that was never sent does not disturb the connection, and it does not close a browser that other work is using. Once an action has been sent, cancellation does not take it back: the call keeps running to completion, its result still applies, and Kiki does not replay or retry it for you. Read the outcome instead of assuming the cancel reversed it.

## Plan Mode

| Tool | Default Approval | Description |
| --- | --- | --- |
| `EnterPlanMode` | Auto-allow | Enter Plan mode |
| `ExitPlanMode` | Auto-allow (requires user to confirm the plan) | Exit Plan mode and submit the plan |

Plan mode restricts `Write` and `Edit` to the current plan file. It also blocks `BoardWrite`, `TaskStop`, `Cron` actions `create` and `delete`, `AgentSend`, and resuming existing children with `AgentRun` (see [State Management](#state-management) for `BoardWrite`). `EnterPlanMode` and `ExitPlanMode` are resident built-in tools and remain available while their normal policy checks allow them.

New `AgentRun` calls can start research subagents using the native executor. These children can use only the built-in `Read`, `ReadMediaFile`, `Glob`, `Grep`, `WebSearch`, and `FetchURL` tools permitted by their profile and existing policies. They cannot run `Bash`, invoke MCP or user-defined tools, or delegate further work. External executors are not available for these calls. The research restriction survives Plan mode exit and session restoration; create a new child after leaving Plan mode when implementation needs write access.

The parent Agent's `Bash` calls still follow the current permission rules. Entering Plan mode does not stop previously started background work and is not a system-level sandbox.

**`EnterPlanMode`** accepts no parameters; upon success it returns workflow guidance and the plan file path.

**`ExitPlanMode`** reads the current plan file, presents the plan to the user for approval, then exits Plan mode. The optional `options` parameter lets the Agent offer 1–3 alternative approaches (each with a `label` and `description`; `label` max 80 characters) for the user to choose from during approval. Labels must be unique and cannot use reserved words such as `Approve`, `Reject`, `Reject and Exit`, or `Revise`.

## State Management

| Tool | Default Approval | Description |
| --- | --- | --- |
| `TodoList` | Auto-allow | Manage a task to-do list |
| `BoardRead` | Auto-allow | Read persistent requirement cards on the workspace task board |
| `BoardWrite` | Requires approval | Create or update a persistent requirement card on the workspace task board |

**`TodoList`** manages the calling agent's execution list and working notes as two independent update domains. Omit `todos` to leave the list unchanged; omit `notes` to leave all notes unchanged. Call with `{}` to read both. The `todos` array is a complete replacement: each item has a `title` and `status` (`pending` / `in_progress` / `done`), and `todos: []` clears only the list.

`notes` accepts only the changed sections: `goal`, `directives`, `decided`, `rejected`, `evidence`, `files`, `next`, and `open`. Each supplied string replaces its entire section, so include its still-valid conditions and exceptions. Omitted sections remain unchanged; `""` deletes one section, `notes: null` clears all notes, and `notes: {}` changes no content. Each section is limited to 1,500 characters and the whole notebook to 7,500; an over-limit mixed call changes neither domain. Writes return a compact receipt with changed and cleared fields, revision, character counts, and todo status counts, not the full notebook. Use `{}` when you need the current contents.

Main and child agents have separate lists and notes; the tool cannot read or update another agent's state. Both are restored with their owning agent and follow conversation undo, and context renewal preserves existing notes. `review_handoff: true` explicitly acknowledges that the handoff and human input have been checked against current notes and original sources; an ordinary section update does not acknowledge that review. Oversized candidates stay complete in the handoff with a visible notice, and unreviewed input is carried forward. Historical shared lists remain with the main agent.

The task board is the persistent record of requirements that survives sessions. `BoardRead` supports `preview`, `list`, `show`, and `overview` for cards in the current workspace or other authorized workspaces. `BoardWrite` `create` always starts at `active`, so do not pass `status`; for `update`, include `status` only when changing the state. Valid states are `active`, `in_progress`, `paused`, `done`, `cancelled`, and `superseded`. `done`, `cancelled`, and `superseded` are terminal; reopen a terminal card by setting `status` back to `active`, `in_progress`, or `paused`, which clears its `completedAt`. Updates must use the card's current `revision`; after a conflict, reread the card before retrying.

Cards are persistent requirements, not agent runs or the per-agent `TodoList`. Reading a card does not change it, each agent keeps an independent `TodoList`, and marking every todo `done` does not update the card. Both tools are provided to the main agent by default and gated by the `task_board` experimental flag. Native subagents are denied both tools by default; explicitly allow either tool through its profile's `tools` list or [`subagent.allowed_tools`](../configuration/config-files.md#subagent), without bypassing other tool restrictions. `BoardRead` remains available in Plan mode; `BoardWrite` is rejected before approval (see [Plan Mode](#plan-mode)). Card writes follow the ordinary permission policy and do not require additional workspace trust.

In Settings → Tasks, choose `auto`, `global`, or `fixed` storage. A fixed location can be an absolute path or a path relative to the workspace; scripts are not executed. The task board is built in — no separate installation is needed. In `auto`, Kiki reuses existing compatible project storage when available and otherwise uses the session data area.

## Memory Tools

Memory stores what a session does not keep. Agents save durable facts with `MemoryWrite` and read them back with `MemorySearch` and `MemoryRead`, across three scopes: Global, one Workspace, or one Persona. Search accepts partial term matches, including Chinese phrases without spaces. Native subagents get the read-only `MemorySearch` and `MemoryRead` by default; `MemoryWrite` stays main-only and cannot be opened to a subagent by an allowlist.

When a proposed update or archive is held for review, the original entry keeps its current content and stays in effect until you decide. Accepting the proposal applies the update or archive to that original entry; discarding it removes only the proposal and leaves the original untouched. If the original entry has changed since the proposal was made, the decision is refused, the proposal is kept, and you are asked to read the entry again.

### Writing an entry

`MemoryWrite` takes one `action` per call:

- **`create`** — a genuinely new subject. Requires `type`, `title`, `body` and `reason`; omits `id` and `expected_revision`. Without an explicit `scope` it lands in the bound persona, otherwise the workspace.
- **`update`** — revise the entry in place, keeping its id and the conditions that still hold. `body` is the complete new content, not a patch.
- **`supersede`** — write a replacement with its own id and retire the predecessor only once the replacement is active. This is the right choice for a rule that genuinely changed, and it keeps both versions readable.
- **`archive`** — retire an entry, preserving its stored content. Send only the target and `reason`; the type, title and body fields are ignored.

`update`, `supersede` and `archive` need `id` **and** `expected_revision` — the revision from a read result, a search item, or an earlier receipt. Without it the call is refused rather than applied to a version you have not seen. The same id can exist in more than one visible scope; an explicit `scope` limits the lookup, and an omitted one must resolve to exactly one target or the call reports the candidates instead of choosing.

Two optional fields record what the content is resting on, and both are omitted or preserved rather than defaulted:

- **`basis`** — `{ kind, note, refs? }` where `kind` is `human`, `observed`, `derived` or `unknown`. It records the evidence for the content, separately from the writer that the system records automatically; a write that runs in your turn is not automatically attributed to you. Omitting it on an `update` keeps the current basis only if the type, title and body are unchanged. Rewrite any of those without supplying a new basis and the entry is downgraded to `{ kind: 'unknown' }` with a `content changed without refreshed attribution` warning, so a stale attribution cannot survive the text it described.
- **`validity`** — `{ check, until? }`, for content that changes. Omitting it on an `update` keeps the existing value; sending `null` clears it deliberately. A missing `validity` does not mean the content is permanently true.

`covered_by` applies to `archive` only, and takes `{ id, expected_revision }` of a retained active entry in the same scope whose content fully covers the target's. The dependency is re-checked inside the write when the retirement is applied, so retiring an entry against a replacement that has since changed fails with `covered_target_changed` instead of losing the rule.

A successful call returns the full stored (or proposed) entry together with an `outcome`:

| Outcome | What it means |
| --- | --- |
| `applied` | The write took effect. The returned entry is the current read — do not re-read it just to confirm. |
| `pending` | The write is a proposal awaiting your decision. The entry it targets is unchanged and still in effect. |
| `unchanged` | Nothing in the submitted write differed from what is stored. No new revision and nothing to undo were created. |

`operation_id` is `null` for `unchanged`, and for a repeated identical pending request, which is how a duplicate proposal is recognized rather than stacked.

Failures come back as structured errors with a `code`, a message and recovery guidance — `missing_revision`, `revision_conflict`, `not_found`, `ambiguous_target`, `scope_mismatch`, `covered_target_changed`, `duplicate_title` and others. The intended response is to follow the recovery, re-read if needed, and make one corrected attempt; creating a second entry to get around a refused write is what these codes exist to prevent. A target you cannot see is reported as unavailable rather than written on someone else's behalf.

### Searching and reading

`MemorySearch` takes `mode: "search"` (the default, requires `query`) or `mode: "list"` (no query, browses the inventory). `page_size` is 1–20 and defaults to 8 for search and 20 for list; continue with `cursor` alone, and changing any filter invalidates it. Each item carries the full title, type, status, revision, owning scope, a `target` whose fields can be copied straight into `MemoryWrite`, `basis_kind` and an `applicability` of `expired`, `recheck` or `unrecorded`. The response's `coverage` states which scopes and statuses were inspected and whether anything was skipped. Continue empty preparation pages while `exhausted` is false; scan budgets do not cut off the remaining source. Search ranking is local to each bounded source chunk. Search also returns a `snippet` of at most 200 characters and a `score`; list returns neither. A snippet omits conditions, so read before you rely on, merge, or replace an entry.

`MemoryRead` takes exactly one of `id` or `ids` (up to 10), reads active, archived and replaced entries by default, and includes pending proposals only with `include_pending: true`. The result is the complete entry — not a summary — with its owning scope, target fields and applicability, so a read can be the source for an `update`.

For the three-scope model, the review inbox, the undoable change history, and the `/memory` page, see [Memory](../guides/memory.md). For the same data over HTTP, see [Server API](../server/rest-api.md#memory).

## Collaboration Tools

Main agents receive five thread tools by default: `ThreadCreate`, `ThreadList`, `ThreadRead`, `ThreadSend`, and `ThreadWait`. `ThreadCreate` opens an independent top-level session; the other four address existing sessions through `host_id`, `workspace_id`, and `session_id`. `ThreadSend` stays main-only, but a subagent profile can opt in to `ThreadCreate`, `ThreadList`, `ThreadRead`, and `ThreadWait` (see [`subagent`](../configuration/config-files.md#subagent)).

Omitting `host_id`, leaving it empty, or using `"local"` addresses the executing agent's home, not the space currently open in the GUI. Same-home communication can cross workspaces. Another local or remote space requires an owner-approved one-way [thread bridge](./command.md#kiki-bridges); use its returned host-qualified reference and `bridge_id` or `connection_id`. Identical session IDs in different homes remain different threads. GUI browsing permission does not grant bridge permission.

- `ThreadCreate` is for an explicit user request to create a new thread or session, not for routine delegation. Optional `cwd` must be an absolute path to an existing directory, including one outside the current workspace; omitted `cwd` uses the current session's workspace root. Optional `profile` must name an enabled main-agent profile; omitted `profile` uses the default. Optional `prompt` (at most 100,000 characters) becomes the new thread's first user message and starts its turn immediately; without it, the thread stays empty until the user sends a message. Optional `title` overrides the default: with a prompt and no title, the first line (up to 80 characters) becomes the title. The result returns `id`, `title`, `cwd`, `profile`, and `prompt_started`; the thread then appears in the left session list within a few seconds, and `ThreadSend` and `ThreadWait` continue the conversation.
- `ThreadList` lists enabled, unarchived sessions, optionally filtered by `workspace_id`. With no bridge selector it lists the executing home; with a selector it lists only the approved target scope and requires `read`. Local results are newest first. `limit` defaults to 50 and accepts 1–100; use the returned opaque cursor for another page.
- `ThreadRead` reads completed main-agent turns locally without resuming a cold session. Across a bridge it requires `read` and returns a bounded `view.transcript` page with coverage and cursors; omitted text or frames carry `contentRefs`. Pass a returned reference as `content_ref` to read its next bounded `view.segment`. `limit` defaults to 20 and accepts 1–100.
- `ThreadSend` durably saves an explicit message and records the executing main-agent session as its verified source. Supply the target, non-empty `content` of at most 100,000 characters, and `idempotency_key` of at most 256 characters. There is no source parameter; reuse a key only for the same message. A bridge needs `send`, plus `wake` to deliver into a model prompt or resume a cold thread; without wake it stays pending. `delivered` confirms prompt delivery, not a reply. Pending records retry with the original key for up to 15 minutes; use bridge receipts to inspect rejection reasons. Ordinary assistant text is never forwarded automatically.
- `ThreadSend({ room, content, mentions? })` posts to a room the current thread belongs to. Room content is limited to 20,000 characters; mentions use thread session IDs or persona IDs, and the retry key defaults to the tool call ID. Only explicit room sends enter the log, never ordinary assistant text. Room `delivered` means logged, not that all members have answered; thread members queue while busy by default.
- `ThreadWait` waits for terminal, attention, lifecycle, or undeliverable-message activity on 1–8 distinct local or approved bridge threads. Bridge waits require `wait`; they do not wake the target. `timeout_ms` defaults to 30,000 and accepts 0–60,000; `0` checks once. Carry each returned cursor into the next call, and cancel the tool call to stop waiting.

`ThreadCreate` is enabled by default and has its own setting under Settings → Permissions → Tools, so it can be disabled without disabling the other thread tools. Peer communication is controlled by [`[thread_communication] enabled`](../configuration/config-files.md#thread-communication) and persisted workspace overrides. Bridge receiving is separately off by default and must be approved by the target owner; disabling either target communication or inbound access stops bridge delivery without deleting sessions.

Only `ThreadSend`, called by the source thread's main Agent, records peer attribution; REST and Klient sends are target-only user-origin input. See [Agents and Sub-Agents](../customization/agents.md#peer-thread-communication).

On Kiki desktop and the `kiki` CLI/TUI, the main `agent` profile always receives `AgentRun`, `AgentList`, and `AgentSend`. These tools address only the caller's direct children — by the optional `name` passed to `AgentRun`, or by agent id. They are not behind an experiment. The built-in [`coder` and `explore` profiles](../customization/agents.md) do not receive them.

`AgentList` returns those direct children and never lists grandchildren. `AgentSend` queues a mailbox message for a direct child, and what happens to it depends on the child's state — the `AgentSend` entry further down this page has the detail.
Collaboration tools handle inter-Agent coordination, user interaction, and Skill invocation.

| Tool | Default Approval | Description |
| --- | --- | --- |
| `AgentRun` | Auto-allow | Spawn a sub-Agent to execute a subtask, or continue a direct child |
| `AgentList` | Auto-allow | List the caller's direct child agents |
| `AgentSend` | Auto-allow | Deliver a mailbox message to a direct child as early as possible; steered into an active turn while running |
| `AskUserQuestion` | Auto-allow | Ask the user a question to gather structured input |
| `Skill` | Auto-allow | Invoke a registered inline Skill |

**`AgentRun`** delegates a subtask to a sub-Agent. Required parameters are `prompt` and `description` (a short 3-5 word task description for UI display).

| Parameter | Effect |
| --- | --- |
| `profile` | Which agent profile runs the subtask. Omitted, an explicitly configured `[subagent].default_profile` selects it; with no such key, the built-in general-purpose subagent prompt is used; an explicit blank value requires a target |
| `profile_file` | A role Markdown file, absolute or workspace-relative. It is a role definition rather than a shared prompt template, and is mutually exclusive with `profile`, `route`, and `resume` |
| `background` | Omitted: background for a main-agent call, foreground for a subagent call. An explicit `false` waits synchronously |
| `name` | A session-unique handle of lowercase letters, digits, and underscores; `root` is reserved |
| `route` | A profile route to run instead of a named profile |
| `model_alias` | The model the child uses. See [model selection](./model-vocabulary.md#binding-rules) for the full resolution order |
| `effort` | Thinking effort for this child |
| `allow_model_change` | Required on `resume` to switch an existing child to a different model |
| `tools` | Replaces the resolved tool selection for this binding only. A lone `*`, or `["*", ThreadRead]`, keeps the ordinary tools and adds that opt-in; a finite list stays finite |
| `disallowed_tools` | Adds a call-level deny. `[]` clears only that layer, never a profile, ancestor, or route deny |

Omit both `tools` and `disallowed_tools` and a new child uses the configured default, while a `resume` keeps its saved overrides. Both parameters need the native executor; an external executor that does not support them fails before the child starts.

**Model and effort.** A new spawn picks its model in this order: the `model_alias` parameter → the pin on the effective profile, route, or caller lease → an explicitly configured `[subagent].default_model`. With none of these sources the call fails with `model.not_configured` and no child is created — the caller's model and the main-agent `default_model` are not silent fallbacks. `AgentRun` rejects `model_alias: "inherit"`, so pass a concrete configured model name or omit the parameter; a subagent profile, route, or caller lease can still set `model_alias: inherit` to follow the caller. Thinking effort otherwise resolves through the tool `effort` → the route's locked effort, or the caller lease's when the route pins none → a matching `model_profiles` effort → the profile's `thinking_effort` when the bound model matches its pin → the bound model's own default. With no declared effort, a model known not to support thinking uses `off`; a thinking model without a resolvable default still requires an explicit effort. Unknown capabilities do not imply `off`. See the [full binding rules](../customization/agents.md#named-profile-routes-experimental).

`preferred_models`, `discouraged_models`, and `preferred_efforts` are recommendations, so a model outside them still runs. `allowed_models`, `deny_models`, and `allowed_efforts` are hard: binding, manual changes, and resume all reject a violation, as do machine-level deny rules and unavailable capabilities.

**Resume.** `resume` continues an existing direct child by name or agent id, and is mutually exclusive with `name`, `profile`, `profile_file`, and `route`. Omit both `model_alias` and `effort` to keep the saved binding, or pass `effort` to apply it on the next idle run. `model_alias: "inherit"` is rejected here too — use a concrete model name to change models, and add `allow_model_change: true` when the change resolves to a different model. An external executor that cannot change a resumed thread's binding returns an error rather than recreating the thread.

**Timeouts and modes.** Agent tasks time out after 2 hours by default; set the global limit with `[subagent] timeout_ms` or `KIKI_SUBAGENT_TIMEOUT_MS` (`0` disables it), and print mode defaults to no timeout. There is no per-call timeout. In foreground mode the parent waits; in background mode a task ID returns immediately and the result arrives later as a synthetic User message. The TUI groups several foreground calls from one step and shows their status and elapsed time. See [Agents and Sub-Agents](../customization/agents.md) for the complete profile and lifecycle contract.

The `AgentRun` default follows the caller's runtime identity, not the target profile, and applies again on `resume`; goal mode does not change it. Main calls with omitted `background` or explicit `true` require `TaskList`, `TaskOutput`, and `TaskStop`; if they are unavailable, launch fails with guidance to enable them or retry with explicit `background:false`. No synchronous fallback is attempted. For a main foreground call, steer / Send now releases the wait into background without stopping the child. The next safe step reads the new input, and the child still delivers its completion notification. Ordinary queued input does not detach the wait. Stopping the current main turn is not the same as stopping detached children; use `TaskStop` to stop a tracked child explicitly.

A large foreground result comes back as a tail preview rather than in full. The receipt adds `output_size_bytes`, `preview_bytes`, `truncated`, `full_output_available`, and — when one exists — `output_path`. When `output_path` is present, read the complete result with `Read` on that file, or page through it with `TaskOutput` using `offset` and `max_bytes`. When no complete output file exists, `full_output_available` is `false` and only the preview can be read: run the work in smaller pieces, or re-run it with narrower instructions so the result fits. A small result keeps the plain summary text and needs none of this.

A completion still reaches you automatically while a [goal](../guides/goals.md) is blocked: the main agent wakes to process that one result, and the goal stays blocked. Paused or cancelled goals and an exhausted budget keep holding the result until your next message.

**`AgentList`** lists direct children of the current agent. Optional `include_finished` defaults to false. A live child that is starting, running, or cancelling stays visible as `running`, even after its previous background task has completed or timed out. A broken live executor is `errored`; otherwise status follows the latest background task, or is `untracked` when there is no task record. Pass `true` to also include finished or errored children. At most 50 entries are returned, running first; `omitted` is the count that did not fit. Each entry includes `agent_id`, optional `name` and `profile`, and `status`. A `running` child does not necessarily have a tracked background task or a pending completion notification; use `TaskList` to inspect tracked work.

**`AgentSend`** queues a non-empty `message` for a direct child identified by `target` (a `name` from `AgentRun`, or an agent id). A child that is running natively receives the message at the next step boundary, steered into its active turn. A child running on an external executor is not steerable, so the message waits and is picked up when its next run starts. An idle resumable child starts a new run with the message, and that run's completion notifies the parent like any other agent task. If more than one direct child matches, or none do, the call fails — use `AgentList` and retry with an unambiguous value. A full mailbox means the child has too many unread queued messages; wait until it consumes some, then retry.

The result includes a `message_id` and a `queued` or `delivered` status. `queued` means the mailbox accepted the message; delivery can complete concurrently, so it does not say the message is definitely still unread. `delivered` means the message reached the recipient's context and nothing more — not that the child has acted on it. `resumed: true` reports that a new run was actually observed starting; the field is omitted when no run start was observed, so its absence is not a negative answer. Once the recipient's context is persisted and the mailbox acknowledges delivery, the sender's transcript records a delivery receipt and clears the GUI's pending-delivery label, even if the child's transcript is not open. The receipt survives reload and history replay.

**`AskUserQuestion`** asks the user a structured multiple-choice question — useful for disambiguation or option selection. The `questions` parameter accepts 1–4 questions; each question requires `question` (ending with `?`), `options` (2–4 choices, each with a `label` and `description`), and optional `header` (max 12 characters) and `multi_select` (defaults to false). An "Other" option is appended automatically. Setting `background` to true starts a background question task and returns a task ID immediately. When the host does not support interactive questioning, a failure message is returned and the Agent should ask the user directly in a text reply instead.

**`Skill`** loads instructions by registered `skill` name or explicit Markdown `path`, never both, with optional `args`. Paths may be absolute or workspace-relative and follow file-read permissions and runtime isolation. Path loading does not replace a registered skill, install plugins, or execute scripts. The file's directory remains its relative-resource root; the loaded block records the source path and arguments so same-named files remain distinguishable. Omitted type, `prompt`, and `inline` are supported; `flow` and skills with `disableModelInvocation: true` are rejected for model invocation, including path loads. Maximum nesting depth is 3 levels. See [Agent Skills](../customization/skills.md) for details.

## Background Tasks

Completion notifications include results inline and retain the full-output path when available. Ordinary agent and process previews share a 16,000-byte UTF-8 budget per model step or recovery pass, split among the tasks in that batch and measured before XML escaping. A single result can use the full budget; multiple results each receive a bounded share instead of the first consuming it all. If the budget still runs out, notifications retain task identity, status, failure details, and the full-output path. Complete question answers keep their existing inline behavior and do not consume this pool. This limits previews, not the total notification length.

Background task tools manage tasks started via `Bash`, `AgentRun`, or `AskUserQuestion`. When a task reaches a terminal state, its status and saved output path are automatically delivered back to the Agent. For background subagents with automatic completion notification, the interactive main agent (root) continues independent work or ends its current turn normally; completion starts a follow-up turn when root is idle, without another user prompt. Ending the turn leaves the task running and the session open, and does not mark the overall task complete. When an agent task finishes or is stopped, the completion notice or `TaskStop` result also reports direct child subagents that are still running: the notice is omitted when none remain, and lists at most 5 names with a remaining count beyond that.

Root should not keep a turn open just to await that result with `TaskWait`, `TaskOutput` or `AgentList` polling, sleep, or timed loops. Use `TaskOutput` for a specific progress check and `TaskWait` for a genuine same-turn synchronization requirement. If automatic notification is unavailable, choose whether to wait based on the task's actual needs. Subagents still handle their own dependencies before returning a final result to their parent.

| Tool | Default Approval | Description |
| --- | --- | --- |
| `TaskList` | Auto-allow | List background tasks |
| `TaskOutput` | Auto-allow | View the output of a background task |
| `TaskStop` | Requires approval | Stop a running background task |
| `TaskWait` | Auto-allow | Wait for background tasks to finish |

**`TaskList`** returns background tasks. Optional parameters: `active_only` (defaults to true; lists only running tasks), `limit` (defaults to 20; range 1–100), and `offset` (defaults to 0). Pass the returned `next_offset` on each page while `has_more` is true; changes to the task roster can shift offsets. Completed subagent entries include receipt metadata and `receipt_verification`: only `verified` receipts can be treated as complete results, and a receipt with `contentState: unavailable` is not a completed report. `legacy_unverified` and `invalid` do not provide a trusted receipt path.

**`TaskOutput`** returns status and output for a `task_id`. Omit paging parameters for the most recent 32 KB preview; when `full_output_available` is true, pass `offset: 0` and optionally `max_bytes` (4–32768; defaults to 16384), then follow `next_offset` while `has_more` is true. Offsets count UTF-8 bytes, not characters; a mid-character offset advances to the next whole character and the reported `offset` is the actual start. The tool also returns `output_path` for available full logs, which `Read` can inspect instead. Invalid or unverified terminal receipts cannot be paged as full output. The call is always non-blocking; completion arrives via automatic notification.

**`TaskStop`** accepts a `task_id` and optional `reason` (defaults to `Stopped by TaskStop`). Safe to call on tasks that are already in a terminal state. Stopping an agent task cascades to its descendant subagents: each level first stops its own children's tasks and executions (deepest first), then aborts the agent itself, preserving their resumable scopes and mailbox messages for later resume. The result reports direct child subagents that are still running after the stop (omitted when none remain, at most 5 names).

**`TaskWait`** suspends the current turn for an explicit synchronous wait until a background task finishes or the timeout elapses. Parameters: `timeout` (required, a finite positive integer in seconds, from 1 to 86400), optional `task_id`, `sync_wait`, and `sync_reason`. This limit bounds the wait, not the task's runtime or the caller's lifetime; task completion, new input, or cancellation can end the wait early. A timeout is not an error: the result lists the tasks still running without stopping them. Reassess the same-turn requirement instead of automatically repeating the wait. A task whose result was reported by `TaskWait` does not also produce an automatic completion notification.

Outside active goal mode, a main agent waiting on a running agent task receives an immediate recoverable error unless it supplies all three: `sync_wait: true` (defaults to false), a specific `task_id`, and a non-empty concrete `sync_reason` explaining the same-turn dependency. Routine report collection is not a valid reason: do independent work or end the turn with a brief pending status and continue on notification. Rejection neither stops the task nor consumes its notification. Subagents waiting on their own tasks, main agents waiting on process tasks, and main agents with an active goal known to the engine do not need these exception fields. Terminal tasks return their existing results immediately; the exception grants no additional ownership or visibility.

Without `task_id`, the wait ends as soon as any background task that was running at call time finishes; when no background tasks are running, it returns immediately. For a main agent outside active goal mode, a wait-any snapshot containing a running agent task is rejected rather than silently filtering that task out. Specify a process task ID or use the synchronous exception with a specific agent task ID; `sync_wait` does not exempt wait-any calls.

## Scheduled Tasks

Scheduled task tools allow the Agent to re-inject a prompt into the current session at a future time — either as a one-time reminder or as a recurring cron-triggered task (periodic checks, daily reports, deployment monitoring, etc.). Schedules are bound to the session and remain active when you resume it with `kiki --session`, but are not carried into a brand-new session. A single session can hold at most 50 active scheduled tasks. Set `KIKI_DISABLE_CRON=1` to disable them entirely; see [Environment Variables](../configuration/env-vars.md#runtime-switches).

| Tool | Default Approval | Description |
| --- | --- | --- |
| `Cron` (`action: "create"`) | Requires approval | Schedule a prompt to fire at a future time |
| `Cron` (`action: "list"`) | Auto-allow | List scheduled tasks |
| `Cron` (`action: "delete"`) | Requires approval | Cancel a scheduled task |

The single `Cron` tool selects an operation with `action`; the old names `CronCreate`, `CronList`, and `CronDelete` remain callable for existing profiles and approval rules but are not offered as separate tools to the model. For `action: "create"`, `Cron` accepts `cron` (a standard 5-field cron expression in the user's local timezone: `minute hour day-of-month month day-of-week`), `prompt` (the text to inject when triggered; UTF-8 limit 8 KB), and optional `recurring` (defaults to `true`; pass `false` for a one-time reminder that auto-deletes after firing). On success, returns a ULID `id`, a human-readable `humanSchedule` (e.g., `every 5 minutes`), `deliveryMode`, and `nextFireAt` (the ISO timestamp of the next fire time).

Choose delivery with optional `delivery_mode`:

- `idle` (default): wait for current work to finish, then run before ordinary queued messages. Repeated fires of the same waiting job merge into one message with the total `coalescedCount`; different jobs remain separate in first-admission order.
- `queue`: retain each triggered delivery in the normal message order.
- `steer`: insert into the active turn at its next safe step without cancelling an in-flight request; when idle, run before ordinary queued messages.

Older tasks without a saved mode use `idle` on their next fire. Already queued messages keep their saved mode and position; legacy queued cron messages are not silently reordered. After restart, pending deliveries retain their mode and count and wait for the existing queue recovery action. Deleting or pausing a schedule stops future automatic fires, not messages already admitted.

To prevent all users from firing at the same time on the hour, the scheduler applies deterministic jitter: recurring tasks are shifted forward by `min(10% of the period, 15 minutes)`; one-time tasks that fall exactly on `:00` or `:30` are moved earlier by up to 90 seconds. If the scheduler misses several fire times (e.g., because the laptop was sleeping), it fires only once on wake-up — the prompt is wrapped in a `<cron-fire>` envelope with a `coalescedCount`. Recurring tasks that have been alive for more than 7 days fire one final time with `stale="true"` and are then automatically deleted; call `Cron` with `action: "create"` again to keep them.

**`Cron` with `action: "list"`** is read-only and needs no other parameters. It returns one record per active task with fields: `id`, `cron`, `humanSchedule`, `nextFireAt`, `recurring`, `deliveryMode`, `ageDays`, and `stale`. Records are separated by `---` in insertion order.

**`Cron` with `action: "delete"`** accepts a single `id`. For recurring tasks, all future fires stop immediately; for one-time tasks, a fire not yet admitted is cancelled. One-time tasks that have already fired are auto-deleted, so deleting an already-fired one-time task returns `No cron job with id ...`. Deletion is irreversible — use `Cron` with `action: "create"` again to restore. This action is blocked in Plan mode.

A `create` or `delete` that reports success has already been written to disk. When the save itself fails, the tool returns the error and the stored schedule stays as it was, so a success receipt never describes a task that only exists in memory.

## Goal

The main agent's `Goal` tool uses `action: "create"`, `"get"`, `"set_budget"`, or `"update"`; older `CreateGoal`, `GetGoal`, `SetGoalBudget`, and `UpdateGoal` names still work for existing profiles and approval rules but are no longer advertised separately. `create` needs a verifiable `objective` and an optional `completionCriterion`; `replace: true` abandons an existing goal only when requested. `get` reads its state. `set_budget` accepts a positive `value` and a unit (`turns`, `tokens`, `milliseconds`, `seconds`, `minutes`, or `hours`) when the user specifies a limit. `update` sets `active`, `complete`, or `blocked`; completion requires verifying the objective, and a nonterminal blocker must persist for three consecutive goal turns. For user controls and examples, see [Goals](../guides/goals.md).

## Next steps

- [Agent & Sub-Agents](../customization/agents.md) — Scheduling mechanics and context isolation for the `AgentRun` tool
- [Hooks](../customization/hooks.md) — Trigger local scripts before and after tool calls
- [Slash Commands](./slash-commands.md) — Quick reference for TUI built-in control commands
