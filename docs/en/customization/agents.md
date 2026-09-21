# Agents and Sub-Agents

Every session in Kiki is driven by a **main Agent**. The main Agent understands the user's intent, plans steps, calls tools, and when needed dispatches **sub-agents** to handle more focused sub-tasks — for example, exploring an unfamiliar codebase, reviewing multiple implementations in parallel, or planning a large refactor without touching the main context.

A sub-agent receives a task description from the main Agent, works in its own isolated context, and then returns its conclusions. It does not communicate with the user directly, and its intermediate reasoning and tool call records do not mix into the main Agent's history.

New to Kiki's agent system? Start with [Agent profiles: concepts and design](./agent-profiles.md) — it explains what a profile is, where the files live, and when changes take effect. This page is the field and behavior reference.

## Built-in Sub-Agents

Fresh installations include the main `agent` profile and two subagent profiles:

- **`general`**: The default subagent — a general-purpose assistant that can read and write files, execute commands, and search code, without dispatching more children.
- **`explore`**: Dedicated to read-only codebase exploration, searching, and summarizing.

The top-level [`skip_builtin_profile_installation`](../configuration/config-files.md#top-level-fields) setting skips installing named built-in templates under `agents/builtin/`. It does not disable or delete existing copies. To hide installed profiles from subagent discovery and dispatch, use `disabled_named_profiles`; the default main `agent` binding remains available.

## How to Invoke

Sub-agents are scheduled automatically by the main Agent — based on task complexity, context consumption, and sub-task independence, they are dispatched at the right moment without the user having to specify one.

Each dispatch is presented in the terminal as an approval request (unless it matches an allow rule or YOLO mode is active), giving you a chance to review the task description. You can also instruct the main Agent directly in conversation to use a specific sub-agent, for example: "Use explore to map out the relevant files before making any changes."

Sub-agents support running in the background: results are automatically returned to the main Agent upon completion, with no manual polling needed. You can also call back an existing sub-agent instance to continue the same task.

## Named child agents

The default v2 engine (Kiki desktop and `kiki` CLI/TUI) gives the main `agent` profile three child-agent tools with no experiment flag: `AgentRun`, `AgentList`, and `AgentSend`. Built-in subagent profiles do not receive them. Each caller can list and message only the children it created directly; a grandchild or another caller's child is not a valid target. The retired `AgentSwarm` callable tool is unavailable for new calls, but historical swarm child records remain readable.

`AgentRun` launches a new child or continues an existing one. Every call requires `prompt` and a short 3–5 word `description` for UI display. New launches can also set `profile` (defaults to `[subagent].default_profile`, normally `general`; an explicit blank config value requires a target), `profile_file` (an explicit subagent role Markdown file, absolute or workspace-relative; it is a role definition, not a shared prompt template, and is mutually exclusive with `profile`, `route`, and `resume`), `route`, `name`, `background`, `model_alias`, and `effort`. The `allow_model_change` flag is meaningful only on `resume` with an explicit `model_alias`; it is required when that alias resolves to a different canonical model. Pass `name` when you expect to address the same child again; names must match `^[a-z0-9_]+$`, cannot be `root`, and stay unique for the session. To continue a direct child, set `resume` to its name or agent id; it rejects `name`, `profile`, `profile_file`, and `route`. Omit `effort` to keep the saved effort, or pass it to apply on the next idle run. Omit `model_alias` to keep the saved model; changing it to a different canonical model requires `allow_model_change: true`, while an alias resolving to the same canonical model is a no-op. Caller, role, route, and executor restrictions remain enforced. An external executor that does not support changing a resumed thread binding returns an error instead of recreating the thread or executor. A new launch binds its model from the `model_alias` parameter or the pin on the effective profile, route, or caller lease, with the parameter winning; when neither names one, the call fails with `model.not_configured` and no child is created. Effort resolves separately through tool `effort` → profile `thinking_effort` → the bound model's own default. An unknown `model_alias` is an error. To continue work in the background, set `background: true`; otherwise the parent waits for the result. Agent tasks time out after 2 hours by default; configure the global limit through `[subagent] timeout_ms` or `KIMI_SUBAGENT_TIMEOUT_MS` (`0` disables it), and print mode defaults to no timeout. There is no per-call timeout or arbitrary provider-parameter passthrough.

`AgentList` returns direct children, including retained historical swarm entries. Default `include_finished=false` lists running children and children with no tracking task; pass `true` when you need children whose latest background task has already finished or failed. At most 50 entries are returned, running first.

`AgentSend` queues a mailbox message that is delivered as early as possible: when the child is running, the message is steered into its active turn at the next step boundary; when the child is idle, it stays queued and is read at the beginning of the child's next step. Address the child by `name` or agent id.

`AgentNotify` runs in the opposite direction and is available only to subagents: it queues a fire-and-forget message in the parent agent's mailbox, injected into the parent's active turn at the next step boundary (or read when the parent next runs). The main agent has no parent and never receives this tool. The switch `[agents] notify_parent = false` in `config.toml` turns it off globally; it defaults to on.

## Peer-thread communication

Peer-thread communication lets the main Agent coordinate existing Kiki sessions on the same local host, including sessions in other workspaces. It is separate from the child-agent tools above and is disabled by default. After opting in, the four tools `ThreadList`, `ThreadRead`, `ThreadSend`, and `ThreadWait` appear only on a session's main Agent, not its sub-agents.

A thread reference identifies a host, workspace, and session. `ThreadList` returns the references needed for later calls; `ThreadRead` reads completed main-Agent turns without resuming a cold session; `ThreadSend` derives the source from the current main-Agent session and durably accepts a peer-attributed message for another thread; and `ThreadWait` waits for activity from up to eight threads for at most 60 seconds. Messages cannot cross hosts.

True peer attribution requires the source thread's main Agent to call `ThreadSend`. REST and the `global.threads` Klient facade accept only target-addressed input and record it as user-origin, so an external client cannot claim a source thread.

Set `[thread_communication] enabled = true` in `config.toml` to opt in globally. Sending a message can resume a cold target session and consume model quota. Integrators can also persist an enable or disable override for an individual workspace; a workspace override cannot turn the feature on while the global switch is off. See [Server API](../server/rest-api.md#session-leases-and-peer-threads) for those interfaces.

## Context Isolation and Resource Cost

Each sub-agent has a fully independent context window. It can only see the task description explicitly passed by the main Agent and cannot see the main Agent's conversation history. The sub-agent's own intermediate reasoning and tool call records do not flow back; only the final result appears in the main Agent's context.

This isolation provides two benefits:

- **The main Agent's context stays lean** and is not filled with large volumes of exploratory logs during long sessions.
- **Multiple sub-agents can run in parallel** without interfering with each other.

Note that each sub-agent independently consumes model tokens. For simple tasks, there is no need to dispatch a sub-agent — the main Agent handles them more economically.

## Permission Inheritance

Sub-agent permission rules are inherited from the main Agent: "always allow" rules that the main Agent has accepted via `/permission` or through an approval dialog automatically propagate to all sub-agents it dispatches, so sub-agents do not need to re-approve the same types of tool calls. The `AgentRun` tool itself is allowed by default, enabling the main Agent to delegate multiple times without interrupting the user.

If you need a particular type of tool to be permanently unavailable inside sub-agents, tighten the corresponding permission rule on the main Agent.

## Custom Agents

Beyond the shipped profiles, you can define your own agents as Markdown files. Each file describes one agent: the frontmatter (YAML metadata at the top of the file) declares its name, description, and tool access, and the file body is its system prompt. Custom agents can be delegated to as sub-agents — the main Agent discovers them automatically alongside the built-in ones — or selected as the main Agent at startup.

### Capability visibility

The GUI's main-agent selector uses the effective profiles for the current workspace or working directory. Main profiles have `main: true`. A file overriding a built-in profile inherits its `main` value when omitted; an explicit `main: false` is preserved. `SYSTEM.md` therefore retains the default `agent` profile's main-agent status without extra frontmatter. Removing the default profile from subagent discovery does not remove its main binding or discard its effective file overrides. Other disabled profiles remain unavailable. See [Agent file format](#agent-file-format) for the field definitions.

In **Settings → Agents**, select a workspace to inspect its default main profile, effective source, and subagent capabilities. File-backed profiles can be edited at their displayed source; editing common fields in a legacy `SYSTEM.md` adds frontmatter while preserving the prompt body. A selected profile that later becomes unavailable stays visible with a diagnostic so you can choose another.

### Rebuilding a session context

After editing prompt sources, open the profile selector in the session composer and choose **Rebuild context**. After confirmation, Kiki reloads the current profile, prompt-field overrides, Agent Skills, `AGENTS.md` instructions, and plugin prompt/session-start injections from disk, reconciles other runtime context injections, then uses the rebuilt snapshot for later requests. Conversation messages are preserved. The action is unavailable while a turn is running; wait for the session to become idle and try again.

Open **Dispatch capabilities** in settings, next to the new-session workspace selector, or in a session's right rail to inspect subagent profiles, routes, executors, and default model and thinking-effort sources. Default configuration validity and permission to launch are shown separately. The draft panel is a planning reference, not a real-time launch check.

The session panel reflects the current agent's tool directory, including [Plan mode's read-only research restriction](../reference/tools.md#plan-mode) and launch refusal reasons. It does not check external provider health. If a selected model, profile, or thinking effort becomes unavailable, choose a valid value before sending; a loading state or catalog error alone does not invalidate a saved choice.

### Agent Locations

Kiki discovers agent files by scope; more specific scopes take higher priority: **Explicit (`--agent-file`) > Project > Extra > ordinary User files > Built-in copies (user scope) > Plugin**. When two files define the same `name`, the higher-priority scope wins. Each directory is scanned recursively for `.md` files.

**User level** (applies to all projects):
- `$KIKI_HOME/agents/` (default: `~/.kiki/agents/`)
- `~/.agents/agents/`

The Kiki-specific user agent directory moves with `KIKI_HOME`, while the generic `~/.agents/agents/` directory stays under the real OS home so it can be shared across tools.

**Project level** (project root = the nearest directory containing `.git`, searching upward from the working directory):
- `.kiki/agents/`
- `.agents/agents/`

**Extra directories**: Declared via `extra_agent_dirs` at the top level of `config.toml`:

```toml
extra_agent_dirs = ["~/team-agents", ".agents/team-agents"]
```

Agent Markdown files under the user, project, and `extra_agent_dirs` roots are watched for filesystem changes. After an approximately 200 ms debounce, additions, edits, and deletions reload automatically, so a running session can dispatch a newly available role without `/reload` or a CLI restart. `$KIKI_HOME/SYSTEM.md` is watched the same way. An already-created `AgentRun` tool instance keeps a frozen snapshot of its displayed role descriptions, so that list can look stale, but dispatch resolution uses the reloaded profiles immediately.

**Plugin level**: directories declared in an enabled plugin's manifest `agents` field (when omitted, the `agents/` directory under the plugin root is picked up automatically); see [Plugin Agents](./plugins.md#plugin-agents). Plugin definitions have lower priority than the user files, including installed built-in copies.

**Built-in copies** are installed under `$KIKI_HOME/agents/builtin/` and loaded in the user scope. They are scanned after ordinary files in both user directories, so a same-name user definition always wins without `override: true`, regardless of filename order or when it was installed. Duplicate-name diagnostics identify both paths. A file loaded through `--agent-file` outranks every directory scope and applies to the current launch only. Separately, `$KIKI_HOME/SYSTEM.md` permanently overrides the default main agent's system prompt; its precedence interactions are covered below.

::: warning Trust model
Agent files are prompt configuration, and project-level files come from the repository itself — including repositories you have just cloned and do not trust yet. A project-scoped file can take over a built-in agent entirely: a file named `agent.md` can replace the **default main agent's whole system prompt**, and `general.md` can replace the default subagent type. This does not require `override: true`. Unlike `AGENTS.md` content — which is injected into the prompt as reference data — an override file *is* the system prompt, and a file without a `tools` list keeps every tool. Review `.kiki/agents/` and `.agents/agents/` in unfamiliar repositories with the same caution you would apply to scripts, before running Kiki inside them.
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

| Field | Required | Description |
| --- | --- | --- |
| `name` | no | Unique identifier in kebab-case. Defaults to the file name without its extension (`review.md` → `review`); a file whose resolved name is missing or not kebab-case is skipped with a warning |
| `description` | yes | What the agent does. Shown to the main Agent when it picks a sub-agent, so write it to guide delegation decisions |
| `whenToUse` | no | Extra hint describing when the agent should be used |
| `override` | no | Legacy override metadata, default `false`. File precedence determines the winner; replacing an installed built-in copy with a same-name user file does not require this field |
| `main` | no | Curation flag. When `true`, this profile is a main-agent candidate and is omitted from the `AgentRun` tool's default role list. It is not an authorization gate: `--agent`, `--agent-file`, MCP, and the SDK can still bind any catalog name |
| `delegation_notice` | no | `auto` (default) injects a position-based handoff notice when this profile runs as a sub-agent or an independent host agent; `off` skips it. Main-agent binds never inject |
| `model_alias` | no | Exact, case-sensitive alias from `[models]`. This is the profile's model pin: a dispatch that names no model binds this one, and a profile without it can only be dispatched with an explicit `model_alias` |
| `thinking_effort` | no | Thinking effort requested when this profile starts as a new subagent. It resolves independently from the model selector |
| `executor` | no | Executor id from `agent-executors.toml`; omit it to use the native engine. Named-child dispatch uses this binding from both in-process and external delegation surfaces. For an external delegation, harness approval requests are exposed through that root's `interactions` / `respond` operations and scoped to its own children. Example profiles live in the repository under `docs/examples/agent-profiles/external-harnesses/` |
| `allowed_models` | no | Optional allowlist of model aliases this role may bind. YAML list or comma-separated string, same syntax as `tools`. When present and non-empty, the bound model must be a member. Comparisons use canonical model identity, so a bare alias matches a provider-qualified name. This list can only **narrow** what the machine already permits; it cannot re-permit a model listed in `[subagent].deny_models` or in this file's `deny_models`. A single-item list is the way to hard-pin a role to one alias — prefer it over a route sidecar whose only delta is a pinned model. Omit the field or use `"*"` to impose no extra allowlist; `[]` allows no models and blocks automatic dispatch. This also applies inside caller leases and `spawn_constraints`. Replace an old empty list with `"*"` if it was intended to mean unrestricted |
| `deny_models` | no | Optional denylist of model aliases this role must not bind, same syntax as `allowed_models`. Auto-dispatch is rejected; an explicit human choice is admitted with a one-time warning. Machine `[subagent].deny_models` still rejects every path, including humans |
| `allowed_efforts` | no | Optional allowlist of thinking efforts this role may bind, YAML list or comma-separated string. Role-level values intersect with a matching `model_profiles` entry. Auto-dispatch (`AgentRun`) is rejected when the resolved effort is outside the intersection; an explicit human choice is admitted with a one-time warning |
| `model_profiles` | no | Per-alias run recipe for this role. YAML list of mappings only. Required `alias`; optional `when`, `thinking_effort`, `allowed_efforts`, `prompt_mode` (`prepend` / `append` / `wrap`), `prompt`, `prompt_overrides`, `service_tier`, `request_params`, `context_budget`, and `max_completion_tokens`. `when` is shown to the parent dispatcher in the `AgentRun` tool description and is never added to the child prompt. `prompt_mode` + `prompt` compose onto this role's body before the model cognition overlay; `wrap` uses `${parent_prompt}` (or its alias `${base_prompt}`) exactly once. Entries whose alias is missing from this machine's `[models]` table are omitted from the tool description and do not apply. Duplicate aliases stay listed; overlay matching uses the first entry whose alias resolves |
| `prompt_overrides` | no | Prompt field overrides for this profile, with optional `files` and `fields`. This layer overrides global and model values; a matching `model_profiles[].prompt_overrides` entry overrides it. See [`prompt`](../configuration/config-files.md#prompt) |
| `system_prompt_mode` | no | Prompt-body mode: `replace` (default), `prepend`, `append`, or `inherit`. `inherit` requires an empty body and a non-empty `prompt_overrides`; it retains the lower-priority same-name profile definition while applying this file's field overrides |
| `service_tier` | no | Profile default service tier: `auto`, `default`, `flex`, or `priority`. A configured `[models."<alias>"].service_tier` takes precedence on every request. Only the `openai_responses` provider protocol encodes it into the request body; other protocols silently ignore it |
| `request_params` | no | Extra request parameters as a scalar map (string/number/boolean values only), sent with every request this subagent makes. OpenAI-family providers spread them into the request body (Kimi via `extra_body`) without overriding engine-generated fields; Anthropic ignores the map; a first-class field such as `service_tier` wins on collision. Keys are sent verbatim, so a provider may reject names it does not recognize. Typed provider parameters such as `temperature` and `top_p` belong here for the `kimi` provider; pass them only if the underlying model supports them |
| `context_budget` | no | Token budget for this profile's context window. Declared only as a cap — must not exceed the bound model's `max_context_size`. The effective value is the minimum of every declared layer; declared limits can shrink the budget but never widen it past the model's real capacity |
| `max_completion_tokens` | no | Per-completion output cap (token budget for a single LLM step). Declared only as a cap; the effective value is the minimum of every declared layer. Distinct from the input limit and the total context window — see [Configuration files](../configuration/config-files.md#models) |
| `tools` | no | Allowlist of tool names such as `Read` or `Bash`; MCP tools are matched with globs such as `mcp__github__*`. Accepts a YAML list or a comma-separated string (`tools: Read, Grep`). Omit to allow all tools; a lone `*` also allows all tools; an empty list (`tools: []`) disables all tools |
| `disallowedTools` | no | Denylist with the same syntax and matching rules, applied after `tools` |
| `disabled-tool-groups` | no | Denylist of built-in tool groups, YAML list or comma-separated string, such as `disabled-tool-groups: [shell, web]`. Every built-in tool in a listed group is withheld unless the tool is named explicitly in `tools`; an unknown group name fails the file at load. Precedence inside one profile, most specific first: `disallowedTools` (a denied tool stays denied) > `tools` (an explicitly listed tool survives a disabled group) > `disabled-tool-groups`. Only built-in tools belong to groups — MCP and user tools are never matched. The groups are `agent` (`AgentRun`, `AgentList`, `AgentSend`, `AgentNotify`), `board` (`BoardRead`, `BoardWrite`), `cron` (`CronCreate`, `CronList`, `CronDelete`), `fsRead` (`Read`, `ReadMediaFile`, `Glob`, `Grep`), `fsWrite` (`Write`, `Edit`), `goal` (`CreateGoal`, `GetGoal`, `UpdateGoal`, `SetGoalBudget`), `plan` (`EnterPlanMode`, `ExitPlanMode`, `TodoList`), `question` (`AskUserQuestion`), `shell` (`Bash`), `skill` (`Skill`), `task` (`TaskList`, `TaskOutput`, `TaskStop`, `TaskWait`), `thread` (`ThreadList`, `ThreadRead`, `ThreadSend`, `ThreadWait`), `toolSelect` (`SelectTools`), and `web` (`WebSearch`, `FetchURL`) |
| `subagents` | no | Allowlist of sub-agent names this agent may delegate to, with the same syntax as `tools` (YAML list or comma-separated string). Omit the field or use a lone `*` to allow every type; use an empty list (`subagents: []`) to prohibit all subagent dispatch; otherwise the explicit names form the allowlist |

`model_profiles` is a YAML list of mappings. A string, scalar, or mapping at the top level is invalid, because every entry needs an `alias`. `when` is optional; the rest of the fields are optional too. Example:

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

Match `model_profiles` by canonical model identity. Resolve the model alias configuration, including its `overrides`, first; then apply model alias → top-level profile → matching `model_profiles` entry. Merge `request_params` by key and use the last explicit `service_tier`. Treat `context_budget` and `max_completion_tokens` as limits: take the smallest declared value across layers, within the model's capacity and output cap. Omitting a limit adds no restriction. Only top-level `thinking_effort` requires the selected model to match the profile's default `model_alias`; other profile parameters are not conditional on that match.

The model cognition overlay (`[models."<alias>".cognition]`) is the supported way to add per-model prompt text — `model_profiles.prompt_mode` and `prompt` extend the role body itself, while the alias cognition extends the model's system prompt.

`allowed_models` and `deny_models` only narrow. Machine `[subagent].deny_models` always wins, even when the role allowlists the same alias. A single-item `allowed_models` hard-pins the role; route sidecars cannot declare either field.

```yaml
allowed_models:
  - fast-model
  - k3-review
deny_models:
  - heavy-model
```

```yaml
# Hard-pin this role to one alias:
allowed_models: [fast-model]
```

Pair an allowlist with the `model_alias` you intend to pin. A profile that declares `allowed_models` but no `model_alias` still loads with a warning, and a dispatch that names no model fails closed rather than falling back to anything the allowlist would have to judge.

Built-in and user tools match by exact, case-sensitive name; entries starting with `mcp__` match MCP tools as globs. Three entry shapes never match anything and are reported with a warning when the profile takes effect: a wildcard outside an `mcp__` pattern (a bare `*` in `disallowedTools` disables nothing), an `mcp__` literal that is not a full `mcp__<server>__<tool>` name (`mcp__github` matches nothing — use `mcp__github__*` for the whole server), and a name no registered or built-in tool has (usually a typo, such as `read` instead of `Read`).

The body is the agent's system prompt, and it is rendered as a template each time the prompt is built: `${var}` placeholders substitute live context values — unknown variables stay verbatim, a bare `$` is never special, and a variable with no context value renders as an empty string. `${parent_prompt}` (alias `${base_prompt}`) embeds the implicit parent for this file: the effective default system prompt in an agent file, the built-in default inside `SYSTEM.md`, or the base profile in a route. `${builtin_prompt}` is always the built-in default, even when `SYSTEM.md` exists. If the file replaces the default prompt but should still honor instructions contributed by enabled plugins, place `${plugin_sections}` where those instructions should appear. The available variables are listed in the SYSTEM.md section below.

Unknown fields are ignored, so newer files stay readable by older versions. Fields from other agent tools (such as Claude Code's `model` or OpenCode's `mode`) are ignored the same way, the comma-separated `tools` form keeps Claude Code-style agent files loadable, and a missing `name` falls back to the file name so OpenCode-style files load too — a minimal file with `description` and a body works across tools.

### Named profile routes (experimental)

A named route specializes an existing Agent without creating a new permission identity. Enable discovery at startup with `[experimental] agent-profile-routes = true` in `config.toml`, or set `KIKI_EXPERIMENTAL_AGENT_PROFILE_ROUTES=1`.

Keep the base profile at `agents/<role>.md`. Put routes under `agents/.routes/<role>/<route>.md`; the canonical ID is `<role>.<route>`, with every segment in lowercase kebab-case. For example, `agents/.routes/reviewer/ui-k3.md` defines `reviewer.ui-k3`:

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
subagents: [explore]
service_tier: priority
request_params:
  temperature: 0.2
---

Focus on interaction regressions, accessibility, and visual consistency.
```

The required fields are `id`, `profile`, `description`, and `prompt_mode`. Optional fields are `whenToUse` plus `model_alias`, `thinking_effort`, `service_tier`, `request_params`, `tools`, `disallowedTools`, and `subagents`. Unlike ordinary Agent files, route frontmatter is strict. Unknown fields, invalid types, a path/ID/profile mismatch, duplicate IDs in one source, and incompatible model selectors cause only that sidecar to be skipped with a coded diagnostic; the base profile and sibling routes still load. Agent-file-only fields such as `model_profiles`, `allowed_models`, and `deny_models` are unknown here and skip the sidecar. A route may pin `model_alias`, but that pin is still checked against the base profile's `allowed_models` / `deny_models`.

`prompt_mode` always preserves the base prompt: `inherit` requires an empty body; `prepend` and `append` require a non-empty body and reject `${parent_prompt}` / `${base_prompt}`; `wrap` requires `${parent_prompt}` or `${base_prompt}` exactly once. There is no unguarded replace mode.

If a route declares `tools`, `disallowedTools`, or `subagents`, that field replaces the base value entirely. Omit the field to inherit the base. `subagents: []` makes the route a leaf. Caller checks still use the base role, so a route cannot introduce a role the caller could not dispatch. Create and allowlist another base profile when you need a different role identity.

An omitted request field inherits the base value. `service_tier: null` clears the base tier; another tier replaces it. `request_params: null` clears the base map; a mapping overlays scalar keys on it. A route-declared `model_alias` or `thinking_effort` is locked for automatic dispatch: `AgentRun` must omit it or repeat the same value; a conflict is rejected. A missing locked alias fails before Agent allocation and never uses the ordinary profile-alias fallback; dispatch also fails if the selected model cannot honor a locked effort exactly. In an already-bound session, an explicit human `/model` or effort change is admitted with a one-time warning; the lock stays on the snapshot.

When enabled, `AgentRun` shows compact route entries filtered through the caller's base-role allowlist. Entries contain the route ID, base role, description/usage hint, model and effort defaults, and overridden field names—never the prompt body. Pass `route: reviewer.ui-k3`; omit `profile` to derive `reviewer`, or pass that matching base explicitly. A mismatch is a coded error. There is no automatic ranking or silent fallback.

Resume never reselects or switches a route. The journal stores the canonical base role and route ID with the rendered prompt, layered tool policy, denylist, subagent restriction, model/effort locks, service tier, and request parameters. Existing routed Agents therefore resume from their snapshot even if the flag is disabled or the sidecar changes, disappears, or becomes invalid; those changes affect only new dispatches. Old journals remain compatible.

A newly spawned subagent binds its model from exactly two sources: the `model_alias` tool parameter, or the `model_alias` pin on the effective profile, route, or caller lease. The dispatch wins when both are present. When neither names a model, the spawn fails with `model.not_configured` and no child is created — a subagent never runs on its caller's model, and no configured default fills the gap. Effort resolves separately and may stay unset: explicit `effort` on the tool call → `thinking_effort` declared on the profile, but only when the bound alias matches the profile's pinned `model_alias` (canonical identity) → the bound model's own default. An unknown alias is an error whether it came from the dispatch or from a profile pin.

On `AgentRun` resume the saved binding is kept when you omit both `model_alias` and `effort`. A `model_alias` that resolves to the same canonical model is a no-op. Changing only `effort` applies the new value to the next idle run and keeps the saved model. Changing `model_alias` to a different canonical model requires `allow_model_change: true`; when `effort` is also omitted in that case, the target model's own default effort is re-resolved from scratch — the previous effort is not carried over. An explicit `effort` that the selected model cannot honor is rejected, while a non-strict unknown capability is passed through to the underlying protocol. Caller, role, route, and executor restrictions remain enforced; an external executor that does not support changing a resumed thread binding returns an error instead of recreating the thread or executor.

Omit `model_alias` and `effort` to use the selected target's defaults when launching a new child. `AgentRun` lists configured models allowed by the caller's effective profiles, leases, routes, and model constraints. Each profile or route has its own allowed list; an alias shown for another target does not make it available to this one. Explicit overrides are checked before a child is created. To keep a role within a chosen model pool, declare `allowed_models` as well as its default `model_alias`; `model_profiles` supplies recommendations without granting access. Route tier overrides, including `service_tier: null`, do not clear a configured model-level tier.

Subagent model governance compares canonical model identities after resolving `[models]` aliases. Machine `[subagent] deny_models` rejects listed models at every dispatch entry. A role file may further narrow that set with `allowed_models` and `deny_models`; those lists never widen machine permission, and a single-item `allowed_models` is the hard pin for that role. See the [configuration reference](../configuration/config-files.md#subagent) for fields and validation rules.

A file with invalid content discovered in a directory is skipped with a warning and does not affect other files. A file passed explicitly via `--agent-file` must be valid — otherwise the CLI reports the error and exits.

::: warning Note
`tools` and `disallowedTools` shape the tools shown to the model and are enforced again before execution. `subagents` works the same way: the `AgentRun` tool lists only the sub-agent types the caller may delegate to and re-checks the allowlist before dispatching; continuing an existing sub-agent is exempt. Permission rules remain a separate control for operations that require approval.
:::

When a custom agent runs as a dispatched subagent, Kiki prepends a short handoff notice: the last message is the complete deliverable for the caller. An independent host invocation (MCP / SDK) gets a different notice: there is no parent agent. Main-agent binds inject nothing. Put `${delegation_context}` in the body to place the notice; otherwise it is prepended. Set `delegation_notice: off` on the profile, or `[agents.delegation] sub = false` / `independent = false` in `config.toml`, to skip it. To replace the text, override `delegation.sub.notice` or `delegation.independent.notice` through [`PromptOverrides`](../configuration/config-files.md#prompt). The former delegation `.md` path values are no longer accepted; the boolean gates and `delegation_notice: off` always win over text overrides.

### Selecting the Main Agent

Two CLI flags select which agent drives a new session, in both print mode (`kiki -p`) and the interactive TUI:

- **`--agent <name>`**: Start the session with the named agent as the main Agent. The name can refer to a built-in agent or to any discovered file; an unknown name fails with an error listing the available agents.
- **`--agent-file <path>`**: Load one agent file at the highest priority for this launch and start with it. The flag accepts exactly one file: it cannot be repeated, and it cannot be combined with `--agent`.

Both flags only apply when starting a new session — neither can be combined with `--session`/`--continue`. The agent is bound at session creation, and resuming restores the bound agent automatically, so no flag is needed (or allowed) on resume.

In print mode, an explicit `--model` takes precedence over the selected profile's `model_alias`. Without `--model`, the engine uses the profile pin first and `default_model` only when no profile model is set. A pinned profile therefore works without a global default; unlike main agents, subagents never fall back to `default_model`.

For example:

```sh
kiki --agent reviewer
kiki -p --agent reviewer "Review the changes on this branch"
```

These CLI flags select the startup session's profile; they do not change a resumed session. The GUI can request a main-profile switch when submitting the next prompt, subject to the current binding's constraints. A session created later in the same TUI process (for example via `/new`) starts with the default agent.

For main-agent customization, reference `${parent_prompt}` or `${base_prompt}` in the body so the environment, workspace-instruction, Skill, and plugin injections already present in the effective default prompt stay in effect. `${builtin_prompt}` is the stock default even when `SYSTEM.md` exists. When you want to replace the default prompt but keep only plugin-contributed instructions, use `${plugin_sections}` instead. A body without `${parent_prompt}` / `${base_prompt}` or `${plugin_sections}` owns the entire prompt and excludes plugin instructions, which fits self-contained sub-agents.

### Overriding the main agent's system prompt with SYSTEM.md

To override the default main agent permanently — without passing `--agent` or `--agent-file` on every launch — write a `$KIKI_HOME/SYSTEM.md` file (default: `~/.kiki/SYSTEM.md`; it moves with `KIKI_HOME`). A missing or empty file has no effect. Read or parse failures produce a path-specific diagnostic and retain that file's last good profile, if one was loaded in this process; other agent files still reload. Malformed YAML after an opening `---` is never reinterpreted as a legacy prompt. Repair the file to replace the retained profile, or remove it to drop the override. Without a last good version, the invalid override is skipped. SYSTEM.md takes effect in every launch mode, including interactive TUI sessions.

How the file is parsed depends on its first line:

- **Legacy body.** The file does not start with `---` followed by a YAML mapping. Only the prompt is replaced; description, tools, and the sub-agent allowlist stay on the built-in defaults. Frontmatter is not required or read.
- **Upgraded profile.** The file starts with `---` and that fence parses as a YAML mapping. It loads as a normal agent file named `agent`, with `override` forced on. Fields you omit (`tools`, `disallowedTools`, `subagents`) still copy the built-in defaults; fields you declare take effect.

Explicit intent still outranks it: a project-scoped same-name agent file declaring `override: true` and any file passed via `--agent-file` take precedence, and selecting another agent with `--agent` bypasses it entirely. Within the user scope itself, SYSTEM.md wins over a same-name file discovered in the `agents/` directories.

An upgraded `SYSTEM.md` may declare `prompt_overrides` in its frontmatter. With `system_prompt_mode: inherit`, leave the body empty and Kiki keeps the built-in `agent` prompt while applying only those fields. A legacy or upgraded replacement body remains authoritative and shadows built-in `system.*` section overrides, while `system.shared` and the applicable delegation notice stay outside that body. The complete format and precedence are documented under [`prompt`](../configuration/config-files.md#prompt).

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

Unknown variables stay verbatim, a bare `$` is never special, and a variable with no context value renders as an empty string. Four pre-composed blocks — `${windows_notes}`, `${additional_dirs_section}`, `${skills_section}`, and `${plugin_sections}` — render the matching built-in prompt section, or an empty string when it does not apply. The built-in default prompt already includes `${plugin_sections}`, so do not add it again when `${base_prompt}` already expands to that prompt. The variables are enough to rebuild the skeleton of the built-in prompt, for example:

```markdown
You are Kiki, running at ${cwd} on ${os}.

${agents_md}

${skills}

${plugin_sections}
```

## Instruction Files

Global Kiki-specific instructions can live at `$KIKI_HOME/AGENTS.md` (default: `~/.kiki/AGENTS.md`). When you relocate the data root with `KIKI_HOME`, this global instruction file moves with it. Generic cross-tool instructions can still live under `~/.agents/AGENTS.md` in the real OS home, and project-level instructions remain under the project tree, for example `.kiki/AGENTS.md` or `AGENTS.md`. The legacy `.kimi-code/AGENTS.md` path is not read.

## Storage Location in the Session Directory

Sub-agent runtime state is persisted to the `agents/` subdirectory of the current session directory. Each sub-agent instance has its own directory, which contains a `wire.jsonl` file that records prompts, message history, and final state in chronological order. Background sub-agents also expose their lifecycle status through a `tasks/` subdirectory.

::: warning Note
Session directories, wire files, and task records are all local debug materials that may contain user prompts, command output, repository paths, tool return values, or traces of credentials. Do not commit these files directly to public repositories, issues, or chat logs; redact sensitive information before sharing.
:::

## Next steps

- [Hooks](./hooks.md) — Trigger local script notifications or interceptions at key points such as sub-agent completion
- [Agent Skills](./skills.md) — Inject specialized knowledge and workflows into sub-agents
