# Hooks

Hooks react to engine events. A declarative (v2) rule adds guidance or watches an event without running anything; a legacy hook runs a local shell command. Common uses:

- **Blocking something risky**: check a shell command for `rm -rf` before it runs and block it
- **Desktop notifications**: pop up a system notification when a background task finishes
- **Adding context**: append something the model should always see, such as the current Git branch, to every submitted message

## Declarative rules (v2)

Use v2 for fixed guidance, such as a reminder after every five completed steps. Add this to your [user configuration](../configuration/config-files.md), replacing `example-model` with a configured model key or alias:

```toml
[hooks]
schema_version = 2

[[hooks.rules]]
id = "evidence-check"
event = "step.before"
priority = 100

[hooks.rules.match]
models = ["example-model"]
executors = ["native"]
agent_roles = ["root", "subagent"]

[hooks.rules.cadence]
every_completed_steps = 5
counter_scope = "agent"
partition_by = "model"

[hooks.rules.action]
type = "inject"
text = "Check the goal, existing evidence, and next action before continuing."
```

A step is one committed model response with all its tool results settled, not one tool call. After five such steps the reminder is injected before the next model request; if the fifth step ended the turn, it waits for the next request on that model rather than starting one. Counts belong to each agent and canonical model identity, so switching A → B → A keeps A's count, and `counter_scope = "turn"` clears it at the next turn instead. Recovery, compaction and undo neither rewind counts nor replay a reminder; changing the matcher or cadence starts a new count at zero, while changing only the text uses the new text at the next milestone.

Declarative rules support `inject`, `observe`, and `compact`. `inject` works on `step.before` and `prompt.submit`; `observe` works on those plus `step.after`, `tool.before`, `tool.after`, `turn.stopping`, `turn.after` and `session.start`, and only records metadata; `compact` works on `step.before` and `step.after` (without `cadence`), triggering at most once per `counter_scope` (`"turn"` by default, or `"agent"`) when the active window since the last compaction meets `min_completed_steps`, `min_read_calls`, `min_read_chars`, and `max_write_calls` (`0` by default) and the effective context strategy is not explicitly `"fresh"`. Cadence applies to `inject` and `observe` on step events. Writing `command`, `block`, `gate` or `continue` is rejected at load time — those are the legacy contract below.

### Sources and matching

Rules combine from your user configuration, a trusted project's `.kiki/hooks.toml`, and enabled plugin manifests, and each gets a qualified id such as `user/evidence-check` or `workspace/check`. Lower `priority` runs first, with the qualified id breaking ties. A duplicate id inside one namespace is an error; the same short id in different namespaces is fine. Rules from an untrusted project stay visible but inactive, text-only ones included.

`match.models`, `profiles`, `routes`, `executors`, `agent_roles`, `channels` and `origin_kinds` take exact values: every field you write must match, several values in one field are alternatives, and an omitted field is unrestricted. Model aliases resolve at load time, so a typo shows up before the first request. `channels` filters inbound channels such as `direct` (desktop or CLI chat), `telegram`, `feishu`, `wechat`, `room`, or `peer_thread`; `origin_kinds` matches the message `origin.kind` (such as `user`, `cron_job`, or `task`) and relaxes `prompt.submit`'s default `source = user` filter when `sources` is omitted.

On `prompt.submit`, `prompt_regex` / `prompt_matches` match regular expressions (a pattern syntax for matching text) against the user's message text, and `prompt_not_matches` excludes messages matching any listed pattern. System-injected `<system-reminder>` blocks, `<skill-loaded>` expansions, and image-compression markers are stripped before matching so internal text never triggers a rule. On `tool.before` and `tool.after`, `tools` and `statuses` (`success`, `error`, `cancelled`, `denied`) take exact values, `tool_input_regex` / `tool_input_matches` and `tool_input_not_matches` test canonical serialized `tool_input`, and `[hooks.rules.match.tool_arg_matches]` matches individual argument keys or dot paths (for example `run_in_background = "^true$"` or `"options.env" = ["staging", "ci"]`) while keeping your exact parameter names intact. Using prompt matchers outside `prompt.submit` or tool-input matchers outside `tool.before` / `tool.after` fails schema validation instead of silently doing nothing.

