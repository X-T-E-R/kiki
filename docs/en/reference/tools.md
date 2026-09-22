# Built-in Tools

Built-in tools are the tool set provided by Kiki alongside its core engine — no MCP server installation required. The Agent automatically selects and calls these tools based on the task at hand during each conversation; users can inspect the details of each tool call through the approval interface.

Compared to MCP tools, built-in tools are managed directly by the runtime, their lifecycle is bound to the session, and no external process is required. Both follow the same unified approval mechanism: **read-only tools** (such as `Read`, `Grep`, `Glob`) are automatically allowed by default, while **write and execution tools** (such as `Write`, `Edit`, `Bash`) require user approval by default. In YOLO mode, approval for regular tool calls is skipped; Plan mode exit approval is not affected.

## File Tools

File tools handle reading, writing, and searching the local filesystem — the foundation for code analysis and modification tasks.

| Tool | Default Approval | Description |
| --- | --- | --- |
| `Read` | Auto-allow | Read a text file's contents |
| `Write` | Requires approval | Create or overwrite a file |
| `Edit` | Requires approval | Precise string replacement |
| `Grep` | Auto-allow | Full-text search powered by ripgrep |
| `Glob` | Auto-allow | Find files by glob pattern |
| `ReadMediaFile` | Auto-allow | Read an image or video file |

**`Read`** accepts a file path (`path`) plus optional `line_offset` (starting line number; negative values count from the end) and `n_lines` (maximum number of lines to read). Returns at most 1000 lines or 100 KB per call; content beyond that limit is accompanied by a truncation notice. If the file is an image or video, the tool suggests using `ReadMediaFile` instead.

**`Write`** accepts `path`, `content`, and an optional `mode` (`overwrite` or `append`; defaults to overwrite). Missing parent directories are created automatically; `append` mode appends content to the end of the file without automatically adding a newline.

**`Edit`** accepts `path`, `old_string` (the exact text to replace), and `new_string` (the replacement text). By default it replaces only one unique match; if the same content appears multiple times in the file, the tool returns an error and suggests using `replace_all: true`. `old_string` and `new_string` must not be identical.

**`Grep`** invokes ripgrep to search file contents, supporting regular expressions (`pattern`), a search path (`path`), file type filtering (`type`, e.g., `ts`, `py`), glob filtering (`glob`), and output mode (`output_mode`: `files_with_matches` / `content` / `count_matches`; defaults to `files_with_matches`). `content` mode supports context lines (`-A`, `-B`, `-C`), case-insensitive matching (`-i`), line numbers (`-n`, default true), and multiline matching (`multiline`). All modes support `offset` + `head_limit` pagination; `head_limit` defaults to 250 and `0` means unlimited. Sensitive files such as `.env` files and private keys are automatically filtered out; set `include_ignored=true` to search files ignored by `.gitignore`, though sensitive files remain filtered.

**`Glob`** matches files in a specified directory (`path`; defaults to the working directory) by glob pattern (`pattern`). Results are sorted by modification time in descending order, returning 100 entries by default. It respects `.gitignore`, `.ignore`, and `.rgignore` by default; set `include_ignored=true` to include ignored files such as build outputs, while sensitive files remain filtered. Brace patterns such as `*.{ts,tsx}` are supported, and broad wildcard patterns are allowed.

Use `offset` (default 0) and `head_limit` (default 100) to page through matching paths; the result provides the next offset when more matches are available. Set `head_limit: 0` to remove the match-count limit. The character limit still applies: pages end at a complete path and provide the next offset when necessary. Large pages are saved to a file that the agent can read with `Read`. Each call searches the current filesystem again, so file changes can shift results between pages. Timeouts, unreadable directories, or the output capture limit can still leave the search incomplete; the result warns about these cases, and increasing the offset cannot recover uncollected paths.

