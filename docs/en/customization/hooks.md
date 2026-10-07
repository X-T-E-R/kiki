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

Only `inject` and `observe` exist today. `inject` works on `step.before` and `prompt.submit`; `observe` works on those plus `step.after`, `tool.before`, `tool.after`, `turn.stopping`, `turn.after` and `session.start`, and only records metadata. Cadence applies to step events. Writing `command`, `block`, `gate` or `continue` is rejected at load time — those are the legacy contract below.

### Sources and matching

Rules combine from your user configuration, a trusted project's `.kiki/hooks.toml`, and enabled plugin manifests, and each gets a qualified id such as `user/evidence-check` or `workspace/check`. Lower `priority` runs first, with the qualified id breaking ties. A duplicate id inside one namespace is an error; the same short id in different namespaces is fine. Rules from an untrusted project stay visible but inactive, text-only ones included.

`match.models`, `profiles`, `routes`, `executors` and `agent_roles` take exact values: every field you write must match, several values in one field are alternatives, and an omitted field is unrestricted. Model aliases resolve at load time, so a typo shows up before the first request. Tool names go in `match.tools` and outcomes in `match.statuses` (`success`, `error`, `cancelled`, `denied`). `prompt.submit` defaults to `source = user`; name other sources in `match.sources`. An external executor without native step or tool interception is reported as unsupported rather than approximated from tool counts.

Long guidance can point at a file with `text_file = "reminders/check.md"` instead of `text` — the two are mutually exclusive — and `[hooks] files = ["hooks.toml"]` pulls in other v2 documents. Paths are relative to the declaring file and must stay inside its source scope once resolved. Includes cannot be URLs, repeat, or form a cycle. A missing file, empty text, unsupported action, invalid cadence or an injection over 8 KiB is a load-time diagnostic. Injected guidance is labelled conversation context: it does not replace the system prompt and cannot override higher-priority instructions.

Set `enabled = false` on a rule to disable it. The user section can disable qualified ids from any source with `disabled = ["workspace/check"]`, or turn off all v2 rules with `enabled = false`; project and plugin declarations can only disable their own. Changes take effect at the next safe event boundary.

### Inspecting effective rules

The `hooks-inspect` command reports each rule's source, why it is active or not, execution order, binding, count so far, and the count due next:

```ts
await klient.session(sessionId).agent("main").runCommand({ name: "hooks-inspect" });
```

The result is a `hook.result` diagnostic event (`hookEvent = "hooks.inspect"`) and is not added to the model's conversation. In the GUI, **Automatic rules** in the session's agent panel shows the same information, reading `GET /api/sessions/{session_id}/agents/{agent_id}/hooks` — a rule that saved successfully can still be inactive in a given session, and this is where you see why. With no rules configured and no source to repair, the panel shows no block at all.

**Settings → Capabilities → Hooks** (`/settings/hooks`) edits the user configuration. Pick a rule to edit it, or use **Advanced: edit JSON** for the whole legacy array or v2 object. Adding the first declarative rule switches a legacy array to v2 and keeps the commands under `legacy`; opening or saving that page never runs them. **Save actions** validates the entire hooks value and shows what the server stored, and a failed save keeps your draft. The v2 enable switch and disabled ids affect declarative rules only.

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
# Written in ~/.kiki/config.toml
[[hooks]]
event = "Notification"           # Trigger: when a background task status changes
matcher = "task\\.completed"     # Only care about "completed" notifications
command = "terminal-notifier -title Kimi -message 'Task done'"
```

Save the config, start a new session, and a notification will appear the next time a background task completes.

## Legacy rule fields

Each legacy rule is one entry in the `[[hooks]]` array in `~/.kiki/config.toml`:

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

Each time a hook triggers, the CLI passes this base information to the script on stdin:

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "session_abc",
  "session_title": "Fix the login page",
  "client_type": "kimi_code_cli",
  "cwd": "/path/to/project"
}
```

Individual events add their own fields (tool name, command text, and so on); see the event reference below. All field names are snake_case.

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
Only `PreToolUse`, `Stop` and `UserPromptSubmit` have return values that affect the main flow. Every other event is observation-only — it fires and the main flow continues whatever the script returns.
:::

## Event reference

| Event | Matcher matches | Supports blocking? | Description |
| --- | --- | --- | --- |
| `UserPromptSubmit` | The text submitted by the user | ✓ | Triggered when the user sends a message; returned text is appended to context; if blocked, the model is not called for this turn |
| `UserPromptQueued` | The queued prompt text | — | Triggered when a message is queued while a turn is still running; the payload includes `prompt_id`, `prompt`, and `queue_length` (observation only) |
| `PreToolUse` | Tool name | ✓ | Triggered before a tool call (before permission checks); the tool will not execute if blocked |
| `Stop` | Empty string | ✓ | Triggered when the model is about to end the current turn; if blocked, a message can be appended to let the model continue |
| `TurnStarted` | Turn origin kind (e.g. `user`, `task`, `system_trigger`) | — | Triggered when a new turn begins; the payload includes `turn_id`, `origin_kind`, `origin_name`, and `prompt` (observation only) |
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
| `StopFailure` | Error type | — | Triggered after the current turn fails due to an error (observation only) |
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
command = "node ~/.kiki/hooks/block-dangerous-bash.mjs"
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
- [Agents and sub-agents](./agents.md) — use the `SubagentStop` event to notify when a sub-agent finishes