`prompt.submit` defaults to `source = user`, including human input delivered with **Send now**; name `task` or `mailbox` in `match.sources` for those producers. A task-completion notification triggers `prompt.submit` when it is safely consumed, including a previously undelivered notification recovered from disk. Its task guidance follows the receipt before the next model request; it is not a human submit event, and an already consumed notification does not trigger it again. `sources = ["steering"]` matches the Send now delivery path regardless of producer; it does not turn a mailbox message into user input. An external executor without native step or tool interception is reported as unsupported rather than approximated from tool counts.

Long guidance can point at a file with `text_file = "reminders/check.md"` instead of `text` — the two are mutually exclusive — and `[hooks] files = ["hooks.toml"]` pulls in other v2 documents. Paths are relative to the declaring file and must stay inside its source scope once resolved. Includes cannot be URLs, repeat, or form a cycle. A missing file, empty text, unsupported action, invalid cadence or an injection over 8 KiB is a load-time diagnostic. Injected guidance is labelled conversation context: it does not replace the system prompt and cannot override higher-priority instructions.

Set `enabled = false` on a rule to disable it. The user section can disable qualified ids from any source with `disabled = ["workspace/check"]`, or turn off all v2 rules with `enabled = false`; project and plugin declarations can only disable their own. Changes take effect at the next safe event boundary.

### Inspecting effective rules

The `hooks-inspect` command reports each rule's source, why it is active or not, execution order, binding, count so far, and the count due next:

```ts
await klient.session(sessionId).agent("main").runCommand({ name: "hooks-inspect" });
```

The result is a `hook.result` diagnostic event (`hookEvent = "hooks.inspect"`) and is not added to the model's conversation. In the GUI, **Automatic rules** in the session's agent panel shows the same information, reading `GET /api/sessions/{session_id}/agents/{agent_id}/hooks` — a rule that saved successfully can still be inactive in a given session, and this is where you see why. With no rules configured and no source to repair, the panel shows no block at all.

**Settings → Permissions & rules → Hooks** (`/settings/hooks`) edits the user configuration. Pick a rule to edit it, or use **Advanced: edit JSON** for the whole legacy array or v2 object. Adding the first declarative rule switches a legacy array to v2 and keeps the commands under `legacy`; opening or saving that page never runs them. **Save actions** validates the entire hooks value and shows what the server stored, and a failed save keeps your draft. The v2 enable switch and disabled ids affect declarative rules only.

TOML cannot declare both `[[hooks]]` and `[hooks]` under the same key, and an existing array keeps working as it is. To keep legacy commands inside a v2 document, move them explicitly to `[[hooks.legacy]]`, keeping their `event`, `matcher`, `command` and seconds-based `timeout`; they still run under the legacy runner and output protocol.

## Recipe script hooks

