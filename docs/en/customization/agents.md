# Agents and Sub-Agents

Every session is driven by a **main agent**, which follows your intent, plans steps, calls tools, and dispatches **sub-agents** for focused sub-tasks — exploring an unfamiliar codebase, reviewing several implementations in parallel, or planning a large refactor without filling the main context.

A sub-agent receives a task description, works in its own context, and returns its conclusions. It does not talk to you directly, and its intermediate reasoning and tool records stay out of the main agent's history.

For what a profile is and where its file lives, start with [Agent profiles: concepts and design](./agent-profiles.md). This page is the field and behavior reference.

## Built-in Sub-Agents

Fresh installations include the main `agent` profile and two subagent profiles:

- **`general`**: The default subagent — a general-purpose assistant that can read and write files, execute commands, and search code, without dispatching more children.
- **`explore`**: Dedicated to read-only codebase exploration, searching, and summarizing.

Two more roles are available to create on request rather than preinstalled: `implementer` owns an engineering task through verification and handoff, and `reviewer` independently checks a decision or finished work as a read-only leaf. Ask for one in conversation — the GUI's first-run `/kiki-ops` conversation offers a role when the task in front of you is missing one — and the `kiki-profile` skill writes the role to `$KIKI_HOME/agents/<role>.md` (default `~/.kiki/agents/`), leaving an existing file alone. Both templates set `model_alias: inherit`, so the role follows whatever model the parent agent is using, and leave `thinking_effort` unset — you can pin either role to a model later in Settings.

