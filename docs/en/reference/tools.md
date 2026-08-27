# Built-in Tools

Built-in tools are the tool set provided by Kimi Code CLI alongside its core engine — no MCP server installation required. The Agent automatically selects and calls these tools based on the task at hand during each conversation; users can inspect the details of each tool call through the approval interface.

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

**`Glob`** matches files in a specified directory (`path`; defaults to the working directory) by glob pattern (`pattern`). Results are sorted by modification time in descending order, with a maximum of 100 entries. It respects `.gitignore`, `.ignore`, and `.rgignore` by default; set `include_ignored=true` to include ignored files such as build outputs, while sensitive files remain filtered. Brace patterns such as `*.{ts,tsx}` are supported, and broad wildcard patterns are allowed but usually truncate at the match cap.

**`ReadMediaFile`** sends an image or video to the model as multimodal content. It accepts `path`, plus optional image-detail controls such as `region` and `full_resolution`; the file size limit is 100 MB. Default image reads are compressed to the configured model limits. If automatic compression cannot meet those limits safely, the tool returns an error without sending the original image and directs the model to create and read a smaller copy. Availability depends on the current model's vision capabilities (`image_in` / `video_in`).

## Shell

| Tool | Default Approval | Description |
| --- | --- | --- |
| `Bash` | Requires approval | Execute a shell command |

**`Bash`** is the most permission-demanding tool and also the most general-purpose. Parameters:

- `command` (required): the shell command to execute
- `cwd`: working directory
- `timeout`: timeout in milliseconds; foreground default is 60 seconds, maximum is 5 minutes
- `run_in_background`: whether to run as a background task; background tasks default to a 10-minute timeout (no timeout by default in print mode `kimi -p`)
- `description`: background task description; required when `run_in_background=true`
- `disable_timeout`: whether to remove the timeout limit for background tasks

