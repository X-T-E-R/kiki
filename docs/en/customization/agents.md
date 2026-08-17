# Agents and Sub-Agents

Every session in Kimi Code CLI is driven by a **main Agent**. The main Agent understands the user's intent, plans steps, calls tools, and when needed dispatches **sub-agents** to handle more focused sub-tasks — for example, exploring an unfamiliar codebase, reviewing multiple implementations in parallel, or planning a large refactor without touching the main context.

A sub-agent receives a task description from the main Agent, works in its own isolated context, and then returns its conclusions. It does not communicate with the user directly, and its intermediate reasoning and tool call records do not mix into the main Agent's history.

## Built-in Sub-Agents

Kimi Code CLI includes three built-in sub-agents, ready to use out of the box, each aimed at a different task shape:

- **`coder`**: The default sub-agent — a general-purpose software engineering assistant that can read and write files, execute commands, search code, and land concrete changes.
- **`explore`**: Dedicated to codebase exploration; performs read-only operations only and does not modify any files. Ideal for quickly searching, reading, and summarizing a repository without touching files.
- **`plan`**: Dedicated to implementation planning and architecture design; even shell commands are not available, keeping the focus on "figuring out how to do something" rather than "actually doing it."

A `coder` sub-agent shares most of the main Agent's tool set: it can run shell commands in the background, maintain todo lists, enter Plan mode, invoke Agent Skills, and dispatch its own nested sub-agents when a task decomposes naturally. If it finishes its turn while background tasks are still running, its run only reports completion after those tasks settle, so the parent receives the result after the underlying work has actually finished.