**`ReadMediaFile`** sends an image or video to the model as multimodal content. It accepts `path`, plus optional image-detail controls such as `region` and `full_resolution`; the file size limit is 100 MB. Default image reads are compressed to the configured model limits. If automatic compression cannot meet those limits safely, the tool returns an error without sending the original image and directs the model to create and read a smaller copy. Availability depends on the current model's vision capabilities (`image_in` / `video_in`).

## Shell

| Tool | Default Approval | Description |
| --- | --- | --- |
| `Bash` | Requires approval | Execute a shell command |

**`Bash`** is the most permission-demanding tool and also the most general-purpose. Parameters:

- `command` (required): the shell command to execute
- `cwd`: working directory. With a local runtime and the agent's effective permission mode set to YOLO, an explicit absolute path may be outside the workspace. This does not bypass agent permission ceilings or actual remote/container isolation; manual/auto modes and relative traversal retain their workspace boundaries.
- `timeout`: timeout in milliseconds; foreground default is 60 seconds, maximum is 5 minutes
- `run_in_background`: whether to run as a background task; background tasks default to a 10-minute timeout (no timeout by default in print mode `kiki -p`)
- `description`: background task description; required when `run_in_background=true`
- `disable_timeout`: whether to remove the timeout limit for background tasks

Foreground mode blocks the current turn until the command completes or times out, and the TUI streams stdout and stderr into the running `Bash` tool card while the command is still active. By default, a foreground command that hits its timeout is not killed — it keeps running as a background task (bounded by the 600s default background timeout, i.e. a command auto-backgrounded on timeout gets a fresh 600-second budget); to restore kill-on-timeout, set [`bash_auto_background_on_timeout`](../configuration/config-files.md#background) to `false` under `[background]`. The 600s background default is configurable via [`bash_task_timeout_s`](../configuration/config-files.md#background) (`0` = no timeout) and defaults to no timeout in print mode (`kiki -p`). Background mode returns a task ID immediately and automatically notifies the Agent when the task finishes. stdin is always closed — interactive commands receive EOF immediately. A two-phase termination strategy (SIGTERM → 5-second grace period → SIGKILL) ensures reliable process cleanup when a task is stopped or hits its background timeout. On Windows, Git Bash is used by default.

## Web Tools

Both web tools are backed by Kiki's built-in search and retrieval module, which ships with the product — there is nothing to install. The module's provider instances, credential slots, lanes, and default fetch chain are built in, so web search works as soon as a usable lane is configured and fetch runs on the built-in default chain; see [`nb_search`](../configuration/config-files.md#nb-search) for the configuration surface.

| Tool | Default Approval | Description |
| --- | --- | --- |
| `WebSearch` | Auto-allow | Web search |
| `FetchURL` | Auto-allow | Fetch the content of a specified URL |

### `WebSearch`

Search the web through Kiki's built-in search and retrieval module (`nb-search`). The minimal call is `{ "query": "search terms" }`, which selects `action: "run"` and lets everything else fall back to your `[nb_search]` defaults. `query` may be a single string or an array of strings.

If no default `search_lane` is configured under `[nb_search.defaults]` and no `lane`, `lanes`, or `preset` is named in the call, the tool reports that no search lane is available and the search cannot run — name an available lane or preset explicitly to proceed. An explicit lane, an explicit `lanes` list, or a preset overrides the configured default; an invalid or unavailable selection fails the call rather than silently swapping in a different provider.

`run` accepts these parameter groups that actually change behavior:

- `lane`, `lanes`, `preset` — mutually exclusive; pick exactly one. Use `lanes` or `preset` to combine ranked sources; a typed result requires a single `lane`.
- `freshness`, `max_results` — content filtering.
- `timeout_ms` — per-call deadline.
- `execution`, `idempotency_key` — see the async section below.

Results are either ranked source links with snippets or typed research or documentation answers. Provider output is not independent verification — cite the actual URLs inline and use `FetchURL` when you need primary-source full text.

```json
{ "query": "kimi-code release notes" }
```

```json
{ "query": "kimi-code architecture", "lane": "<your-configured-lane>", "execution": "sync" }
```

### `FetchURL`

Fetch or extract content from a URL through Kiki's built-in search and retrieval module (`nb-search`). The minimal call is `{ "url": "https://example.com" }`, the URL shorthand for `action: "run"`; do not mix shorthand `url` with the `source` form. The default fetch chain returns Markdown; HTML responses are extracted to body text, and plain text or Markdown pages are passed through.

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

## Plan Mode

| Tool | Default Approval | Description |
| --- | --- | --- |
| `EnterPlanMode` | Auto-allow | Enter Plan mode |
| `ExitPlanMode` | Auto-allow (requires user to confirm the plan) | Exit Plan mode and submit the plan |

Plan mode restricts `Write` and `Edit` to the current plan file. It also blocks `BoardWrite`, `TaskStop`, `CronCreate`, `CronDelete`, `AgentSend`, and resuming existing children with `AgentRun` (see [State Management](#state-management) for `BoardWrite`).

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

**`TodoList`** is the per-agent execution list. Main and child agents have separate lists; the tool cannot read or update another agent's list. The `todos` parameter accepts an array where each item has a `title` and `status` (`pending` / `in_progress` / `done`). Omitting `todos` queries the caller's current list; passing an empty array clears only that list. Lists are restored with their owning agent, and conversation undo rolls back only that agent's list. Reminders and compaction summaries also use the receiving agent's list. Historical shared lists remain with the main agent; earlier child lists are not reconstructed from tool messages.

The task board is the persistent record of requirements that survives sessions. `BoardRead` supports `preview`, `list`, `show`, and `overview` for cards in the current workspace or other authorized workspaces. `BoardWrite` `create` always starts at `active`, so do not pass `status`; for `update`, include `status` only when changing the state. Valid states are `active`, `in_progress`, `paused`, `done`, `cancelled`, and `superseded`. `done`, `cancelled`, and `superseded` are terminal; reopen a terminal card by setting `status` back to `active`, `in_progress`, or `paused`, which clears its `completedAt`. Updates must use the card's current `revision`; after a conflict, reread the card before retrying.

Cards are persistent requirements, not agent runs or the per-agent `TodoList`. Reading a card does not change it, each agent keeps an independent `TodoList`, and marking every todo `done` does not update the card. Both tools are provided to the main agent by default and gated by the `task_board` experimental flag. Native subagents are denied both tools by default; explicitly allow either tool through its profile's `tools` list or [`subagent.allowed_tools`](../configuration/config-files.md#subagent), without bypassing other tool restrictions. `BoardRead` remains available in Plan mode; `BoardWrite` is rejected before approval (see [Plan Mode](#plan-mode)). Card writes follow the ordinary permission policy and do not require additional workspace trust.

In Settings → Plan and Tasks, choose `auto`, `global`, or `fixed` storage. A fixed location can be an absolute path or a path relative to the workspace; scripts are not executed. The task board is built in — no separate installation is needed. In `auto`, Kiki reuses existing compatible project storage when available and otherwise uses the session data area.

## Collaboration Tools

Main Agents receive four peer-thread tools by default: `ThreadList`, `ThreadRead`, `ThreadSend`, and `ThreadWait`. They address existing sessions on the same local host through a host/workspace/session reference; tool inputs name its fields `host_id`, `workspace_id`, and `session_id`. Sub-agents do not receive these tools.

- `ThreadList` lists enabled, unarchived sessions newest first, optionally filtered by `workspace_id`. `limit` defaults to 50 and accepts 1–100; the result includes an opaque cursor when another page is available.
- `ThreadRead` reads completed main-Agent turns without resuming a cold session. It accepts a thread reference plus an optional cursor; `limit` defaults to 20 and accepts 1–100.
- `ThreadSend` durably accepts a message for another thread and records peer provenance from the current main-Agent session. Supply the target thread, non-empty `content` of at most 100,000 characters, and a non-empty `idempotency_key` of at most 256 characters; there is no source parameter, and a key may be reused only for the same message.
- `ThreadWait` waits for terminal, attention, lifecycle, or undeliverable-message activity. A call accepts 1–8 distinct threads. `timeout_ms` defaults to 30,000 and accepts 0–60,000.

Peer-thread communication is local to one host, can cross workspaces, and is controlled globally by [`[thread_communication] enabled`](../configuration/config-files.md#thread-communication). A persisted per-workspace override can also disable a workspace.

Only `ThreadSend`, called by the source thread's main Agent, records peer attribution; REST and Klient sends are target-only user-origin input. See [Agents and Sub-Agents](../customization/agents.md#peer-thread-communication).

On Kiki desktop and the `kiki` CLI/TUI, the main `agent` profile always receives `AgentRun`, `AgentList`, and `AgentSend`. These tools address only the caller's direct children — by the optional `name` passed to `AgentRun`, or by agent id. They are not behind an experiment. The built-in [`coder` and `explore` profiles](../customization/agents.md) do not receive them. The retired `AgentSwarm` callable tool is not available for new calls; historical swarm child records remain readable.

`AgentList` returns those direct children, including retained historical swarm entries, and never lists grandchildren. `AgentSend` queues a mailbox message that is delivered as early as possible: when the child is running, the message is steered into its active turn at the next step boundary; when the child is idle (or a race just ended its turn), it stays queued and is read at the beginning of the child's next step.
Collaboration tools handle inter-Agent coordination, user interaction, and Skill invocation.

| Tool | Default Approval | Description |
| --- | --- | --- |
| `AgentRun` | Auto-allow | Spawn a sub-Agent to execute a subtask, or continue a direct child |
| `AgentList` | Auto-allow | List the caller's direct child agents |
| `AgentSend` | Auto-allow | Deliver a mailbox message to a direct child as early as possible; steered into an active turn while running |
| `AskUserQuestion` | Auto-allow | Ask the user a question to gather structured input |
| `Skill` | Auto-allow | Invoke a registered inline Skill |

**`AgentRun`** delegates a subtask to a sub-Agent. Required parameters are `prompt` and `description` (a short 3-5 word task description for UI display). Optional launch parameters include `profile` (defaults to `coder`), `profile_file` (an explicit role Markdown file, absolute or workspace-relative; it is not a shared prompt template and is mutually exclusive with `profile`, `route`, and `resume`), `background` (defaults to `false`), `name` (a session-unique handle of lowercase letters, digits, and underscores; `root` is reserved), `route`, `model_alias`, `effort`, and `allow_model_change` for an explicit model change on `resume`. A new spawn binds its model from the `model_alias` parameter or the pin on the effective profile, route, or caller lease, with the parameter winning; when neither names one, the call fails with `model.not_configured` and no child is created. Effort resolves separately through tool `effort` → profile `thinking_effort` → the bound model's own default. An unknown `model_alias` is an error. `resume` continues an existing direct child by name or agent id, is mutually exclusive with `name`, `profile`, `profile_file`, and `route`. Omit `effort` to keep the saved effort, or pass it to apply on the next idle run. Omit `model_alias` to keep the saved model; changing it to a different canonical model requires `allow_model_change: true`, while an alias resolving to the same canonical model is a no-op. Caller, role, route, and executor restrictions remain enforced. An external executor that does not support changing a resumed thread binding returns an error instead of recreating the thread or executor. Agent tasks time out after 2 hours by default; configure the global limit through `[subagent] timeout_ms` or `KIKI_SUBAGENT_TIMEOUT_MS` (`0` disables it), and print mode defaults to no timeout. There is no per-call timeout or arbitrary provider-parameter passthrough. In foreground mode the parent waits; in background mode a task ID returns immediately and the result is delivered automatically through a later synthetic User message. The TUI groups several foreground calls from one step and shows their status and elapsed time. See [Agents and Sub-Agents](../customization/agents.md) for the complete profile and lifecycle contract.

**`AgentList`** lists direct children of the current agent. Optional `include_finished` defaults to false. A live child that is starting, running, or cancelling stays visible as `running`, even after its previous background task has completed or timed out. A broken live executor is `errored`; otherwise status follows the latest background task, or is `untracked` when there is no task record. Pass `true` to also include finished or errored children. At most 50 entries are returned, running first; `omitted` is the count that did not fit. Each entry includes `agent_id`, optional `name` and `profile`, `status`, and `swarm_item` when a retained historical swarm child has an item label. A `running` child does not necessarily have a tracked background task or a pending completion notification; use `TaskList` to inspect tracked work.

**`AgentSend`** queues a non-empty `message` for a direct child identified by `target` (a `name` from `AgentRun`, or an agent id). A running child receives the message as soon as possible: it is steered into the child's active turn at the next step boundary. An idle child is not woken — the message waits in the mailbox until the child next runs. If more than one direct child matches, or none do, the call fails — use `AgentList` and retry with an unambiguous value. A full mailbox means the child has too many unread queued messages; wait until it consumes some, then retry.

**`AskUserQuestion`** asks the user a structured multiple-choice question — useful for disambiguation or option selection. The `questions` parameter accepts 1–4 questions; each question requires `question` (ending with `?`), `options` (2–4 choices, each with a `label` and `description`), and optional `header` (max 12 characters) and `multi_select` (defaults to false). An "Other" option is appended automatically. Setting `background` to true starts a background question task and returns a task ID immediately. When the host does not support interactive questioning, a failure message is returned and the Agent should ask the user directly in a text reply instead.

**`Skill`** loads instructions by registered `skill` name or explicit Markdown `path`, never both, with optional `args`. Paths may be absolute or workspace-relative and follow file-read permissions and runtime isolation. Path loading does not replace a registered skill, install plugins, or execute scripts. The file's directory remains its relative-resource root; the loaded block records the source path and arguments so same-named files remain distinguishable. Omitted type, `prompt`, and `inline` are supported; `flow` and skills with `disableModelInvocation: true` are rejected for model invocation, including path loads. Maximum nesting depth is 3 levels. See [Agent Skills](../customization/skills.md) for details.

## Background Tasks

Completion notifications include small results inline. Ordinary agent and process output previews share a 16,000-byte UTF-8 budget per model step or recovery pass, measured before XML escaping. When that budget runs out, notifications explicitly mark the omitted preview and retain task identity, status, failure details, and the full-output path when available. Complete question answers keep their existing inline behavior and do not consume this pool. This limits previews, not the total notification length.

Background task tools manage tasks started via `Bash`, `AgentRun`, or `AskUserQuestion`. When a task reaches a terminal state, its status and saved output path are automatically delivered back to the Agent. For background subagents with automatic completion notification, the interactive main agent (root) continues independent work or ends its current turn normally; completion starts a follow-up turn when root is idle, without another user prompt. Ending the turn leaves the task running and the session open, and does not mark the overall task complete.

Root should not keep a turn open just to await that result with `TaskWait`, `TaskOutput` or `AgentList` polling, sleep, or timed loops. Use `TaskOutput` for a specific progress check and `TaskWait` for a genuine same-turn synchronization requirement. If automatic notification is unavailable, choose whether to wait based on the task's actual needs. Subagents still handle their own dependencies before returning a final result to their parent.

| Tool | Default Approval | Description |
| --- | --- | --- |
| `TaskList` | Auto-allow | List background tasks |
| `TaskOutput` | Auto-allow | View the output of a background task |
| `TaskStop` | Requires approval | Stop a running background task |
| `TaskWait` | Auto-allow | Wait for background tasks to finish |

**`TaskList`** returns the list of background tasks. Optional parameters: `active_only` (defaults to true; lists only running tasks) and `limit` (defaults to 20; range 1–100).

**`TaskOutput`** returns the status and output of a task given its `task_id`. The inline preview includes at most the most recent 32 KB of content; the full log is saved to disk, and the tool also returns an `output_path` with a suggestion to use `Read` for paginated access. The call is always non-blocking — it returns the current snapshot immediately, and task completion is delivered via automatic notification.

**`TaskStop`** accepts a `task_id` and optional `reason` (defaults to `Stopped by TaskStop`). Safe to call on tasks that are already in a terminal state.

**`TaskWait`** suspends the current turn for an explicit synchronous wait until a background task finishes or the timeout elapses. Parameters: `timeout` (required, in seconds, from 1 to 600) and optional `task_id`. Without `task_id`, the wait ends as soon as any background task that was running at call time finishes; when no background tasks are running, it returns immediately. A timeout is not an error: the result lists the tasks still running without stopping them. Reassess the same-turn requirement instead of automatically repeating the wait. A task whose result was reported by `TaskWait` does not also produce an automatic completion notification.

## Scheduled Tasks

Scheduled task tools allow the Agent to re-inject a prompt into the current session at a future time — either as a one-time reminder or as a recurring cron-triggered task (periodic checks, daily reports, deployment monitoring, etc.). Schedules are bound to the session and remain active when you resume it with `kiki --session`, but are not carried into a brand-new session. A single session can hold at most 50 active scheduled tasks. Set `KIKI_DISABLE_CRON=1` to disable them entirely; see [Environment Variables](../configuration/env-vars.md#runtime-switches).

| Tool | Default Approval | Description |
| --- | --- | --- |
| `CronCreate` | Requires approval | Schedule a prompt to fire at a future time |
| `CronList` | Auto-allow | List scheduled tasks |
| `CronDelete` | Requires approval | Cancel a scheduled task |

**`CronCreate`** accepts `cron` (a standard 5-field cron expression in the user's local timezone: `minute hour day-of-month month day-of-week`), `prompt` (the text to inject when triggered; UTF-8 limit 8 KB), and optional `recurring` (defaults to `true`; pass `false` for a one-time reminder that auto-deletes after firing). On success, returns an 8-hex-digit `id`, a human-readable `humanSchedule` (e.g., `every 5 minutes`), and `nextFireAt` (the ISO timestamp of the next fire time).

To prevent all users from firing at the same time on the hour, the scheduler applies deterministic jitter: recurring tasks are shifted forward by `min(10% of the period, 15 minutes)`; one-time tasks that fall exactly on `:00` or `:30` are moved forward by up to 90 seconds. If the scheduler misses several fire times (e.g., because the laptop was sleeping), it fires only once on wake-up — the prompt is wrapped in a `<cron-fire>` envelope with a `coalescedCount`. Recurring tasks that have been alive for more than 7 days fire one final time with `stale="true"` and are then automatically deleted; call `CronCreate` again to keep them.

**`CronList`** is a read-only tool that accepts no parameters. It returns one record per active task with fields: `id`, `cron`, `humanSchedule`, `nextFireAt`, `recurring`, `ageDays`, and `stale`. Records are separated by `---` and sorted by schedule time.

**`CronDelete`** accepts a single `id`. For recurring tasks, all future fires stop immediately; for one-time tasks, the pending fire is cancelled. One-time tasks that have already fired are auto-deleted, so calling `CronDelete` on an already-fired one-time task returns `No cron job with id ...`. Deletion is irreversible — use `CronCreate` again to restore. `CronDelete` is also blocked in Plan mode.

## Next steps

- [Agent & Sub-Agents](../customization/agents.md) — Scheduling mechanics and context isolation for the `AgentRun` tool
- [Hooks](../customization/hooks.md) — Trigger local scripts before and after tool calls
- [Slash Commands](./slash-commands.md) — Quick reference for TUI built-in control commands