[`skip_builtin_profile_installation`](../configuration/config-files.md#top-level-fields) skips installing the named built-in templates under `agents/builtin/`, leaving copies that are already there. To hide installed profiles from discovery and dispatch, use `disabled_named_profiles` — the main `agent` binding stays available either way.

## How to invoke

The main agent dispatches sub-agents on its own as the work calls for it, and you can also ask for a specific one: "Use explore to map out the relevant files before making any changes."

Each dispatch appears as an approval request unless it matches an allow rule or YOLO mode is active, so you can read the task description before it runs. A sub-agent can run in the background and returns its result to the main agent on completion; you can also resume an existing sub-agent to continue the same task.

## Named child agents

The main `agent` profile gets three child-agent tools with no experiment flag: `AgentRun`, `AgentList` and `AgentSend`. Built-in subagent profiles do not. Each caller sees only the children it created itself — a grandchild or another caller's child is not a valid target.

`AgentRun` launches a new child or continues an existing one. Every call needs `prompt` and a short 3–5 word `description` for the UI. A new launch can also set:

| Parameter | Notes |
| --- | --- |
| `profile` | Which subagent role to run. Omitted, an explicitly configured `[subagent].default_profile` applies; with no such key the built-in general-purpose subagent is used. An explicit blank value requires a target. |
| `profile_file` | A subagent role Markdown file, absolute or workspace-relative. It is a role definition rather than a shared prompt template, and cannot be combined with `profile`, `route` or `resume`. |
| `route` | A named route of the base profile. |
| `name` | A handle for addressing this child again: `^[a-z0-9_]+$`, not `root`, unique within the session. |
| `background` | Omitted, main runs it in the background and a subagent waits in the foreground. `true` and `false` force background and synchronous waiting respectively. |
| `model_alias`, `effort` | Omitted, the saved or default values are kept. |

To continue a direct child, set `resume` to its name or agent id; it rejects `name`, `profile`, `profile_file` and `route`. `allow_model_change` only matters on `resume` with an explicit `model_alias` that resolves to a different canonical model.

A new launch picks its model from the concrete `model_alias` parameter, then the effective profile, route or caller-lease pin, then an explicitly configured `[subagent].default_model`. With none of those it fails with `model.not_configured` and no child is created, and an unknown alias is an error. Effort resolves separately, from the tool call, the route, the caller lease, the profile, or the model itself — [the full order is below](#named-profile-routes-experimental). Omitted `model_alias` and `effort` on `resume` keep the saved binding; an alias resolving to the same canonical model is a no-op, and a different one needs `allow_model_change: true`.

`preferred_models`, `discouraged_models`, `preferred_efforts` and route or caller-lease pins are soft: a hard-permitted override runs with a structured advisory. `allowed_models`, `deny_models` and `allowed_efforts` are hard in every scope. Machine `[subagent].deny_models`, unsupported model capabilities, route identity, a missing model-change confirmation and executor or thread restrictions are hard errors, and an external executor that cannot change a resumed thread binding returns an error rather than recreating the thread or executor.

Agent tasks time out after 2 hours by default; set the global limit with `[subagent] timeout_ms` or `KIKI_SUBAGENT_TIMEOUT_MS` (`0` disables it). Print mode has no timeout, and there is no per-call timeout or provider-parameter passthrough.

Background launch needs `TaskList`, `TaskOutput` and `TaskStop`. With those disabled, an omitted `background` from the main agent is rejected before launch rather than turned into a foreground wait — enable the tools, or pass `background: false` for a genuine same-turn dependency. While main waits in the foreground, steer or **Send now** moves the child to the background without cancelling it, so the next safe step can read the new input and the completion still notifies the parent. Ordinary queued messages do not release that wait. A child is not cancelled just because the main turn stops; use `TaskStop` to cancel one explicitly. See the [`AgentRun` reference](../reference/tools.md#collaboration-tools).

For `AgentRun` model choices, a profile's menu is a candidate list rather than a closed set while `restrict_models_to_menu` is off (the default). When it is on, only the profile author's default `model_alias` and `model_profiles` entries are selectable, and an out-of-menu pick is rejected rather than replaced. See [Model menus and hard boundaries](./agent-profiles.md#model-menus-and-hard-boundaries).

`profile_file` supplies a role definition directly, bypassing preset registration and preset allow/deny matching. `allowed_subagents: []` still permits this path, while `can_spawn_subagents: false` blocks all new children. Absolute or workspace-relative paths work, and the real path after resolving links must stay inside an allowed directory.

`AgentList` returns direct children. By default it lists running children and children with no tracking task; pass `include_finished: true` to also get children whose latest background task has already finished or failed. At most 50 entries come back, running ones first.

`AgentSend` queues a mailbox message: a running child has it steered into its active turn at the next step boundary, and an idle, resumable child starts a new run with it, whose completion notifies the parent like any other agent task. Address the child by `name` or agent id.

`AgentNotify` goes the other way and is available only to subagents: it queues a fire-and-forget message in the parent agent's mailbox, read at the parent's next step boundary or next run. The main agent has no parent and never receives it. `[agents] notify_parent = false` in `config.toml` turns it off globally; it is on by default.

## Peer-thread communication

Peer-thread communication lets a main agent coordinate other Kiki sessions on the same local host, including sessions in other workspaces. It is separate from the child-agent tools above and is off by default. Once enabled, a session's main agent gets `ThreadList`, `ThreadRead`, `ThreadSend` and `ThreadWait`. Subagents do not get them by default; a subagent profile can name `ThreadList`, `ThreadRead` and `ThreadWait` in its `tools` list, while `ThreadSend` stays main-only because it sends under the parent session's peer identity. To create an independent session instead, main agents can use [`ThreadCreate`](../reference/tools.md#collaboration-tools) without enabling anything.

A thread reference identifies a host, workspace and session. `ThreadList` returns the references later calls need, `ThreadRead` reads completed main-agent turns without resuming a cold session, `ThreadSend` derives the source from the current main-agent session, and `ThreadWait` waits up to 60 seconds for activity from up to eight threads. Messages cannot cross hosts.

A message is recorded as coming from a peer only when the source thread's own main agent calls `ThreadSend`. REST and the `global.threads` Klient facade take target-addressed input only and record it as external-client input, so an external client cannot claim a source thread or a direct human origin.

Set `[thread_communication] enabled = true` in `config.toml` to opt in globally. Sending can resume a cold target session and consume model quota. A workspace can persist an enable or disable override, but it cannot turn the feature on while the global switch is off. See [Server API](../server/rest-api.md#session-leases-and-peer-threads) for those interfaces.

## Context Isolation and Resource Cost

A sub-agent sees only the task description it was given, never the main agent's conversation, and only its final result comes back. Two things follow from that: the main context stays readable during a long session, and several sub-agents can run in parallel without interfering.

Each sub-agent spends its own tokens, so a small task is cheaper to do in the main agent.

## Permission inheritance

Sub-agents inherit the main agent's permission decisions: an "always allow" rule you accepted through `/permission` or an approval dialog applies to everything that agent dispatches, so the same tool call is not re-approved each time. `AgentRun` itself is allowed by default, so the main agent can delegate repeatedly without interrupting you.

To keep a tool permanently out of sub-agents, tighten the matching permission rule on the main agent.

## Custom agents

Your own agents are Markdown files. The frontmatter declares the name, description and tool access; the body is the system prompt. Kiki discovers them next to the built-ins, and they can be dispatched as sub-agents or selected as the main agent at startup.

### Capability visibility

The GUI's main-agent selector lists the profiles effective for the current workspace or working directory. Main profiles carry `main: true`; a file that overrides a built-in inherits that value when it omits it, and an explicit `main: false` is kept. `SYSTEM.md` therefore stays a main-agent profile with no extra frontmatter, and hiding the default profile from subagent discovery does not remove its main binding or its file overrides. See [Agent file format](#agent-file-format) for the fields.

In **Settings → Agents**, pick a workspace to inspect its default main profile, the source in effect, and the subagent capabilities. File-backed profiles can be edited where they are shown; editing a legacy `SYSTEM.md` adds frontmatter and keeps the prompt body. A selected profile that later becomes unavailable stays visible with a diagnostic, so you can pick another.

### Profile reloads and live sessions

Agent files are watched and reloaded on change, and a reload never breaks a live session: an agent already running or resumed keeps the prompt and constraint snapshot it was bound with, even if its profile is edited, made `private`, deleted or made invalid. Your edit therefore applies to **new** dispatches only, and dispatching to a private or deleted profile fails with an explicit error. A frozen dispatch list skips an invalid target instead of failing the whole turn. Restoring an old record whose profile is gone falls back to the default profile with a warning, after checking its model, effort and executor.

### Choosing the engine and its profile

The control at the left of the composer's status line answers one question — what runs this session — in one panel. Kiki itself is the first entry; each external engine follows, and under each engine sit that engine's own main profiles. The first row of every engine is that harness **as it is**: no Kiki profile, no Kiki prompt, no injected tools, and the harness's own model, effort and approval mode. Picking a profile under an engine takes both at once, so the two halves can never disagree.

The model control beside it stays separate: a model is a choice *within* the engine you picked. For an external engine, leave **Follow engine configuration** selected to keep its profile or engine defaults, or enter the engine's own model ID for a session override. Choosing Follow again clears the session's model and thinking overrides; it does not change the saved profile or engine settings. Native Kiki model lists do not limit external model IDs.

Model and profile catalogs load in the background. You can send with a preserved selection before they finish; Kiki validates the actual binding on the server. A catalog error offers Retry without replacing your choice, while a confirmed missing or invalid choice still needs correction.

A new session applies its engine pick immediately. In a session that has already spoken, engine, profile and model selections stay pending for your next message. The composer shows a pending chip you can cancel before sending. Sending captures those settings on that message; if it is queued, its settings appear with it rather than as another queue item. Nothing switches just because you made a pending selection.

Picking a different engine asks once first: the new engine starts a context of its own — Kiki does not hand it the old conversation or resume the old engine's session — while the conversation stays complete and readable in Kiki. An engine or profile change starts with the message's own turn after the current turn finishes. For a native model or effort change, **Send now** can instead apply the message's settings at the next safe step boundary, after the current model response and tool results have landed; it never changes a request already in flight.

**What Kiki adds when an engine runs** in **Settings → AI → External engines** sets the defaults for that engine across every session that does not override them: which Kiki tool groups and hooks the harness can reach, whether it can dispatch Kiki subagents, and how the profile prompt is delivered. Leaving everything there off is the same as choosing the bare row in the composer, so a harness you already trust runs exactly as its own CLI would.

### Direct external execution

A harness chooses the execution program; a profile is optional customization, and a model is a choice within that harness. With the main-agent [REST execution selection](../server/rest-api.md#sessions), omit `profile` to run the external program directly. Without session overrides or [harness defaults](../configuration/config-files.md#external-harness-defaults), Kiki sends no profile prompt, cognition, shared fields, memory, hooks or MCP tools and does not set model, effort, approval mode or Codex sandbox policy. Native execution without a profile keeps its existing Kiki defaults.

Direct execution preserves the configured launch environment, home and working directory, but the program must resolve to the same executable and settings sources as the CLI you expect. An ACP adapter may launch an SDK-provided binary or a configured override instead of the CLI on PATH; omitting a profile does not make those programs identical. An unknown login observation alone does not prevent launch.

### External ACP profile delivery

For an outbound ACP (Agent Client Protocol) executor, Kiki sends the frozen profile as a system prompt only when that harness accepts the `session/new` extension `_meta.systemPromptOverride`. The built-in `grok-acp` executor enables this; other ACP executors get the profile in the first user-message preamble. Add `profile_delivery = "system_prompt_override"` to a custom harness's `[agent_executors.<id>]` entry in `config.toml` to opt it in — only for a harness that honours the extension, since Kiki then omits the preamble fallback.

The override applies when a **new remote session** is created, not on `session/resume` or `session/load`, and an existing remote session keeps whichever mode it started with. Legacy profile-only dispatches include a bounded conversation handoff when a remote session must be recreated. The main-agent `execution` path does not send old Kiki history on a generation change or reconnect fallback. Because a system-prompt override can replace a harness's default system prompt, opt in only when that replacement suits the harness.

External ACP updates stay separate from assistant prose in the transcript. Grok tool-input updates appear in the tool card, interaction updates appear as tool status, and completion metadata does not create a second turn result. If an executor sends an update Kiki does not recognize, the transcript keeps its update type and a bounded, redacted payload when that payload was available; older records that stored only the type cannot be reconstructed.

An external engine's context reading appears as a quiet row inside that engine's own turn, named as the engine's because Kiki's context meter measures a different window. The model the engine reports it is running is shown the same way — as what the engine is running, never written back as a Kiki model choice. A reading the engine supersedes is replaced rather than repeated. A session fact the engine reports but cannot carry through — dropping an image the user sent, for example — is stated in the turn together with the engine's own reason, so the attachment does not vanish silently.

For legacy profile-only bindings, the built-in `kimi-acp` executor forwards configured MCP servers to Kimi Code; the `execution` path does not automatically forward workspace MCP. Kimi CLI versions from `0.37.0` up to, but not including, `0.39.0` reject ACP stdio MCP servers, so preflight warns that MCP tools will fail and recommends upgrading to `0.39.0` or newer. The warning does not block forwarding, and an undetectable version is forwarded without it.

### External main-agent delegation

An external executor can run as the main agent. To let it dispatch Kiki subagents, add `allow_kiki_subagents: true` to its profile and bind that profile to the main agent. The main-agent `execution` path can also set it in session overrides or [harness defaults](../configuration/config-files.md#external-harness-defaults); an omitted profile field inherits those defaults. Without an explicit value it is `false`, and it does not enable delegation from external child agents.

Kiki attaches its MCP tools (the bridge through which a harness calls Kiki) to the **existing session**, without creating a separate seat session. The harness must support local stdio MCP and have `kiki` on its path. The profile's spawn switch, preset permissions and preferences, model constraints and parent-notification policy still apply. Rebind the main profile after changing the flag — an existing binding keeps its frozen snapshot — and the bridge is revoked by disabling delegation or closing the executor.

A child's completion is queued back to the same main agent without blocking the child: if the main agent is busy, delivery waits for its turn to settle; if it is idle, the receipt wakes it. Parent notifications use the same conversation and remain subject to `allow_parent_notify` and the configured notification policy.

Codex app-server MCP tool calls can require a separate vendor approval, mapped to Kiki's persistent approval interaction. Manual or auto mode (`on-request`) lets you answer it. In Full access (YOLO), Kiki pre-approves only its attached `kiki-harness` MCP server at the Codex layer; Kiki's own capability and execution policies still govern those calls. Other MCP servers keep their approval policy, and the workspace-write sandbox is not widened.

What works with an external harness depends on the capabilities it negotiated. ACP historical forks use `session/fork` when available; an exact assistant-message position additionally needs the AIR fork-point extension supported by the Claude, Codex and DeepSeek adapters, and a position it cannot express starts a new remote session with a bounded conversation handoff. Codex and DeepSeek ACP form questions use Kiki's persistent question interaction, and complex forms or URL-mode requests they cannot express are declined. Grok's plan approval uses the persistent plan-review interaction.

### Kiki context in external main agents

Enable Kiki's native context tools independently of delegation with `kiki_context` in the external main profile:

```yaml
executor: claude-acp
allow_kiki_subagents: true
kiki_context: [memory, board, cron, threads, history, hooks]
```

In legacy profile-only bindings, an absent list turns every group off. In the main-agent `execution` path, an omitted profile field inherits [harness defaults](../configuration/config-files.md#external-harness-defaults), and session overrides take priority; `[]` explicitly disables everything. Rebind the execution after editing it. Tools are registered once when the bridge starts, so a group you enable later is not added to a harness that is already running. The bound profile's tool policy and feature settings still apply. Only external main agents can acquire this bridge.

| Group | MCP tools |
| --- | --- |
| `memory` | `kiki_memory_read`, `kiki_memory_search`, `kiki_memory_write` |
| `board` | `kiki_board_read`, `kiki_board_write` |
| `cron` | `kiki_cron` (`action: create`, `list`, or `delete`) |
| `threads` | `kiki_thread_list`, `kiki_thread_read`, `kiki_thread_send` |
| `history` | `kiki_history_search`, `kiki_history_read` |
| `hooks` | Message-context injection; no extra model-callable tool |

These tools use native Kiki parameters and execution policies, including approval, persona visibility, workspace access, memory review and Plan mode restrictions. Calls are attributed to the existing main agent — not to a user write, and not to a new seat session. The bridge token cannot reach ordinary REST endpoints or select a different caller session, and the native read tools advertise MCP read-only annotations. Vendor approval stays a separate layer from Kiki approval, except for the Codex Full access pre-approval above.

`hooks` sends memory summaries and undelivered reminders and working notes as messages, rather than by rewriting the system prompt or the tool schema. Identical content is deduplicated for the bridge's lifetime, and hook content is recorded in the Kiki transcript with a `hook_result` origin. Kiki writes only temporary process or session configuration and does not edit the harness's global hook settings.

| Harness | Injection |
| --- | --- |
| Claude ACP | Temporary command-hook settings through `session/new` metadata; `SessionStart` and `UserPromptSubmit` use `additionalContext`. |
| Codex app-server / ACP | Temporary `hooks.json` definitions become per-process/session configuration with trust pinned only to those commands; `SessionStart` and `UserPromptSubmit` use `additionalContext`. |
| Antigravity | Isolated `GEMINI_HOME` with `PreInvocation.injectSteps`. |
| Grok ACP | Native session-local ACP `Stop` callbacks inject `additionalContext`. Session-start and prompt-submit hooks cannot inject context, so Kiki keeps its message preamble before tools. |

Claude and Codex `PreCompact` hooks prepare an auditable handoff snapshot rather than injecting it, and the state summaries are restored at Claude's compact `SessionStart` or Codex's next `UserPromptSubmit`.

### Rebuilding a session context

After editing prompt sources, open the profile selector in the session composer and choose **Rebuild context**. Kiki reloads the current profile, prompt-field overrides, Agent Skills, `AGENTS.md` instructions and plugin prompt or session-start injections from disk, reconciles the other runtime context injections, and uses the rebuilt snapshot for later requests. Conversation messages are preserved. The action is unavailable while a turn is running.

**Dispatch capabilities** — next to the new-session workspace selector, or in a session's right rail — shows subagent profiles, routes, executors, and where the default model and thinking effort come from. Default-configuration validity and permission to launch are shown separately, and the panel reflects the current agent's tool directory, including [Plan mode's read-only research restriction](../reference/tools.md#plan-mode) and the reasons a launch would be refused. It does not check external provider health. If a model, profile or effort becomes unavailable, pick a valid value before sending; a loading state or catalog error alone does not invalidate a saved choice.

### Agent Locations

Kiki discovers agent files by scope; more specific scopes take higher priority: **Explicit (`--agent-file`) > Project > Extra > ordinary User files > Built-in copies (user scope) > Plugin**. When two files define the same `name`, the higher-priority scope wins. Each directory is scanned recursively for `.md` files.

**User level** (applies to all projects):
- `$KIKI_HOME/agents/` (default: `~/.kiki/agents/`)
- `~/.agents/agents/`

The Kiki-specific user agent directory moves with `KIKI_HOME`, while the generic `~/.agents/agents/` stays under the real OS home so other tools can share it.

**Project level** (project root = the nearest directory containing `.git`, searching upward from the working directory):
- `.kiki/agents/`
- `.agents/agents/`

**Extra directories**: Declared via `extra_agent_dirs` at the top level of `config.toml`:

```toml
extra_agent_dirs = ["~/team-agents", ".agents/team-agents"]
```

Agent Markdown files under the user, project and `extra_agent_dirs` roots are watched, and after roughly 200 ms additions, edits and deletions reload automatically — a running session can dispatch a newly added role without `/reload` or a restart. `$KIKI_HOME/SYSTEM.md` is watched the same way. An `AgentRun` tool instance keeps a frozen snapshot of the role descriptions it displays, so that list can look stale while dispatch resolution already uses the reloaded profiles.

**Plugin level**: directories declared in an enabled plugin's manifest `agents` field (when omitted, the `agents/` directory under the plugin root is picked up automatically); see [Plugin Agents](./plugins.md#plugin-agents). Plugin definitions have lower priority than the user files, including installed built-in copies.

**Built-in copies** are installed under `$KIKI_HOME/agents/builtin/` and loaded in the user scope after ordinary files in both user directories, so a same-name user definition always wins without `override: true`, whatever the filename order or install time. A duplicate-name diagnostic names both paths. A file loaded through `--agent-file` outranks every directory scope and applies to that launch only; `$KIKI_HOME/SYSTEM.md` separately overrides the default main agent's system prompt, as covered below.

::: warning Trust model
Agent files are prompt configuration, and project-level files come from the repository itself — including one you have just cloned and do not trust yet. A project file named `agent.md` can replace the **default main agent's whole system prompt**, and `general.md` can replace the default subagent type, with no `override: true` needed. Unlike `AGENTS.md` content, which is scoped instructions subordinate to system policy and your current request, such a file *is* the system prompt. Review `.kiki/agents/` and `.agents/agents/` in an unfamiliar repository before running Kiki inside it.
:::

### Agent File Format

An agent file is plain Markdown with a frontmatter block:

```markdown
---
name: reviewer
description: Strict code reviewer that reports severity-ranked findings
whenToUse: Code reviews and PR checks
override: false
model_alias: fast-model
thinking_effort: low
tools:
  - Read
  - Grep
  - Glob
  - mcp__github__*
disallowedTools:
  - Bash
---

You are a strict code reviewer. Read the diff, then report findings grouped by severity…
```

Model-list rejection and advisories below describe **subagent bindings**. For a session's main agent your selection wins over profile rules: a hard violation only warns, and recommendations do not warn at all. A `main: true` profile dispatched through `AgentRun` still follows the subagent rules. See [Model menus and hard boundaries](./agent-profiles.md#model-menus-and-hard-boundaries).

| Field | Required | Description |
| --- | --- | --- |
| `name` | no | Unique identifier with lowercase letters and digits separated by single hyphens or underscores (`code-reviewer`, `code_reviewer`). Defaults to the file name without its extension (`review.md` → `review`); invalid names are skipped with a warning, and selecting a matching skipped file reports its path and reason |
| `description` | yes | What the agent does. Shown to the main Agent when it picks a sub-agent, so write it to guide delegation decisions |
| `whenToUse` | no | Extra hint describing when the agent should be used |
| `override` | no | Legacy override metadata, default `false`. File precedence determines the winner; replacing an installed built-in copy with a same-name user file does not require this field |
| `main` | no | Curation flag. When `true`, this profile is a main-agent candidate: it is omitted from the `AgentRun` role list, from recommendation ranking, and from default selection. It is not an authorization gate — an explicit `profile` name, or a `profile_file` whose frontmatter sets `main: true`, still dispatches it as a subagent, resolving model, tools, and permissions like any other child (it never becomes the session's main agent); the receipt adds a one-time `main_profile_notice` pointing at `ThreadCreate` for long-running or user-visible collaboration. `--agent`, `--agent-file`, MCP, and the SDK can still bind any catalog name |
| `delegation_notice` | no | `auto` (default) injects a position-based handoff notice when this profile runs as a sub-agent or an independent host agent; `off` skips it. Main-agent binds never inject |
| `permission_mode` | no | Permission mode for this profile: `manual`, `auto`, `review`, or `yolo`. It overrides `default_permission_mode` when the profile starts a new agent; an explicit CLI `--permission-mode` takes precedence. |
| `model_alias` | no | Exact, case-sensitive alias from `[models]`, or configured `inherit` to bind a subagent to its caller's model. Without a pin, use a concrete dispatch parameter or explicit `[subagent].default_model`; omission never inherits the caller. Pins are soft defaults and cannot bypass hard lists. A main-agent profile cannot use `inherit` because it has no caller |
| `restrict_models_to_menu` | no | Boolean, default `false`, top-level profile field only. When `true`, adds a **hard** model ceiling from the author's original default `model_alias` plus `model_profiles[].alias`, captured before route / lease rewrites and frozen with the binding. Other hard allowsets still intersect and denials still apply; explicit pins and resume cannot bypass it. See [Model menus and hard boundaries](./agent-profiles.md#model-menus-and-hard-boundaries) |
| `thinking_effort` | no | Thinking effort requested when this profile starts as a new subagent. With `model_alias: inherit`, an explicit effort pin takes priority over the caller's effective effort |
| `executor` | no | Executor id from `agent-executors.toml`; omit it to use the native engine. Named-child dispatch uses this binding from both in-process and external delegation surfaces. For an external delegation, harness approval requests are exposed through that root's `interactions` / `respond` operations and scoped to its own children. Example profiles live in the repository under `docs/examples/agent-profiles/external-harnesses/` |
| `allow_kiki_subagents` | no | Default `false`. Attach Kiki's same-session delegation tools when this profile is bound to an external main agent; requires local stdio MCP. See [External main-agent delegation](#external-main-agent-delegation) |
| `kiki_context` | no | Opt-in list of `memory`, `board`, `cron`, `threads`, `history`, and `hooks`; absent or `[]` disables all groups. See [Kiki context in external main agents](#kiki-context-in-external-main-agents) |
| `allowed_models` | no | **Hard** model allowlist, as a YAML list or comma-separated string. Native aliases are compared by canonical model identity; external executors are checked against their effective model ID. An out-of-list binding is rejected, including explicit pins, manual selection, and resume. `[]` permits no models; omit, use `null`, or use a lone `"*"` for no additional restriction. Never mix `*` with names |
| `deny_models` | no | **Hard** model denylist. A match is rejected even when another list allows it. Empty or omitted means no denials; wildcards are invalid. Machine `[subagent].deny_models` remains an additional hard boundary |
| `allowed_efforts` | no | **Hard** allowlist of effective thinking efforts. Profile, lease, tree, and matching model-profile rules all apply; `[]` permits no effort. Neither an explicit pin nor a forced host value bypasses it. Unsupported provider/executor efforts remain errors |
| `preferred_models` | no | **Soft** model recommendations. A different executable, hard-permitted model continues with a structured `model_not_preferred` advisory. Does not automatically select a model |
| `discouraged_models` | no | **Soft** models to avoid. Selecting one continues with a `model_discouraged` advisory; use `deny_models` to reject it |
| `preferred_efforts` | no | **Soft** effort recommendations. Deviations continue with an `effort_not_preferred` advisory; use `allowed_efforts` to reject them |
| `model_profiles` | no | Per-alias run recipe, as a YAML list of mappings. Required `alias`; optional `when`, `thinking_effort`, all six hard/soft model-list fields above, `prompt_mode` (`prepend` / `append` / `wrap`), `prompt`, `prompt_overrides`, `service_tier`, `request_params`, `context_budget`, `auto_compact`, and `max_completion_tokens`. `when` appears only in the parent's dispatch description. Prompt deltas compose onto the role body before model cognition; `wrap` requires `${parent_prompt}` or `${base_prompt}` exactly once. Unresolvable aliases do not apply or appear in the native tool description. Defaults use the first matching entry; hard lists from every matching entry apply, including original entries whose defaults a lease replaces |
| `recipe` | no | Installed Recipe id, optionally prefixed with `installation:`. Applies prompt and model-setting overrides only to this profile's native binding, after the model Recipe and before explicit profile values; `off` removes this profile's contribution. Install sources first; binding does not download packages. See [Recipe model presets](./prompt-fields.md#recipe-model-presets) |
| `prompt_overrides` | no | Prompt field overrides for this profile, with optional `files` and `fields`. This layer overrides global and model values; a matching `model_profiles[].prompt_overrides` entry overrides it. See [`prompt`](../configuration/config-files.md#prompt) |
| `system_prompt_mode` | no | Prompt-body mode: `replace` (default), `prepend`, `append`, or `inherit`. `inherit` requires an empty body and a non-empty `prompt_overrides`; it retains the lower-priority same-name profile definition while applying this file's field overrides |
| `service_tier` | no | Profile default service tier: `auto`, `default`, `flex`, or `priority`. An explicit matching `model_profiles` value wins over this profile default, which wins over the model and Recipe defaults. Only the `openai_responses` provider protocol encodes it into the request body; other protocols silently ignore it |
| `request_params` | no | Extra request parameters as a scalar map (string/number/boolean values only), sent with every request this subagent makes. OpenAI-family providers spread them into the request body (Kimi via `extra_body`) without overriding engine-generated fields; Anthropic ignores the map; a first-class field such as `service_tier` wins on collision. Keys are sent verbatim, so a provider may reject names it does not recognize. Typed provider parameters such as `temperature` and `top_p` belong here for the `kimi` provider; pass them only if the underlying model supports them |
| `context_budget` | no | Token budget for this profile's context window. Declared only as a cap — must not exceed the bound model's `max_context_size`. The effective value is the minimum of every declared layer; declared limits can shrink the budget but never widen it past the model's real capacity |
| `auto_compact` | no | Automatic compaction point in positive integer tokens; can also be set separately in a matching `model_profiles` entry. Overrides the model and global defaults, but not this Agent's per-model session override. This is a soft target, not a context-window limit |
| `max_completion_tokens` | no | Per-completion output cap (token budget for a single LLM step). Declared only as a cap; the effective value is the minimum of every declared layer. Distinct from the input limit and the total context window — see [Configuration files](../configuration/config-files.md#models) |
| `tools` | no | Allowlist of tool names such as `Read` or `Bash`; MCP tools are matched with globs such as `mcp__github__*`. Accepts a YAML list or a comma-separated string (`tools: Read, Grep`). Omitting it, using a lone `*`, or pairing `*` with names adds no profile allowlist; an empty list (`tools: []`) disables all tools. [Subagent defaults](../configuration/config-files.md#subagent) and other policy limits still apply: naming one tool opts that tool in for this profile as a subagent, so `tools: ["*", ThreadRead]` keeps the ordinary tools and adds `ThreadRead`, while `*` alone opts in nothing. A finite list stays finite. A tool the server-wide `subagent.allowed_tools` names is open for this profile only when this list also selects it, so a profile writing a finite `tools` list blocks a tool it leaves out; one that writes no list (or `*`) is open to everything that entry allows. `disallowedTools` denies either grant |
| `disallowedTools` | no | Denylist with the same syntax and matching rules, applied after `tools` |
| `disabled-tool-groups` | no | Denylist of built-in tool groups, YAML list or comma-separated string, such as `disabled-tool-groups: [shell, web]`. Every built-in tool in a listed group is withheld unless the tool is named explicitly in `tools`; an unknown group name fails the file at load. Precedence inside one profile, most specific first: `disallowedTools` (a denied tool stays denied) > `tools` (an explicitly listed tool survives a disabled group) > `disabled-tool-groups`. Only built-in tools belong to groups — MCP and user tools are never matched. The groups are `agent` (`AgentRun`, `AgentList`, `AgentSend`, `AgentNotify`), `board` (`BoardRead`, `BoardWrite`), `cron` (`Cron`; legacy `CronCreate`, `CronList`, `CronDelete`), `fsRead` (`Read`, `ReadMediaFile`, `Glob`, `Grep`), `fsWrite` (`Write`, `Edit`), `goal` (`Goal`; legacy `CreateGoal`, `GetGoal`, `UpdateGoal`, `SetGoalBudget`), `plan` (`EnterPlanMode`, `ExitPlanMode`, `TodoList`), `question` (`AskUserQuestion`), `shell` (`Bash`), `skill` (`Skill`), `task` (`TaskList`, `TaskOutput`, `TaskStop`, `TaskWait`), `thread` (`ThreadCreate`, `ThreadList`, `ThreadRead`, `ThreadSend`, `ThreadWait`), `toolSelect` (`SelectTools`, `CallTool`), and `web` (`WebSearch`, `FetchURL`) |
| `can_spawn_subagents` | no | `false` blocks all new children, including `profile_file`; it does not block resuming existing children. Omit or use `null` for no additional closure at this layer. `true` cannot reopen a base or lease that declares `false` |
| `allowed_subagents` | no | **Hard** list of selectable preset profile names, including a route's base profile and scoped aliases. Accepts a YAML list, comma-separated string, or name/lease/source mappings. `[]` permits no presets but still permits an explicit Markdown definition. Omit, use `null`, or include `"*"` for no added preset limit |
| `preferred_subagents` | no | **Soft** preset recommendations. Other visible, hard-permitted presets remain dispatchable with an advisory. Does not grant access, choose a default, or trigger fallback; `[]` clears recommendations |
| `deny_subagents` | no | **Hard** preset exclusions, checked even when allowed elsewhere. `"*"` excludes all presets, not explicit Markdown definitions. Empty or omitted means no exclusions |
| `spawn_constraints` | no | Rules inherited by descendants: hard `allowed_models`, `deny_models`, `allowed_efforts`, and `disallowed_tools`; soft `preferred_models`, `discouraged_models`, and `preferred_efforts`. Allowsets intersect and denials accumulate along the tree; pins cannot widen hard rules |
| `private` | no | Hide this profile from dispatch and selection lists (`AgentRun`, Settings pickers). A private profile stays registered: agents already running or resumed on it keep working from their bound snapshot, while any **new** dispatch to it fails with an explicit "profile is private" error. Use it to retire a role without breaking live sessions |

Use `preferred_subagents: [explore]` for a recommendation rather than a closed role list. Across a base profile, a route and a caller lease, allowed sets intersect, denials accumulate, `false` stays closed, and the nearest explicit preference list replaces the earlier one. A `"*"` can share an `allowed_subagents` list with names and source or lease mappings: it leaves this layer open while keeping those mappings. Repeated bare names are ignored, and two different mappings for one alias are an error.

`profile_file` supplies a new role definition without registering it in the preset catalog, and the file's `name` does not make it a same-name preset — preset allow/deny lists and same-name caller leases do not apply to it, and the caller's preset list is not copied into its downstream rules. The file's own rules, inherited model and tool constraints and workspace path checks still apply. Use `can_spawn_subagents: false` for a complete leaf rather than `allowed_subagents: []`.

The old author fields `subagents` and `subagent_policy`, and the host settings `main_dispatch_policy` and `subagent_dispatch_policy`, have been removed. Move advice-only role names to `preferred_subagents`, real preset boundaries to `allowed_subagents` / `deny_subagents`, and a former leaf to `can_spawn_subagents: false`; source and lease mappings stay under `allowed_subagents`. Existing bindings are upgraded without changing their role, model, prompt or source snapshot, and a structured edit keeps the fields you did not mention — `null` removes a local declaration, `[]` writes an explicit empty list.

`model_profiles` is a YAML list of mappings, so every entry needs an `alias` — a bare string or mapping at the top level is invalid. Every other field is optional, and a matching entry's `auto_compact` overrides the profile's top-level value (both in integer tokens, never a percentage). Example:

```yaml
model_profiles:
  - alias: fast-model
    when: Scope and acceptance checks are already named and a fast decisive pass beats waiting.
    thinking_effort: high
    context_budget: 32000
    max_completion_tokens: 4096
  - alias: k3-review
    when: Ordinary review work the default alias can finish on its own.
    prompt_mode: prepend
    prompt: |
      Prefer system-level and global-contract reasoning.
    service_tier: priority
    request_params:
      temperature: 0.2
```

`model_profiles` is matched by canonical model identity. Resolve the model alias configuration, including its `overrides`, first; then apply model alias → top-level profile → matching `model_profiles` entry. `request_params` merge by key and the last explicit `service_tier` wins. Treat `context_budget` and `max_completion_tokens` as caps: the smallest declared value across layers applies, within the model's capacity and output limit. Omitting a cap adds no restriction. Only top-level `thinking_effort` requires the selected model to match the profile's default `model_alias`; other profile parameters do not.

For per-model prompt text, `model_profiles.prompt_mode` and `prompt` extend the role body, while the model cognition overlay (`[models."<alias>".cognition]`) extends the model's system prompt.

For subagent bindings, `allowed_models`, `deny_models` and `allowed_efforts` are hard everywhere they appear: in the profile, `spawn_constraints`, a caller lease and matching `model_profiles` entries. Allowsets intersect and denials accumulate, and a violation returns `profile.constraint_violation` naming the rule source, the allowed and denied values, the effective value and where the binding value came from. An advisory, a pin, a manual model or effort change and `resume` cannot widen them. Machine `[subagent].deny_models` is one more hard boundary, route sidecars cannot declare model hard lists, and an external executor is rechecked against its effective model ID.

```yaml
model_alias: fast-model
allowed_models: [fast-model, review-model]
deny_models: [heavy-model]
allowed_efforts: [high, max]
preferred_models: [fast-model]
preferred_efforts: [high]
discouraged_models: [review-model]
```

Here `review-model` stays executable with an advisory, and `heavy-model` is rejected. Lists never select a model — use a `model_alias` pin, a dispatch parameter or an explicit `[subagent].default_model`.

When the default and per-model recipes already form the complete permitted set, make that menu the contract instead of duplicating it as a hard list:

```yaml
model_alias: fast-model
restrict_models_to_menu: true
model_profiles:
  - alias: review-model
    when: A more thorough review is needed.
    thinking_effort: high
preferred_models: [fast-model]
```

This permits the default `fast-model` and the menu entry `review-model`, and nothing else; other hard rules may narrow them further. Keep the switch off for a recommendation-only menu and use `preferred_*` / `discouraged_models` there. Use `allowed_models` / `deny_models` for a budget, compliance, deployment or descendant-tree boundary of their own. See [When to enable it](./agent-profiles.md#when-to-enable-it) for the three-scenario rule.

`allowed_models`, `deny_models` and `allowed_efforts` enforce their literal hard meaning everywhere; there is no legacy soft mode. If one of your lists was only advice, rename it to `preferred_models`, `discouraged_models` or `preferred_efforts` in every scope where it appears, and keep real boundaries as they are. A saved binding outside the hard rules is rejected on resume — pick a permitted value or revise the rule, then retry.

Tool names match exactly and case-sensitively; entries starting with `mcp__` match MCP tools as globs. Three shapes match nothing and produce a warning when the profile takes effect: a wildcard outside an `mcp__` pattern (a bare `*` in `disallowedTools` disables nothing), an `mcp__` literal that is not a full `mcp__<server>__<tool>` name (`mcp__github` matches nothing — use `mcp__github__*` for the whole server), and a name no registered or built-in tool has, usually a typo such as `read` for `Read`.

The body is the agent's system prompt, rendered as a template each time the prompt is built: `${var}` placeholders substitute live context values, an unknown variable stays verbatim, a bare `$` is never special, and a variable with no value renders as an empty string. `${parent_prompt}` (alias `${base_prompt}`) embeds the implicit parent for this file: the effective default system prompt in an agent file, the built-in default inside `SYSTEM.md`, or the base profile in a route. `${builtin_prompt}` is always the built-in default, even when `SYSTEM.md` exists. If the file replaces the default prompt but should still honor instructions from enabled plugins, place `${plugin_sections}` where those belong. The full variable list is in the SYSTEM.md section below.

Frontmatter keys are closed: an unrecognized field makes the file fail to load with a diagnostic naming the key, so remove or migrate it (Claude Code's `model` and OpenCode's `mode`, for instance). The comma-separated `tools` form is accepted and a missing `name` falls back to the file name, so a minimal file with just a `description` and a body loads.

### Named profile routes (experimental)

A named route specializes an existing agent without creating a new permission identity. Discovery is on by default. To turn it off for new dispatches, set `[experimental] agent-profile-routes = false` in `config.toml`, or `KIKI_EXPERIMENTAL_AGENT_PROFILE_ROUTES=0`, and restart the server.

Keep the base profile at `agents/<role>.md` and put routes under `agents/.routes/<role>/<route>.md`, which gives the canonical id `<role>.<route>`. Route segments are kebab-case. For example, `agents/.routes/reviewer/ui-k3.md` defines `reviewer.ui-k3`:

```markdown
---
id: reviewer.ui-k3
profile: reviewer
description: Review UI changes with the K3 model
whenToUse: Frontend and interaction reviews
prompt_mode: prepend
model_alias: k3-review
thinking_effort: high
tools: [Read, Grep, Glob]
disallowedTools: [Bash]
allowed_subagents: [explore]
service_tier: priority
request_params:
  temperature: 0.2
---

Focus on interaction regressions, accessibility, and visual consistency.
```

Required: `id`, `profile`, `description`, `prompt_mode`. Optional: `whenToUse`, `model_alias`, `thinking_effort`, `service_tier`, `request_params`, `tools`, `disallowedTools`, `can_spawn_subagents`, `allowed_subagents`, `preferred_subagents`, `deny_subagents`. Route frontmatter is strict, and an unknown field — including agent-file-only ones such as `model_profiles`, `allowed_models` and `deny_models` — skips that one sidecar with a coded diagnostic while the base profile and sibling routes still load. The same happens for a path, id or profile mismatch, a duplicate id in one source, or incompatible model selectors.

`prompt_mode` always preserves the base prompt: `inherit` requires an empty body, `prepend` and `append` require a non-empty body and reject `${parent_prompt}` / `${base_prompt}`, and `wrap` requires `${parent_prompt}` or `${base_prompt}` exactly once. There is no unguarded replace mode.

A route's `tools` and `disallowedTools` replace the base fields, its `allowed_subagents` intersects the base set, `deny_subagents` accumulates, and `can_spawn_subagents: false` cannot be reopened; the nearest explicit `preferred_subagents` replaces the earlier preference, and an omitted field inherits. `allowed_subagents: []` closes preset selection only. Caller checks use the base role, so a route cannot introduce a preset role the caller could not dispatch.

An omitted request field inherits the base value: `service_tier: null` clears the tier, `request_params: null` clears the map, and a mapping overlays scalar keys. A route-declared `model_alias` or `thinking_effort` is the route default, and `AgentRun` may override either only within the hard model and effort lists. With no override, a missing route model or an effort the provider cannot perform is a hard capability error.

`AgentRun` lists route entries filtered through the caller's base-role allowlist, showing the route id, base role, description, model and effort defaults and the overridden field names — never the prompt body. Pass `route: reviewer.ui-k3`; omit `profile` to derive `reviewer`, or pass that matching base explicitly. A mismatch is a coded error, and there is no automatic ranking or silent fallback.

Resume never reselects or switches a route: the journal stores the canonical base role and route id with the rendered prompt, tool policy, denylist, subagent restriction, model and effort locks, service tier and request parameters. A routed agent therefore resumes from its snapshot even if the flag is later disabled or the sidecar changes; those changes affect only new dispatches.

A new child picks its model from the concrete `model_alias` parameter, then the pin on the effective profile, route or caller lease, then an explicitly configured `[subagent].default_model`; with none of them the spawn fails with `model.not_configured` and no child is created, and the caller's model is not a silent fallback. Set `model_alias: inherit` in a profile, route or caller lease to bind the caller's resolved model explicitly — `AgentRun` itself rejects `model_alias: "inherit"`, so pass a concrete name or omit the parameter. With configured inheritance the caller's effort follows too, unless a tool `effort` or an applicable `thinking_effort` pin takes priority; otherwise effort resolves as tool `effort` → the route's locked effort, or the caller lease's when the route pins none → matching `model_profiles` effort → profile `thinking_effort` when the bound model matches the profile pin → the bound model's own default. When none supplies an effort, a model known not to support thinking uses `off`; a thinking model without a resolvable default still needs an explicit effort. Unknown capabilities do not imply `off`, and an unknown alias is an error wherever it came from.

On `resume`, omitting both `model_alias` and `effort` keeps the saved binding, and an alias resolving to the same canonical model is a no-op. Changing only `effort` applies it to the next idle run. Changing `model_alias` to a different canonical model needs `allow_model_change: true`, and with `effort` also omitted the target model's own default is re-resolved rather than carried over. Profile, lease, model-profile and inherited hard rules are checked at resume admission, and a rejection leaves the saved binding unchanged; an effort the provider cannot honor, a machine model denial and executor thread-binding restrictions are hard errors too.

Omit `model_alias` and `effort` to use the target's defaults for a new child. The model catalog lists hard-permitted configured models and marks the preferences coming from the effective profile, lease, route and model-profile entries; a model listed for another target is neither preferred nor allowed here. Pair `preferred_models` with a default `model_alias` to publish a preferred pool, and keep `model_profiles` for per-model defaults and guidance. A route's `service_tier`, including `service_tier: null`, does not clear a configured model-level tier.

`allowed_models`, `deny_models` and `allowed_efforts` are always hard, whatever the scope. `preferred_models`, `discouraged_models`, `preferred_efforts`, route defaults and caller-lease pins are soft: a deviation is kept in the binding and summarized in the parent `AgentRun` result. See the [configuration reference](../configuration/config-files.md#subagent).

An invalid file found in a directory is skipped with a warning and does not affect the others. A file passed via `--agent-file` must be valid, or the CLI reports the error and exits.

::: warning Note
`tools` and `disallowedTools` shape what the model is shown and are enforced again before execution. Preset allow/deny rules also filter the `AgentRun` catalog and are checked again before dispatch, and `can_spawn_subagents: false` blocks new Markdown-file children while still allowing an existing child to be resumed. Permission rules remain a separate control for operations that need approval.
:::

A dispatched custom agent gets a short handoff notice prepended: its last message is the complete deliverable. An independent host invocation (MCP / SDK) gets a different notice, because there is no parent agent; a main-agent bind gets none. Put `${delegation_context}` in the body to place the notice yourself, or set `delegation_notice: off` (or `[agents.delegation] sub = false` / `independent = false` in `config.toml`) to skip it. Override `delegation.sub.notice` or `delegation.independent.notice` through [`PromptOverrides`](../configuration/config-files.md#prompt) to change its text; the boolean gates always win over a text override.

### Selecting the Main Agent

Two CLI flags select which agent drives a new session, in both print mode (`kiki -p`) and the interactive TUI:

- **`--agent <name>`**: Start the session with the named agent as the main Agent. The name can refer to a built-in agent or to any discovered file; an unknown name fails with an error listing the available agents.
- **`--agent-file <path>`**: Load one agent file at the highest priority for this launch and start with it. The flag accepts exactly one file: it cannot be repeated, and it cannot be combined with `--agent`.

Both flags apply only when starting a new session — neither can be combined with `--session`/`--continue`. The agent is bound at creation, and resuming restores it automatically, so no flag is needed or allowed there.

In print mode an explicit `--model` beats the profile's `model_alias`. Without `--model`, the profile pin wins and `default_model` applies only when the profile sets no model, so a pinned profile works without a global default. Subagents do not use that main-agent default; they can use their own `[subagent].default_model`. A main-agent profile cannot pin `model_alias: inherit`, because it has no caller to follow.

For example:

```sh
kiki --agent reviewer
kiki -p --agent reviewer "Review the changes on this branch"
```

These flags select the profile for a new session only; the GUI can request a main-profile switch when you submit the next prompt. A session created later in the same TUI process (with `/new`, for example) starts with the default agent. Your main-agent model choice takes priority over profile rules: recommendations do not warn and hard violations only show a non-blocking warning.

When you customize the main agent, reference `${parent_prompt}` or `${base_prompt}` in the body so the environment, workspace-instruction, Skill and plugin injections already in the effective default prompt stay in effect. `${builtin_prompt}` is the stock default even when `SYSTEM.md` exists, and `${plugin_sections}` keeps just the plugin-contributed instructions. A body with none of the three owns the whole prompt, which suits a self-contained sub-agent.

### Overriding the main agent's system prompt with SYSTEM.md

To replace the default main agent permanently — without passing `--agent` or `--agent-file` on every launch — write `$KIKI_HOME/SYSTEM.md` (default: `~/.kiki/SYSTEM.md`; it moves with `KIKI_HOME`). It takes effect in every launch mode, including interactive TUI sessions. A missing or empty file does nothing, and a file that fails to parse produces a path-specific diagnostic while the last good version of that file keeps working, so you can repair it and reload rather than losing the override. Malformed YAML after an opening `---` is never treated as a plain prompt. Removing the file drops the override.

How it is parsed depends on the first line:

- **Legacy body.** The file does not start with `---` followed by a YAML mapping. Only the prompt is replaced; description, tools and the sub-agent allowlist keep the built-in defaults.
- **Upgraded profile.** The file starts with `---` and that fence parses as a YAML mapping. It loads as a normal agent file named `agent`, with `override` forced on. Omitted tool fields and child-role permissions inherit the built-in defaults; declared preset permissions narrow them, and explicit recommendations replace inherited ones.

Explicit intent still outranks it: a project-scoped same-name agent file declaring `override: true` and any file passed via `--agent-file` take precedence, `--agent` bypasses it entirely, and within the user scope SYSTEM.md wins over a same-name file in `agents/`.

An upgraded `SYSTEM.md` may declare `prompt_overrides` in its frontmatter. With `system_prompt_mode: inherit`, leave the body empty and Kiki keeps the built-in `agent` prompt while applying only those fields. A replacement body stays authoritative and shadows built-in `system.*` section overrides, while `system.shared` and the delegation notice stay outside it. The complete format and precedence are under [`prompt`](../configuration/config-files.md#prompt).

Like the body of a regular agent file, SYSTEM.md is rendered as a template each time the prompt is built — `${var}` placeholders in the body are substituted from the live context:

| Variable | Content |
| --- | --- |
| `${skills}` | The merged Agent Skills injection; empty when the `Skill` tool is unavailable |
| `${agents_md}` | Content of the workspace instruction files (such as `AGENTS.md`) |
| `${cwd}` | Current working directory |
| `${cwd_listing}` | Listing of the working directory |
| `${os}` | Operating system kind |
| `${shell}` | Shell name and path, for example `bash (\`/bin/bash\`)` |
| `${now}` | Current time in ISO format |
| `${additional_dirs_info}` | Additional directories added to the workspace; empty when there are none |
| `${parent_prompt}` | The implicit parent prompt for this file. Same slot as `${base_prompt}` |
| `${base_prompt}` | Alias of `${parent_prompt}`. Inside `SYSTEM.md` this is the built-in default; inside an agent file it is the effective default — the built-in default, or your `SYSTEM.md` override when present; inside a route it is the base profile |
| `${builtin_prompt}` | The built-in default main prompt, ignoring `SYSTEM.md` |
| `${delegation_context}` | Position-based handoff notice; empty for the main agent |
| `${plugin_sections}` | A complete Plugin Instructions block contributed by enabled plugins; empty when no enabled plugin contributes instructions |

Four pre-composed blocks — `${windows_notes}`, `${additional_dirs_section}`, `${skills_section}` and `${plugin_sections}` — render the matching built-in prompt section, or an empty string when it does not apply. The built-in default prompt already includes `${plugin_sections}`, so do not add it again when `${base_prompt}` expands to that prompt. The variables are enough to rebuild the skeleton of the built-in prompt:

```markdown
You are Kiki, running at ${cwd} on ${os}.

${agents_md}

${skills}

${plugin_sections}
```

## Instruction Files

`AGENTS.md` supplies instructions within each file's stated directory scope, and a more specific file wins when two conflict. These stay subordinate to system policy and your current request: they cannot change tool schemas, permissions or host controls.

Kiki loads `$KIKI_HOME/AGENTS.md` (default: `~/.kiki/AGENTS.md`) together with the workspace-root `AGENTS.md`; a root `.kiki/AGENTS.md` replaces the user-level file while the root `AGENTS.md` still applies. At session start, applicable files along the path from the project root to the working directory are included too. Filename matching is case-insensitive. Files above the project boundary, `~/.agents/AGENTS.md` and the legacy `.kimi-code/AGENTS.md` path are not discovered.

When a permitted file tool reaches a different directory, Kiki checks that directory's ancestors for `AGENTS.md` and `.kiki/AGENTS.md`. The first write that would have missed those rules returns a retryable result without changing anything, so the agent can read the supplied rules and retry under the same permission policy — no extra approval. Rules already delivered in full, by the runtime snapshot or a complete successful `Read`, are not sent again just because another tool visits the directory; a truncated read does not count. The initial directory listing is a one-level sample, and the agent uses `Glob` to explore further.

## Storage in the session directory

Sub-agent runtime state is persisted to the `agents/` subdirectory of the current session directory. Each sub-agent instance has its own directory containing a `wire.jsonl` file with its prompts, message history and final state in chronological order, and background sub-agents also expose their lifecycle status under a `tasks/` subdirectory.

::: warning Note
Session directories, wire files and task records can contain prompts, command output, repository paths, tool return values or traces of credentials. Redact them before putting any of it in a public repository, an issue or a chat log.
:::

## Next steps

- [Hooks](./hooks.md) — Trigger local script notifications or interceptions at key points such as sub-agent completion
- [Agent Skills](./skills.md) — Inject specialized knowledge and workflows into sub-agents