Foreground mode blocks the current turn until the command completes or times out, and the TUI streams stdout and stderr into the running `Bash` tool card while the command is still active. By default, a foreground command that hits its timeout is not killed — it keeps running as a background task (bounded by the 600s default background timeout); to restore kill-on-timeout, set [`bash_auto_background_on_timeout`](../configuration/config-files.md#background) to `false` under `[background]`. The 600s background default is configurable via [`bash_task_timeout_s`](../configuration/config-files.md#background) (`0` = no timeout) and defaults to no timeout in print mode (`kimi -p`). Background mode returns a task ID immediately and automatically notifies the Agent when the task finishes. stdin is always closed — interactive commands receive EOF immediately. A two-phase termination strategy (SIGTERM → 5-second grace period → SIGKILL) ensures reliable process cleanup when a task is stopped or hits its background timeout. On Windows, Git Bash is used by default.

## Web Tools

| Tool | Default Approval | Description |
| --- | --- | --- |
| `WebSearch` | Auto-allow | Web search |
| `FetchURL` | Auto-allow | Fetch the content of a specified URL |

**`WebSearch`** accepts `query` (search terms). Requires the host to provide a search implementation; when not injected, the tool does not appear in the tool list.

**`FetchURL`** accepts a single `url` parameter and returns the page content. For HTML pages, the host extracts the body text rather than returning the full HTML; plain text or Markdown pages are passed through directly. Also requires a host-provided implementation.

## Plan Mode

| Tool | Default Approval | Description |
| --- | --- | --- |
| `EnterPlanMode` | Auto-allow | Enter Plan mode |
| `ExitPlanMode` | Auto-allow (requires user to confirm the plan) | Exit Plan mode and submit the plan |

Plan mode is a constrained working state: once entered, `Write` and `Edit` are restricted to writing the current plan file only, and `TaskStop` is blocked entirely. All other tools (including `Bash`) are still governed by the current permission rules.

**`EnterPlanMode`** accepts no parameters; upon success it returns workflow guidance and the plan file path.

**`ExitPlanMode`** reads the current plan file, presents the plan to the user for approval, then exits Plan mode. The optional `options` parameter lets the Agent offer 1–3 alternative approaches (each with a `label` and `description`; `label` max 80 characters) for the user to choose from during approval. Labels must be unique and cannot use reserved words such as `Approve`, `Reject`, `Reject and Exit`, or `Revise`.

## State Management

| Tool | Default Approval | Description |
| --- | --- | --- |
| `TodoList` | Auto-allow | Manage a task to-do list |

**`TodoList`** maintains a visible subtask list across multi-step operations; state is stored within the Agent session. The `todos` parameter accepts an array where each item has a `title` and `status` (`pending` / `in_progress` / `done`). Omitting `todos` queries the current list; passing an empty array clears it.

## Collaboration Tools

Main Agents receive four peer-thread tools by default: `list_threads`, `read_thread`, `send_message_to_thread`, and `wait_threads`. They address existing sessions on the same local host through a host/workspace/session reference; tool inputs name its fields `host_id`, `workspace_id`, and `session_id`. Sub-agents do not receive these tools.

- `list_threads` lists enabled, unarchived sessions newest first, optionally filtered by `workspace_id`. `limit` defaults to 50 and accepts 1–100; the result includes an opaque cursor when another page is available.
- `read_thread` reads completed main-Agent turns without resuming a cold session. It accepts a thread reference plus an optional cursor; `limit` defaults to 20 and accepts 1–100.
- `send_message_to_thread` durably accepts a message for another thread and records peer provenance from the current main-Agent session. Supply the target thread, non-empty `content` of at most 100,000 characters, and a non-empty `idempotency_key` of at most 256 characters; there is no source parameter, and a key may be reused only for the same message.
- `wait_threads` waits for terminal, attention, lifecycle, or undeliverable-message activity. A call accepts 1–8 distinct threads. `timeout_ms` defaults to 30,000 and accepts 0–60,000.

Peer-thread communication is local to one host, can cross workspaces, and is controlled globally by [`[thread_communication] enabled`](../configuration/config-files.md#thread-communication). A persisted per-workspace override can also disable a workspace.

Only `send_message_to_thread`, called by the source thread's main Agent, records peer attribution; REST and Klient sends are target-only user-origin input. See [Agents and Sub-Agents](../customization/agents.md#peer-thread-communication).

On Kiki desktop and the `kimi` CLI/TUI, the main `agent` profile always receives `AgentRun`, `AgentSwarm`, `AgentList`, and `AgentSend`. These tools address only the caller's direct children — by the optional `name` passed to `AgentRun`, or by agent id. They are not behind an experiment. Built-in `coder` and `explore` profiles do not receive them.

`AgentList` returns those children, including ones started with `AgentRun` or `AgentSwarm`, and never lists grandchildren. `AgentSend` queues a mailbox message without starting or interrupting a turn, so an idle child stays idle and reads the message at the beginning of its next step.
Collaboration tools handle inter-Agent coordination, user interaction, and Skill invocation.

| Tool | Default Approval | Description |
| --- | --- | --- |
| `AgentRun` | Auto-allow | Spawn a sub-Agent to execute a subtask, or continue a direct child |
| `AgentSwarm` | Auto-allow in swarm mode; otherwise requires approval | Launch item-based subagents or resume existing subagents |
| `AgentList` | Auto-allow | List the caller's direct child agents |
| `AgentSend` | Auto-allow | Queue a mailbox message for a direct child without starting a turn |
| `AskUserQuestion` | Auto-allow | Ask the user a question to gather structured input |
| `Skill` | Auto-allow | Invoke a registered inline Skill |

**`AgentRun`** delegates a subtask to a sub-Agent. Required parameters are `prompt` and `description` (a short 3-5 word task description for UI display). Optional launch parameters include `profile` (defaults to `coder`), `background` (defaults to false), `name` (a session-unique handle of lowercase letters, digits, and underscores; `root` is reserved), `route`, and the stable `model_alias` and `effort` bindings. The legacy symbolic `model` parameter is available only while `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1` is enabled, and it is mutually exclusive with `model_alias`. Exact aliases named `primary` or `secondary` remain literal, while legacy `model: "primary"` inherits the immediate caller's binding and `model: "secondary"` selects the secondary recipe. A new spawn resolves each binding through tool parameter → profile field → caller binding; when the experiment is enabled, the secondary recipe is inserted before caller inheritance. `[subagent] default_model` / `default_effort` are not read by v2 `AgentRun` / `AgentSwarm`. An explicit unknown `model_alias` is an error. `resume` continues an existing direct child by name or agent id, is mutually exclusive with `profile`, and rejects `name`, `route`, `model`, `model_alias`, and `effort` because persisted bindings are immutable. Agent tasks time out after 2 hours by default; configure the global limit through `[subagent] timeout_ms` or `KIMI_SUBAGENT_TIMEOUT_MS` (`0` disables it), and print mode defaults to no timeout. There is no per-call timeout or arbitrary provider-parameter passthrough. In foreground mode the parent waits; in background mode a task ID returns immediately and the result is delivered automatically through a later synthetic User message. The TUI groups several foreground calls from one step and shows their status and elapsed time. See [Agents and Sub-Agents](../customization/agents.md) for the complete profile and lifecycle contract.

**`AgentSwarm`** launches new subagents from a `prompt_template` containing `{{item}}` plus an `items` array, resumes existing subagents through `resume_agent_ids`, or combines both. Required `description` labels the whole swarm. `profile` (defaults to `coder`), stable `model_alias`, and stable `effort` apply only to item-based new spawns; the legacy `model` parameter can also apply there when the secondary-model experiment is enabled. Resumed entries keep their persisted profile, model, and effort. A resume-only swarm rejects `route`, `model`, `model_alias`, and `effort`; `profile` may still be passed and affects only item-based spawns. Binding precedence, alias validation, and the legacy experiment gate match `AgentRun`. Without `resume_agent_ids`, the tool requires at least 2 distinct item-expanded prompts; with resumes it can continue one or more existing subagents. The tool supports 128 total entries, waits for all results, and must be the only tool call in a model response. The TUI shows foreground swarm progress above the input box. In `manual` permission mode it requests approval outside active swarm mode unless a rule allows it; permission rules match only the `AgentSwarm` tool name, not argument patterns. The initial ramp starts 5 subagents, then 1 more every 700 ms; `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` can cap concurrent work, and an invalid value fails fast.

**`AgentList`** lists direct children of the current agent. Optional `include_finished` defaults to false: the default list is running children plus children with no tracking task (`untracked`, the usual case for swarm members and foreground `AgentRun` calls). Pass `true` to include children whose latest background task has finished or failed. At most 50 entries are returned, running first; `omitted` is the count that did not fit. Each entry includes `agent_id`, optional `name` and `profile`, `status`, and `swarm_item` when the child was a swarm item.

**`AgentSend`** queues a non-empty `message` for a direct child identified by `target` (a `name` from `AgentRun`, or an agent id). It does not start, steer, or interrupt a turn. If more than one direct child matches, or none do, the call fails — use `AgentList` and retry with an unambiguous value. A full mailbox means the child has too many unread queued messages; wait until it consumes some, then retry.

**`AskUserQuestion`** asks the user a structured multiple-choice question — useful for disambiguation or option selection. The `questions` parameter accepts 1–4 questions; each question requires `question` (ending with `?`), `options` (2–4 choices, each with a `label` and `description`), and optional `header` (max 12 characters) and `multi_select` (defaults to false). An "Other" option is appended automatically. Setting `background` to true starts a background question task and returns a task ID immediately. When the host does not support interactive questioning, a failure message is returned and the Agent should ask the user directly in a text reply instead.

**`Skill`** allows the Agent to actively invoke a registered inline-type Skill. Accepts `skill` (the Skill name) and optional `args` (additional argument text). Only `type = "inline"` Skills can be called via this tool; Skills with `disableModelInvocation: true` are rejected. Maximum nesting depth is 3 levels. See [Agent Skills](../customization/skills.md) for details.

## Background Tasks

Background task tools manage tasks started via `Bash`, `AgentRun`, or `AskUserQuestion`. When a task reaches a terminal state, its status and saved output path are automatically delivered back to the Agent; use `TaskOutput` to check progress early, or `TaskWait` to wait for a result inside the current turn.

| Tool | Default Approval | Description |
| --- | --- | --- |
| `TaskList` | Auto-allow | List background tasks |
| `TaskOutput` | Auto-allow | View the output of a background task |
| `TaskStop` | Requires approval | Stop a running background task |
| `TaskWait` | Auto-allow | Wait for background tasks to finish |

**`TaskList`** returns the list of background tasks. Optional parameters: `active_only` (defaults to true; lists only running tasks) and `limit` (defaults to 20; range 1–100).

**`TaskOutput`** returns the status and output of a task given its `task_id`. The inline preview includes at most the most recent 32 KB of content; the full log is saved to disk, and the tool also returns an `output_path` with a suggestion to use `Read` for paginated access. The call is always non-blocking — it returns the current snapshot immediately, and task completion is delivered via automatic notification.

**`TaskStop`** accepts a `task_id` and optional `reason` (defaults to `Stopped by TaskStop`). Safe to call on tasks that are already in a terminal state.

**`TaskWait`** suspends the current turn until a background task finishes or the timeout elapses. Parameters: `timeout` (required, in seconds, max 600) and optional `task_id`. Without `task_id`, the wait ends as soon as any background task that was running at call time finishes; when no background tasks are running, it returns immediately. A timeout is not an error — the result lists the tasks still running, and the Agent can wait again or do other work meanwhile. A task whose result was reported by `TaskWait` does not also produce an automatic completion notification.

## Scheduled Tasks

Scheduled task tools allow the Agent to re-inject a prompt into the current session at a future time — either as a one-time reminder or as a recurring cron-triggered task (periodic checks, daily reports, deployment monitoring, etc.). Schedules are bound to the session and remain active when you resume it with `kimi --session`, but are not carried into a brand-new session. A single session can hold at most 50 active scheduled tasks. Set `KIMI_DISABLE_CRON=1` to disable them entirely; see [Environment Variables](../configuration/env-vars.md#runtime-switches).

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