A [Recipe model preset](./prompt-fields.md#recipe-model-presets) can carry scripts for its native model or profile binding. Add the hook to `recipe.toml` and list every UTF-8 script or support file the command needs:

```toml
[[hooks]]
event = "UserPromptSubmit"
command = "node hooks/cue.mjs"
files = ["hooks/cue.mjs"]
timeout = 5
```

`hooks/cue.mjs` reads the event JSON from standard input and returns guidance using the existing [script response protocol](#return-values):

```js
let input = '';
for await (const part of process.stdin) input += part;
const event = JSON.parse(input);
if (event.hook_event_name === 'UserPromptSubmit') {
  console.log(JSON.stringify({ message: 'Check the goal and available evidence before answering.' }));
}
```

Preview lists the actual commands, events, sources and resource fingerprints. Installing a script-bearing package requires one explicit confirmation for that executable content. Scripts run as the Kiki server's OS user and can access that host's files and network; they are not sandboxed and do not change the agent's tool permissions. Previewing, opening an editor or cancelling installation runs nothing. A package without scripts needs no script confirmation, and an accepted binding or resumed session does not ask again on each trigger.

The command runs in a managed directory containing the accepted resource snapshot, not in the author's live source directory. `KIKI_RECIPE_ROOT` names that resource directory; the event JSON's `cwd` still names the session workspace. Use your host's existing interpreter and quote shell paths normally. `matcher` and `timeout` retain the legacy fields below (timeout defaults to 30 seconds, integer range 1–600). Paths must stay relative to the package; each referenced text file is limited to 256 KiB. An optional `root` selects a package-relative directory for the listed `files`, which is useful for exported packages containing same-named inherited scripts.

Parent and child hooks append; top-level `hooks = "off"` removes inherited scripts. Model and profile references contribute independently. Disabling a reference stops that layer on the next binding or context rebuild, leaving its package and saved configuration intact. Existing sessions keep their frozen scripts until an explicit rebuild, even after the installation accepts an update.

Changing a command, script resource or execution source needs the same preview-and-confirm workflow before publishing. Prompt-only updates with unchanged executable content do not ask again. Automatic `follow` updates leave the old revision active when new scripts need confirmation. Copying or inheriting an accepted Recipe reuses its unchanged script authorization; exporting shares resources, not authorization, so a recipient confirms their first installation.

Recipe scripts support the Agent-bound events in the [event reference](#event-reference). `SessionStart`, `SessionEnd`, `SessionHeartbeat`, `SubagentStart` and `SubagentStop` are not valid Recipe events; existing user and plugin hooks for those events keep working. External executors do not run Recipe scripts. The declarative `hooks-inspect` view does not certify script execution; verify the script result and the target event instead.

## Legacy command hooks

Everything below describes the legacy contract: a rule names an event, targets to match, and a shell command to run.

On a match, the CLI passes the event details as JSON on **standard input** (stdin) — the trigger reason, tool name, command text and so on — and your script decides what to do. Its **exit code** carries the decision (`0` allows) and **standard output** (stdout) can carry explanation.

A blocking event fails closed when the script fails or times out: the pending operation stops with a reason. An observation-only event never interrupts the main flow. The [return-value table](#return-values) covers both.

::: warning Note
A hook supplements permission rules; it is not an operating-system sandbox and cannot approve a tool for you. Keep permission checks and manual confirmation in place for anything high-risk.
:::

## A minimal hook

This flashes a notification in the terminal title bar when a background task completes (macOS needs `terminal-notifier` installed):

```toml
# Written in <home>/config.toml (default: ~/.kiki/config.toml)
[[hooks]]
event = "Notification"           # Trigger: when a background task status changes
matcher = "task\\.completed"     # Only care about "completed" notifications
command = "terminal-notifier -title Kimi -message 'Task done'"
```

Save the config, start a new session, and a notification will appear the next time a background task completes.

## Legacy rule fields

Each legacy rule is one entry in the `[[hooks]]` array in the current `<home>/config.toml` (default `~/.kiki/config.toml`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `event` | `string` | Yes | Trigger event name; must be one of the entries in the event reference below |
| `matcher` | `string` | No | A regular expression to filter event targets; if omitted, matches all |
| `command` | `string` | Yes | The shell command to run when triggered |
| `timeout` | `integer` | No | Timeout in seconds, range 1–600; defaults to 30 seconds |

`[[hooks]]` only allows these four fields; extra fields will cause the config file to fail to load.

**When multiple rules match the same event**, all matching hooks run in parallel; multiple rules with identical `command` values run only once.

The working directory for hook commands is the current session's project directory. On non-Windows platforms, hook processes are placed in a separate process group; on timeout, a signal is sent first to give the process a chance to clean up, then it is forcibly terminated.

### Event data format

Each time a hook triggers, the CLI passes the session, workspace, and active agent binding to the script on stdin:

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "session_abc",
  "session_title": "Fix the login page",
  "workspace_id": "wd_example_000000000000",
  "execution_target": "local",
  "cwd": "/path/to/project",
  "client_type": "kimi_code_cli",
  "agent_id": "main",
  "agent_role": "root",
  "profile_id": "default",
  "profile_name": "default",
  "model_alias": "example-model",
  "model_id": "kimi-for-coding",
  "provider_id": "kimi",
  "provider_type": "kimi",
  "thinking_effort": "high",
  "executor_id": "native",
  "permission_mode": "auto",
  "turn_id": 1,
  "step": 2
}
```

Subagents additionally include `parent_agent_id`, and file-backed profiles or named routes include `profile_path` and `route_id`. Session-scope events (`SessionStart`, `SessionEnd`, `SessionHeartbeat`, `SubagentStart`, `SubagentStop`) include the session and workspace fields (`SessionStart` also includes the default `model_alias`, `model_id`, `provider_id`, `provider_type`, and `profile_name`). Individual events add their own fields (tool name, command text, full `origin`, `channel`, and so on); see the event reference below. All field names are snake_case.

## Return values

After the script exits, the CLI reads its intent from the exit code:

| Exit code | Meaning | CLI behavior |
| --- | --- | --- |
| `0` | Normal exit, allow | Continue execution; stdout content (if any) may be appended to context |
| `2` | Intentional block | Stop the current operation; stderr content (printed via `console.error`) is used as the reason for blocking |
| Other non-zero | Script error | Block the current operation for blocking events (fail-closed); notification-only events continue |
| Timeout or crash | Script exception | Block the current operation for blocking events (fail-closed); notification-only events continue |

### JSON protocol detection

For exit code `0`, the CLI classifies stdout like this:

- **Valid JSON** is walked recursively. If any object at any depth has its own `message` or `hookSpecificOutput` key, the output counts as a protocol attempt and the top-level value must match the strict hook response object — a different top-level shape or an invalid protocol field blocks a blocking event. JSON with neither key stays unstructured and is allowed.
- **Malformed object text** counts as a protocol attempt only when it contains a recognizable exact `message` or `hookSpecificOutput` key. Text starting with `[` is treated as array-shaped only when its first non-whitespace character could start a JSON value, so `[INFO]` and `[DEBUG]` logs stay unstructured. Single-quoted keys, missing separators and a missing colon are recognized as mistakes, while a prefix such as `messageCount` is not treated as a protocol key. A recognized malformed attempt blocks a blocking event.
- **Everything else** — malformed text with no recognizable protocol key, such as a log line quoting the word "message" — stays unstructured and is allowed, because it cannot be told apart from an ordinary log.

You can also return a JSON object via stdout to block:

```json
{
  "hookSpecificOutput": {
    "permissionDecision": "deny",
    "permissionDecisionReason": "Please use rg instead of grep"
  }
}
```

::: info Which events can block?
`PreToolUse`, `Stop` and `UserPromptSubmit` can block their pending operation. `StopFailure` can request a [continuation after a model failure](#continuing-after-a-model-failure); a failed hook leaves the original model error unchanged. Other events are observation-only.
:::

### Continuing after a model failure

A legacy `StopFailure` script can ask the native agent loop to append a new user message and continue after a model request fails. Automatic retries of the same request run first. The hook can append a new message after those retries stop or run out; it cannot resend the failed request.

Alongside the base event fields, the script receives:

| Field | Meaning |
| --- | --- |
| `error_type`, `error_message`, `error_code` | Error name, text, and Kiki error code |
| `error_details`, `error` | Error details and the full structured error, including its cause chain |
| `upstream_error_code` | Structured upstream error identifier, when available; do not infer it from message text |
| `model_alias` | Current model binding from the agent profile, when available; use it to scope model-specific recovery |
| `turn_id`, `step` | Current turn and step; `step` may be absent for a turn-end observation |
| `recoverable` | Whether the host permits continuation for this failure |
| `recovery_attempts`, `max_recovery_attempts` | Continuations already used in the current failure streak and the host limit of `1`; present when the loop asks for recovery |

When `recoverable` is `true` and the structured error matches a case your script handles, exit with `0` and write:

```json
{
  "hookSpecificOutput": {
    "recovery": {
      "action": "continue",
      "userMessage": "Continue from the preserved answer."
    }
  }
}
```

`userMessage` must contain non-whitespace text and fit within 8 KiB of UTF-8. Kiki appends it as a user message with a hook origin and starts the next step in the same turn. The last failed attempt's partial assistant output and completed tool results stay in context; output discarded for earlier retries stays discarded. This action does not replay the failed request or previous tool calls. There is no `retry` action.

The host permits at most one hook continuation per consecutive failure streak; if that continuation fails again recovery stops, and once it completes a full model response with usable content or model tool calls the budget resets so a later failure streak in the same turn can continue once again. HTTP 200 alone, heartbeats, partial output, or tool execution results alone do not reset the budget. Cancellation, credentials, billing, quota, safety filtering, context overflow, invalid configuration, an ordinary HTTP 429, and permanent provider rejections still stop recovery. A provider-named `gateway_stream_terminal_error`, on a stream event or an HTTP error body, forbids resending that request but can be followed by a new user message. Ambiguous or unknown delivery of a native model request does not by itself block that new message; external executors retain their own recovery contracts. An upstream boolean `retryable: false` also stops only the same-request retry. Scripts should match their supported structured failures and use `model_alias` when the policy is model-specific.

Without a continuation request, the original failure ends the turn normally. The same happens if a hook fails, times out, returns invalid output, or requests a different message from another matching hook. A synchronous `StopFailure` invocation is not repeated as a turn-end notification for the same failure; later failures can trigger it again. Return values on observation-only invocations (`recoverable = false`) do not change the outcome.

## Event reference

| Event | Matcher matches | Supports blocking? | Description |
| --- | --- | --- | --- |
| `UserPromptSubmit` | The text submitted by the user | ✓ | Triggered when the user sends a message; includes `prompt`, `prompt_text`, `prompt_id`, `user_message_id`, `origin`, `channel`, and `is_steer`; returned text is appended to context, and if blocked the model is not called for this turn while the message stays in place on the timeline with the block reason and **Send again** to restore it to the input box |
| `UserPromptQueued` | The queued prompt text | — | Triggered when a message is queued while a turn is still running; includes `prompt_id`, `user_message_id`, `origin`, `channel`, `prompt`, `prompt_text`, and `queue_length` (observation only) |
| `PreToolUse` | Tool name | ✓ | Triggered before a tool call (before permission checks); the tool will not execute if blocked |
| `Stop` | Empty string | ✓ | Triggered when the model is about to end the current turn; if blocked, a message can be appended to let the model continue |
| `TurnStarted` | Turn origin kind (e.g. `user`, `task`, `system_trigger`) | — | Triggered when a new turn begins; includes `turn_id`, `prompt_id`, `origin`, `origin_kind`, `origin_name`, `channel`, and `prompt` (observation only) |
| `PostToolUse` | Tool name | — | Triggered after a tool executes successfully (observation only) |
| `PostToolUseFailure` | Tool name | — | Triggered after a tool fails or is blocked (observation only) |
| `PermissionRequest` | Tool name | — | Triggered just before waiting for user approval (observation only) |
| `PermissionResult` | Tool name | — | Triggered after approval completes (observation only) |
| `SessionStart` | `startup` or `resume` | — | Triggered after a new session starts or a previous session resumes; the payload includes `source`, `model`, and `profile` |
| `SessionEnd` | `exit` or `archive` | — | Triggered after a session closes; `archive` means the session was archived rather than exited |
| `SessionHeartbeat` | Empty string | — | Triggered every 60 seconds while the session is alive; the timer only runs when this event is configured. The payload includes `uptime_ms` (observation only) |
| `SubagentStart` | Sub-agent name | — | Triggered before a sub-agent starts running |
| `SubagentStop` | Sub-agent name | — | Triggered after a sub-agent completes successfully (observation only) |
| `TaskStarted` | Task kind (`agent`, `process`, or `question`) | — | Triggered when a background task starts; the payload includes `task_id`, `description`, and `detached` (observation only) |
| `StopFailure` | Error type | — | Observes a failure; a native model-request failure can request a [bounded continuation](#continuing-after-a-model-failure) before the turn ends |
| `Interrupt` | Empty string | — | Triggered when the user interrupts the current turn (e.g. pressing Esc); not fired for timeouts or other programmatic aborts. `Stop` does not fire on interrupts, so this event fires instead. The payload includes a `reason` field (observation only) |
| `PreCompact` | `manual` or `auto` | — | Triggered before context compaction begins; return values are completely ignored |
| `PostCompact` | `manual` or `auto` | — | Triggered after context compaction completes (observation only) |
| `Notification` | Notification type (e.g. `task.completed`) | — | Triggered when a background task status changes (observation only) |

## Example: blocking a dangerous shell command

The following hook checks the command content before the Agent calls the `Bash` tool and blocks it if `rm -rf` is detected:

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "node \"$KIKI_HOME/hooks/block-dangerous-bash.mjs\""
timeout = 5
```

```js
// block-dangerous-bash.mjs
// Read event data passed by the CLI from stdin
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input);         // Parse event data
  const command = payload.tool_input?.command ?? '';

  if (command.includes('rm -rf')) {
    // Explain the blocking reason via stderr; exit code 2 means block
    console.error('Dangerous command detected, blocked');
    process.exit(2);
  }
  // Normal exit (exit code 0) means allow
});
```

After blocking, Kiki writes the reason back into the context, so the model can pick a safer alternative.

::: warning Note
This example shows how blocking works; matching on a substring is not a security parser. For real protection, allowlist the commands you permit or use a shell parser that understands quoting, variable expansion and command chaining.
:::

## Next steps

- [Legacy rule fields](#legacy-rule-fields) — the full `[[hooks]]` field reference
- [Agents and sub-agents](./agents-and-subagents.md) — use the `SubagentStop` event to notify when a sub-agent finishes