The top-level [`disabled_builtin_profiles`](../configuration/config-files.md#top-level-fields) setting removes named built-in profiles (`agent`, `coder`, `explore`, or `plan`) from discovery and dispatch. Disabling the default `agent` profile is ignored with a warning; a file profile that shares a name with another disabled built-in no longer needs `override: true`.

## How to Invoke

Sub-agents are scheduled automatically by the main Agent — based on task complexity, context consumption, and sub-task independence, they are dispatched at the right moment without the user having to specify one.

Each dispatch is presented in the terminal as an approval request (unless it matches an allow rule or YOLO mode is active), giving you a chance to review the task description. You can also instruct the main Agent directly in conversation to use a specific sub-agent, for example: "Use explore to map out the relevant files before making any changes."

Sub-agents support running in the background: results are automatically returned to the main Agent upon completion, with no manual polling needed. You can also call back an existing sub-agent instance to continue the same task.

## Codex-style collaboration adapter

The `agent-collaboration` experiment adds a Codex-style adapter over the same sub-agent and background-task lifecycle. Enable `KIMI_CODE_EXPERIMENTAL_AGENT_COLLABORATION=1`; `[agents] enabled = false` can disable it without changing the experiment flag. This is an adapter, not complete Codex compatibility.

The coordinating `agent` and `coder` profiles receive six snake-case tools: `spawn_agent`, `list_agents`, `wait_agent`, `followup_task`, `interrupt_agent`, and `send_message`. `spawn_agent` always starts asynchronously with fresh context and accepts only `fork_turns = "none"`; it does not copy parent conversation history. Names must match `^[a-z0-9_]+$`, cannot be `root`, and remain unique for the session.

Management targets are an exact `task_name` or `agent_id`, not a relative or hierarchical path. Each caller can list and manage only the named agents it created directly; a sibling or another caller's child is not a valid target:

- `list_agents` returns named agents in ascending `task_name` order.
- `wait_agent` waits 30 seconds by default and accepts `timeout_ms` from 10 seconds to 1 hour.
- `followup_task` starts exactly one new turn on the same idle agent identity. It rejects a running target and does not queue or inject a message.
- `interrupt_agent` stops only the current named turn. The same agent can be continued afterward.
- `send_message` durably queues a message for a named agent without starting, steering, or interrupting its turn. A running agent receives queued messages at its next step boundary; an idle agent is not woken and receives them when a later turn reaches that boundary.

The existing `Agent` and `AgentSwarm` tools are unchanged.

## Peer-thread communication

Peer-thread communication lets the main Agent coordinate existing Kimi Code sessions on the same local host, including sessions in other workspaces. It is separate from the experimental named-agent adapter above and is disabled by default. After opting in, the four tools `list_threads`, `read_thread`, `send_message_to_thread`, and `wait_threads` appear only on a session's main Agent, not its sub-agents.

A thread reference identifies a host, workspace, and session. `list_threads` returns the references needed for later calls; `read_thread` reads completed main-Agent turns without resuming a cold session; `send_message_to_thread` derives the source from the current main-Agent session and durably accepts a peer-attributed message for another thread; and `wait_threads` waits for activity from up to eight threads for at most 60 seconds. Messages cannot cross hosts.

True peer attribution requires the source thread's main Agent to call `send_message_to_thread`. REST and the `global.threads` Klient facade accept only target-addressed input and record it as user-origin, so an external client cannot claim a source thread.

Set `[thread_communication] enabled = true` in `config.toml` to opt in globally. Sending a message can resume a cold target session and consume model quota. Integrators can also persist an enable or disable override for an individual workspace; a workspace override cannot turn the feature on while the global switch is off. See the [Kiki runtime boundary](../guides/kiki-runtime.md#integrate-peer-thread-communication) for those interfaces.

## Context Isolation and Resource Cost

Each sub-agent has a fully independent context window. It can only see the task description explicitly passed by the main Agent and cannot see the main Agent's conversation history. The sub-agent's own intermediate reasoning and tool call records do not flow back; only the final result appears in the main Agent's context.

This isolation provides two benefits:

- **The main Agent's context stays lean** and is not filled with large volumes of exploratory logs during long sessions.
- **Multiple sub-agents can run in parallel** without interfering with each other.

Note that each sub-agent independently consumes model tokens. For simple tasks, there is no need to dispatch a sub-agent — the main Agent handles them more economically.

## Permission Inheritance

Sub-agent permission rules are inherited from the main Agent: "always allow" rules that the main Agent has accepted via `/permission` or through an approval dialog automatically propagate to all sub-agents it dispatches, so sub-agents do not need to re-approve the same types of tool calls. The `Agent` tool itself is allowed by default, enabling the main Agent to delegate multiple times without interrupting the user.

If you need a particular type of tool to be permanently unavailable inside sub-agents, tighten the corresponding permission rule on the main Agent.

## Custom Agents

Beyond the three built-in sub-agents, you can define your own agents as Markdown files. Each file describes one agent: the frontmatter (YAML metadata at the top of the file) declares its name, description, and tool access, and the file body is its system prompt. Custom agents can be delegated to as sub-agents — the main Agent discovers them automatically alongside the built-in ones — or selected as the main Agent at startup.

### Agent Locations

Kimi Code CLI discovers agent files by scope; more specific scopes take higher priority: **Explicit (`--agent-file`) > Project > Extra > User > Plugin > Built-in**. When two files define the same `name`, the higher-priority scope wins. Each directory is scanned recursively for `.md` files.

**User level** (applies to all projects):
- `$KIMI_CODE_HOME/agents/` (default: `~/.kimi-code/agents/`)
- `~/.agents/agents/`

The Kimi-specific user agent directory moves with `KIMI_CODE_HOME`, while the generic `~/.agents/agents/` directory stays under the real OS home so it can be shared across tools.

**Project level** (project root = the nearest directory containing `.git`, searching upward from the working directory):
- `.kimi-code/agents/`
- `.agents/agents/`

**Extra directories**: Declared via `extra_agent_dirs` at the top level of `config.toml`:

```toml
extra_agent_dirs = ["~/team-agents", ".agents/team-agents"]
```

Agent Markdown files under the user, project, and `extra_agent_dirs` roots are watched for filesystem changes. After an approximately 200 ms debounce, additions, edits, and deletions reload automatically, so a running session can dispatch a newly available role without `/reload` or a CLI restart. `$KIMI_CODE_HOME/SYSTEM.md` is watched the same way. An already-created `Agent` tool instance keeps a frozen snapshot of its displayed role descriptions, so that list can look stale, but dispatch resolution uses the reloaded profiles immediately.

**Plugin level**: directories declared in an enabled plugin's manifest `agents` field (when omitted, the `agents/` directory under the plugin root is picked up automatically); see [Plugin Agents](./plugins.md#plugin-agents). Plugin agents outrank only the built-in agents.

**Built-in agents** are distributed with the CLI and have the lowest priority. A directory-discovered file does not override a same-name built-in Agent unless its frontmatter declares `override: true`. A file loaded through `--agent-file` is treated as explicit launch intent, may override a same-name built-in Agent, outranks every directory scope, and applies to the current launch only. Separately, `$KIMI_CODE_HOME/SYSTEM.md` permanently overrides the default main agent's system prompt (it is not part of agent-file discovery); its precedence interactions are covered in the SYSTEM.md section below.

::: warning Trust model
Agent files are prompt configuration, and project-level files come from the repository itself — including repositories you have just cloned and do not trust yet. A project-scoped file can take over a built-in agent entirely: naming it `agent.md` with `override: true` replaces the **default main agent's whole system prompt**, and `coder.md` with `override: true` replaces the default sub-agent type. Unlike `AGENTS.md` content — which is injected into the prompt as reference data — an override file *is* the system prompt, and a file without a `tools` list keeps every tool. Review `.kimi-code/agents/` and `.agents/agents/` in unfamiliar repositories with the same caution you would apply to scripts, before running Kimi Code inside them.
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
| `override` | no | Whether this file may replace a same-name built-in Agent. Defaults to `false`; `--agent-file` is already explicit and does not require this field |
| `model_preference` | no | Legacy symbolic selector available only with the secondary-model experiment: `primary` inherits the caller's model binding, while `secondary` selects [`[secondary_model] model`](../configuration/config-files.md#secondary-model). Mutually exclusive with `model_alias` |
| `model_alias` | no | Exact, case-sensitive alias from `[models]`. Literal aliases named `primary` or `secondary` stay literal; this differs from the symbolic `model_preference` field |
| `thinking_effort` | no | Thinking effort requested when this profile starts as a new subagent. It resolves independently from the model selector |
| `service_tier` | no | Service tier requested on every LLM request this agent makes as a subagent: `auto`, `default`, `flex`, or `priority`. Only the `openai_responses` provider protocol encodes it into the request body; other protocols silently ignore it |
| `request_params` | no | Extra request parameters as a scalar map (string/number/boolean values only), sent with every request this subagent makes. OpenAI-family providers spread them into the request body (Kimi via `extra_body`) without overriding engine-generated fields; Anthropic ignores the map; a first-class field such as `service_tier` wins on collision. Keys are sent verbatim, so a provider may reject names it does not recognize |
| `tools` | no | Allowlist of tool names such as `Read` or `Bash`; MCP tools are matched with globs such as `mcp__github__*`. Accepts a YAML list or a comma-separated string (`tools: Read, Grep`). Omit to allow all tools; a lone `*` also allows all tools; an empty list (`tools: []`) disables all tools |
| `disallowedTools` | no | Denylist with the same syntax and matching rules, applied after `tools` |
| `subagents` | no | Allowlist of sub-agent names this agent may delegate to, with the same syntax as `tools` (YAML list or comma-separated string). Omit the field or use a lone `*` to allow every type; use an empty list (`subagents: []`) to prohibit all subagent dispatch; otherwise the explicit names form the allowlist |

Built-in and user tools match by exact, case-sensitive name; entries starting with `mcp__` match MCP tools as globs. Three entry shapes never match anything and are reported with a warning when the profile takes effect: a wildcard outside an `mcp__` pattern (a bare `*` in `disallowedTools` disables nothing), an `mcp__` literal that is not a full `mcp__<server>__<tool>` name (`mcp__github` matches nothing — use `mcp__github__*` for the whole server), and a name no registered or built-in tool has (usually a typo, such as `read` instead of `Read`).

The body is the agent's system prompt, and it is rendered as a template each time the prompt is built: `${var}` placeholders substitute live context values — unknown variables stay verbatim, a bare `$` is never special, and a variable with no context value renders as an empty string. `${base_prompt}` embeds the effective default system prompt (the built-in default, or your `SYSTEM.md` override when present), so a file can wrap the default behavior instead of replacing it. If the file replaces the default prompt but should still honor instructions contributed by enabled plugins, place `${plugin_sections}` where those instructions should appear. The available variables are listed in the SYSTEM.md section below.

Unknown fields are ignored, so newer files stay readable by older versions. Fields from other agent tools (such as Claude Code's `model` or OpenCode's `mode`) are ignored the same way, the comma-separated `tools` form keeps Claude Code-style agent files loadable, and a missing `name` falls back to the file name so OpenCode-style files load too — a minimal file with `description` and a body works across tools.

### Named profile routes (experimental)

A named route specializes an existing Agent without creating a new permission identity. Enable discovery at startup with `[experimental] agent-profile-routes = true` in `config.toml`, or set `KIMI_CODE_EXPERIMENTAL_AGENT_PROFILE_ROUTES=1`.

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

The required fields are `id`, `profile`, `description`, and `prompt_mode`. Optional fields are `whenToUse` plus `model_preference`, `model_alias`, `thinking_effort`, `service_tier`, `request_params`, `tools`, `disallowedTools`, and `subagents`. Unlike ordinary Agent files, route frontmatter is strict. Unknown fields, invalid types, a path/ID/profile mismatch, duplicate IDs in one source, and incompatible model selectors cause only that sidecar to be skipped with a coded diagnostic; the base profile and sibling routes still load.

`prompt_mode` always preserves the base prompt: `inherit` requires an empty body; `prepend` and `append` require a non-empty body and reject `${base_prompt}`; `wrap` requires `${base_prompt}` exactly once. There is no unguarded replace mode.

Routes can only narrow authority. Route `tools` is an additional allow layer (base **and** route must allow a tool), `disallowedTools` is added to the base denylist, and `subagents` is intersected with the base allowlist; `subagents: []` makes the route a leaf. Caller checks still use the base role, so a route cannot introduce a role the caller could not dispatch. Create and allowlist another base profile when broader authority is required.

An omitted request field inherits the base value. `service_tier: null` clears the base tier; another tier replaces it. `request_params: null` clears the base map; a mapping overlays scalar keys on it. A route-declared `model_alias` or `thinking_effort` is locked: a call may omit it or repeat the same value, but a conflict is rejected. A missing locked alias fails before Agent allocation and never uses the ordinary profile-alias fallback; dispatch also fails if the selected model cannot honor a locked effort exactly.

When enabled, both `Agent` and `AgentSwarm` show compact route entries filtered through the caller's base-role allowlist. Entries contain the route ID, base role, description/usage hint, model and effort defaults, and overridden field names—never the prompt body. Pass `route: reviewer.ui-k3`; omit `subagent_type` to derive `reviewer`, or pass that matching base explicitly. A mismatch is a coded error. There is no automatic ranking or silent fallback.

Resume never reselects or switches a route. The journal stores the canonical base role and route ID with the rendered prompt, layered tool policy, denylist, subagent restriction, model/effort locks, service tier, and request parameters. Existing routed Agents therefore resume from their snapshot even if the flag is disabled or the sidecar changes, disappears, or becomes invalid; those changes affect only new dispatches. Old journals remain compatible. In a mixed `AgentSwarm` call, `route` applies only to new item-based spawns; resumed entries keep their snapshots.

`model_alias` and `thinking_effort` are stable profile fields and `Agent` / `AgentSwarm` tool parameters; they do not require `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL`. For a newly spawned subagent, model and effort resolve independently in this order: tool parameter → profile field → `[subagent]` `default_model` / `default_effort` → caller binding. If an ordinary (non-route) profile selects a `model_alias` that is absent from `[models]`, the CLI warns and falls back to the caller's model and effort; an unknown alias passed explicitly as a tool parameter is an error.

Only the legacy tool parameter `model` (`primary` / `secondary`), the profile field `model_preference`, and the secondary recipe remain behind the secondary-model experiment. When enabled, the secondary recipe is inserted between the `[subagent]` defaults and the caller binding. When disabled, a profile's `model_preference` is ignored with a warning, while explicitly passing the `model` tool parameter returns a clear error. Resumed and retried subagents keep their persisted model and effort; passing binding fields on an `Agent` resume is rejected. A mixed `AgentSwarm` call applies them only to item-based new spawns.

Subagent model governance compares canonical model identities after resolving `[models]` aliases. It has three levels: `[subagent] deny_models` rejects explicit selections of listed models at every dispatch entry; `[secondary_model] enforce_pool = true` turns the configured pool into a hard allowlist while always retaining `primary`; and the default soft-pool mode keeps exact off-pool `model_alias` values working as an escape hatch. `[secondary_model] force = true` remains the strongest pin, binding every spawn to one model, and cannot be combined with `enforce_pool`. See the [configuration reference](../configuration/config-files.md#secondary-model) for fields and validation rules.

A file with invalid content discovered in a directory is skipped with a warning and does not affect other files. A file passed explicitly via `--agent-file` must be valid — otherwise the CLI reports the error and exits.

::: warning Note
`tools` and `disallowedTools` shape the tools shown to the model and are enforced again before execution. `subagents` works the same way: the `Agent` tool lists only the sub-agent types the caller may delegate to, and both `Agent` and `AgentSwarm` re-check the allowlist before dispatching; resuming an existing sub-agent is exempt. Permission rules remain a separate control for operations that require approval.
:::

Custom agents delegated as sub-agents run without the built-in sub-agent framing ("your final message is the entire handoff"). If you write an agent meant for delegation, state in the body that its last message should be the complete, self-contained result for the caller.

### Selecting the Main Agent

Two CLI flags select which agent drives a new session, in both print mode (`kimi -p`) and the interactive TUI:

- **`--agent <name>`**: Start the session with the named agent as the main Agent. The name can refer to a built-in agent or to any discovered file; an unknown name fails with an error listing the available agents.
- **`--agent-file <path>`**: Load one agent file at the highest priority for this launch and start with it. The flag accepts exactly one file: it cannot be repeated, and it cannot be combined with `--agent`.

Both flags only apply when starting a new session — neither can be combined with `--session`/`--continue`. The agent is bound at session creation, and resuming restores the bound agent automatically, so no flag is needed (or allowed) on resume.

For example:

```sh
kimi --agent reviewer
kimi -p --agent reviewer "Review the changes on this branch"
```

The bound agent is the session's identity: it is fixed at the session's first bind and cannot be switched later. In the TUI the flags bind only the startup session; a session created later in the same process (for example via `/new`) starts with the default agent.

For main-agent customization, reference `${base_prompt}` in the body so the environment, workspace-instruction, Skill, and plugin injections already present in the effective default prompt stay in effect. When you want to replace the default prompt but keep only plugin-contributed instructions, use `${plugin_sections}` instead. A body without `${base_prompt}` or `${plugin_sections}` owns the entire prompt and excludes plugin instructions, which fits self-contained sub-agents.

### Overriding the main agent's system prompt with SYSTEM.md

To override the main agent's system prompt permanently — without passing `--agent` or `--agent-file` on every launch — write a `$KIMI_CODE_HOME/SYSTEM.md` file (default: `~/.kimi-code/SYSTEM.md`; it moves with `KIMI_CODE_HOME`). While the file exists and is non-empty, it replaces the built-in default main agent's system prompt in full — and only the prompt: the description, tool set, and sub-agent delegation allowlist are inherited from the built-in defaults. SYSTEM.md takes effect in every launch mode, including interactive TUI sessions.

SYSTEM.md is a plain Markdown body — no frontmatter is required or read. A missing or empty file has no effect, and a read failure falls back to the built-in prompt with a warning. Explicit intent still outranks it: a project-scoped same-name agent file declaring `override: true` and any file passed via `--agent-file` take precedence, and selecting another agent with `--agent` bypasses it entirely. Within the user scope itself, SYSTEM.md wins over a same-name file discovered in the `agents/` directories.

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
| `${base_prompt}` | The default system prompt. Inside `SYSTEM.md` itself this is the built-in default; inside an agent file it is the effective default — the built-in default, or your `SYSTEM.md` override when present |
| `${plugin_sections}` | A complete Plugin Instructions block contributed by enabled plugins; empty when no enabled plugin contributes instructions |

Unknown variables stay verbatim, a bare `$` is never special, and a variable with no context value renders as an empty string. Four pre-composed blocks — `${windows_notes}`, `${additional_dirs_section}`, `${skills_section}`, and `${plugin_sections}` — render the matching built-in prompt section, or an empty string when it does not apply. The built-in default prompt already includes `${plugin_sections}`, so do not add it again when `${base_prompt}` already expands to that prompt. The variables are enough to rebuild the skeleton of the built-in prompt, for example:

```markdown
You are Kimi, running at ${cwd} on ${os}.

${agents_md}

${skills}

${plugin_sections}
```

## Instruction Files

Global Kimi-specific instructions can live at `$KIMI_CODE_HOME/AGENTS.md` (default: `~/.kimi-code/AGENTS.md`). When you relocate the data root with `KIMI_CODE_HOME`, this global instruction file moves with it. Generic cross-tool instructions can still live under `~/.agents/AGENTS.md` in the real OS home, and project-level instructions remain under the project tree, for example `.kimi-code/AGENTS.md` or `AGENTS.md`.

## Storage Location in the Session Directory

Sub-agent runtime state is persisted to the `agents/` subdirectory of the current session directory. Each sub-agent instance has its own directory, which contains a `wire.jsonl` file that records prompts, message history, and final state in chronological order. Background sub-agents also expose their lifecycle status through a `tasks/` subdirectory.

::: warning Note
Session directories, wire files, and task records are all local debug materials that may contain user prompts, command output, repository paths, tool return values, or traces of credentials. Do not commit these files directly to public repositories, issues, or chat logs; redact sensitive information before sharing.
:::

## Next steps

- [Hooks](./hooks.md) — Trigger local script notifications or interceptions at key points such as sub-agent completion
- [Agent Skills](./skills.md) — Inject specialized knowledge and workflows into sub-agents
