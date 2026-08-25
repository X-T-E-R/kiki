# Agents and Sub-Agents

Every session in Kimi Code CLI is driven by a **main Agent**. The main Agent understands the user's intent, plans steps, calls tools, and when needed dispatches **sub-agents** to handle more focused sub-tasks — for example, exploring an unfamiliar codebase, reviewing multiple implementations in parallel, or planning a large refactor without touching the main context.

A sub-agent receives a task description from the main Agent, works in its own isolated context, and then returns its conclusions. It does not communicate with the user directly, and its intermediate reasoning and tool call records do not mix into the main Agent's history.

## Built-in Sub-Agents

Kimi Code CLI includes three built-in sub-agents, ready to use out of the box, each aimed at a different task shape:

- **`coder`**: The default sub-agent — a general-purpose software engineering assistant that can read and write files, execute commands, search code, and land concrete changes.
- **`explore`**: Dedicated to codebase exploration; performs read-only operations only and does not modify any files. Ideal for quickly searching, reading, and summarizing a repository without touching files.
- **`plan`**: Dedicated to implementation planning and architecture design; even shell commands are not available, keeping the focus on "figuring out how to do something" rather than "actually doing it."

A `coder` sub-agent shares most of the main Agent's tool set: it can run shell commands in the background, maintain todo lists, enter Plan mode, invoke Agent Skills, and wait on background tasks with `TaskWait`. It does not receive `AgentRun`, `AgentSwarm`, `AgentList`, or `AgentSend`; nested dispatch requires a custom profile that lists those tools. If it finishes its turn while background tasks are still running, its run only reports completion after those tasks settle, so the parent receives the result after the underlying work has actually finished.

The top-level [`disabled_builtin_profiles`](../configuration/config-files.md#top-level-fields) setting removes named built-in profiles (`agent`, `coder`, `explore`, or `plan`) from subagent discovery and dispatch. Disabling `agent` does not prevent the main agent from starting with its default binding. A file profile that shares a name with a disabled built-in no longer needs `override: true`.

## How to Invoke

Sub-agents are scheduled automatically by the main Agent — based on task complexity, context consumption, and sub-task independence, they are dispatched at the right moment without the user having to specify one.

Each dispatch is presented in the terminal as an approval request (unless it matches an allow rule or YOLO mode is active), giving you a chance to review the task description. You can also instruct the main Agent directly in conversation to use a specific sub-agent, for example: "Use explore to map out the relevant files before making any changes."

Sub-agents support running in the background: results are automatically returned to the main Agent upon completion, with no manual polling needed. You can also call back an existing sub-agent instance to continue the same task.

## Named child agents {#codex-style-collaboration-adapter}

The default v2 engine (Kiki desktop and `kimi` CLI/TUI) gives the main `agent` profile four child-agent tools with no experiment flag: `AgentRun`, `AgentSwarm`, `AgentList`, and `AgentSend`. Built-in `coder` and `explore` profiles do not receive them. Each caller can list and message only the children it created directly; a grandchild or another caller's child is not a valid target.

`AgentRun` launches a new child or continues an existing one. Pass `name` when you expect to address the same child again; names must match `^[a-z0-9_]+$`, cannot be `root`, and stay unique for the session. Continue a child with `resume` set to that name or its agent id — do not also pass `name`, `profile`, `route`, `model`, `model_alias`, or `effort`. Required `description` is a short task description (3-5 words) for UI display.

`AgentList` returns those direct children, including swarm members. Default `include_finished=false` lists running children and children with no tracking task; pass `true` when you need children whose latest background task has already finished or failed. At most 50 entries are returned, running first.

`AgentSend` queues a mailbox message without starting or interrupting a turn. An idle child stays idle and reads the message at the beginning of its next step. Address the child by `name` or agent id.

`AgentSwarm` keeps its name. New item-based spawns take `profile` (defaults to `coder`) and `effort`; it requires `description`.

The legacy v1 engine (`KIMI_CODE_LEGACY_FLAG=1`) still has the five-tool Codex-style adapter: `spawn_agent`, `list_agents`, `wait_agent`, `followup_task`, and `interrupt_agent`. Enable it with `KIMI_CODE_EXPERIMENTAL_AGENT_COLLABORATION=1`. On v1, `[agents] enabled = false` removes those tools without clearing the flag. That adapter, the flag id `agent-collaboration`, and the env var are gone from v2. The v1 `Agent` tool keeps its original name and parameters (`description`, `subagent_type`, `run_in_background`, `resume`, `thinking_effort`). This is an adapter on v1, not complete Codex compatibility.

## Peer-thread communication

Peer-thread communication lets the main Agent coordinate existing Kimi Code sessions on the same local host, including sessions in other workspaces. It is separate from the child-agent tools above and is disabled by default. After opting in, the four tools `list_threads`, `read_thread`, `send_message_to_thread`, and `wait_threads` appear only on a session's main Agent, not its sub-agents.

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

Sub-agent permission rules are inherited from the main Agent: "always allow" rules that the main Agent has accepted via `/permission` or through an approval dialog automatically propagate to all sub-agents it dispatches, so sub-agents do not need to re-approve the same types of tool calls. The `AgentRun` tool itself is allowed by default, enabling the main Agent to delegate multiple times without interrupting the user.

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

Agent Markdown files under the user, project, and `extra_agent_dirs` roots are watched for filesystem changes. After an approximately 200 ms debounce, additions, edits, and deletions reload automatically, so a running session can dispatch a newly available role without `/reload` or a CLI restart. `$KIMI_CODE_HOME/SYSTEM.md` is watched the same way. An already-created `AgentRun` tool instance keeps a frozen snapshot of its displayed role descriptions, so that list can look stale, but dispatch resolution uses the reloaded profiles immediately.

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
| `main` | no | Curation flag. When `true`, this profile is a main-agent candidate and is omitted from the `AgentRun` tool's default role list. It is not an authorization gate: `--agent`, `--agent-file`, MCP, and the SDK can still bind any catalog name |
| `delegation_notice` | no | `auto` (default) injects a position-based handoff notice when this profile runs as a sub-agent or an independent host agent; `off` skips it. Main-agent binds never inject |
| `model_preference` | no | Legacy symbolic selector available only with the secondary-model experiment: `primary` inherits the caller's model binding, while `secondary` selects [`[secondary_model] model`](../configuration/config-files.md#secondary-model). Mutually exclusive with `model_alias` |
| `model_alias` | no | Exact, case-sensitive alias from `[models]`. Literal aliases named `primary` or `secondary` stay literal; this differs from the symbolic `model_preference` field |
| `thinking_effort` | no | Thinking effort requested when this profile starts as a new subagent. It resolves independently from the model selector |
| `allowed_models` | no | Optional allowlist of model aliases this role may bind. YAML list or comma-separated string, same syntax as `tools`. When present and non-empty, the bound model must be a member. Comparisons use canonical model identity, so a bare alias matches a provider-qualified name. This list can only **narrow** what the machine already permits; it cannot re-permit a model listed in `[subagent].deny_models` or in this file's `deny_models`. A single-item list is the way to hard-pin a role to one alias — prefer it over a route sidecar whose only delta is a pinned model. Omit the field, or use an empty list, to impose no extra allowlist |
| `deny_models` | no | Optional denylist of model aliases this role must not bind, same syntax as `allowed_models`. Auto-dispatch is rejected; an explicit human choice is admitted with a one-time warning. Machine `[subagent].deny_models` still rejects every path, including humans |
| `allowed_efforts` | no | Optional allowlist of thinking efforts this role may bind, YAML list or comma-separated string. Role-level values intersect with a matching `model_profiles` entry. Auto-dispatch (`AgentRun` / `AgentSwarm`) is rejected when the resolved effort is outside the intersection; an explicit human choice is admitted with a one-time warning |
| `model_profiles` | no | Per-alias run recipe for this role. YAML list of mappings only. Required `alias` and `when`; optional `thinking_effort`, `allowed_efforts`, `prompt_mode` (`prepend` / `append` / `wrap`), and `prompt`. `when` is shown to the parent dispatcher in the `AgentRun` tool description and is never added to the child prompt. `prompt_mode` + `prompt` compose onto this role's body before the model cognition overlay; `wrap` uses `${parent_prompt}` (or its alias `${base_prompt}`) exactly once. Entries whose alias is missing from this machine's `[models]` table are omitted from the tool description and do not apply. Duplicate aliases stay listed; overlay matching uses the first entry whose alias resolves. The deprecated `recommended_models` key is still accepted as an alias and warns at load; if both keys are present, `model_profiles` wins |
| `service_tier` | no | Service tier requested on every LLM request this agent makes as a subagent: `auto`, `default`, `flex`, or `priority`. Only the `openai_responses` provider protocol encodes it into the request body; other protocols silently ignore it |
| `request_params` | no | Extra request parameters as a scalar map (string/number/boolean values only), sent with every request this subagent makes. OpenAI-family providers spread them into the request body (Kimi via `extra_body`) without overriding engine-generated fields; Anthropic ignores the map; a first-class field such as `service_tier` wins on collision. Keys are sent verbatim, so a provider may reject names it does not recognize |
| `tools` | no | Allowlist of tool names such as `Read` or `Bash`; MCP tools are matched with globs such as `mcp__github__*`. Accepts a YAML list or a comma-separated string (`tools: Read, Grep`). Omit to allow all tools; a lone `*` also allows all tools; an empty list (`tools: []`) disables all tools |
| `disallowedTools` | no | Denylist with the same syntax and matching rules, applied after `tools` |
| `subagents` | no | Allowlist of sub-agent names this agent may delegate to, with the same syntax as `tools` (YAML list or comma-separated string). Omit the field or use a lone `*` to allow every type; use an empty list (`subagents: []`) to prohibit all subagent dispatch; otherwise the explicit names form the allowlist |

`model_profiles` is a YAML list of mappings. A string, scalar, or mapping at the top level is invalid, because every entry needs a `when` trigger. Example:

```yaml
model_profiles:
  - alias: fast-model
    when: Scope and acceptance checks are already named and a fast decisive pass beats waiting.
    thinking_effort: high
  - alias: k3-review
    when: Ordinary review work the default alias can finish on its own.
    prompt_mode: prepend
    prompt: |
      Prefer system-level and global-contract reasoning.
```

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

Pair an allowlist with the `model_alias` you intend to pin. A profile that declares `allowed_models` but no `model_alias` still loads with a warning, and a dispatch that names no model inherits the caller's model — which the allowlist then rejects.

Built-in and user tools match by exact, case-sensitive name; entries starting with `mcp__` match MCP tools as globs. Three entry shapes never match anything and are reported with a warning when the profile takes effect: a wildcard outside an `mcp__` pattern (a bare `*` in `disallowedTools` disables nothing), an `mcp__` literal that is not a full `mcp__<server>__<tool>` name (`mcp__github` matches nothing — use `mcp__github__*` for the whole server), and a name no registered or built-in tool has (usually a typo, such as `read` instead of `Read`).

The body is the agent's system prompt, and it is rendered as a template each time the prompt is built: `${var}` placeholders substitute live context values — unknown variables stay verbatim, a bare `$` is never special, and a variable with no context value renders as an empty string. `${parent_prompt}` (alias `${base_prompt}`) embeds the implicit parent for this file: the effective default system prompt in an agent file, the built-in default inside `SYSTEM.md`, or the base profile in a route. `${builtin_prompt}` is always the built-in default, even when `SYSTEM.md` exists. If the file replaces the default prompt but should still honor instructions contributed by enabled plugins, place `${plugin_sections}` where those instructions should appear. The available variables are listed in the SYSTEM.md section below.

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

The required fields are `id`, `profile`, `description`, and `prompt_mode`. Optional fields are `whenToUse` plus `model_preference`, `model_alias`, `thinking_effort`, `service_tier`, `request_params`, `tools`, `disallowedTools`, and `subagents`. Unlike ordinary Agent files, route frontmatter is strict. Unknown fields, invalid types, a path/ID/profile mismatch, duplicate IDs in one source, and incompatible model selectors cause only that sidecar to be skipped with a coded diagnostic; the base profile and sibling routes still load. Agent-file-only fields such as `model_profiles`, `recommended_models`, `allowed_models`, and `deny_models` are unknown here and skip the sidecar. A route may pin `model_alias`, but that pin is still checked against the base profile's `allowed_models` / `deny_models`.

`prompt_mode` always preserves the base prompt: `inherit` requires an empty body; `prepend` and `append` require a non-empty body and reject `${parent_prompt}` / `${base_prompt}`; `wrap` requires `${parent_prompt}` or `${base_prompt}` exactly once. There is no unguarded replace mode.

If a route declares `tools`, `disallowedTools`, or `subagents`, that field replaces the base value entirely. Omit the field to inherit the base. `subagents: []` makes the route a leaf. Caller checks still use the base role, so a route cannot introduce a role the caller could not dispatch. Create and allowlist another base profile when you need a different role identity.

An omitted request field inherits the base value. `service_tier: null` clears the base tier; another tier replaces it. `request_params: null` clears the base map; a mapping overlays scalar keys on it. A route-declared `model_alias` or `thinking_effort` is locked for automatic dispatch: `AgentRun` / `AgentSwarm` must omit it or repeat the same value; a conflict is rejected. A missing locked alias fails before Agent allocation and never uses the ordinary profile-alias fallback; dispatch also fails if the selected model cannot honor a locked effort exactly. In an already-bound session, an explicit human `/model` or effort change is admitted with a one-time warning; the lock stays on the snapshot.

When enabled, both `AgentRun` and `AgentSwarm` show compact route entries filtered through the caller's base-role allowlist. Entries contain the route ID, base role, description/usage hint, model and effort defaults, and overridden field names—never the prompt body. Pass `route: reviewer.ui-k3`; omit `profile` to derive `reviewer`, or pass that matching base explicitly. A mismatch is a coded error. There is no automatic ranking or silent fallback.

Resume never reselects or switches a route. The journal stores the canonical base role and route ID with the rendered prompt, layered tool policy, denylist, subagent restriction, model/effort locks, service tier, and request parameters. Existing routed Agents therefore resume from their snapshot even if the flag is disabled or the sidecar changes, disappears, or becomes invalid; those changes affect only new dispatches. Old journals remain compatible. In a mixed `AgentSwarm` call, `route` applies only to new item-based spawns; resumed entries keep their snapshots.

`model_alias` is a stable profile field and `AgentRun` / `AgentSwarm` tool parameter. Profile-file `thinking_effort` is likewise stable; the matching v2 tool parameter is `effort`. Neither requires `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL`. For a newly spawned v2 subagent, model and effort resolve independently in this order: tool parameter → profile field → caller binding. `[subagent] default_model` / `default_effort` are accepted in config but currently unused by `AgentRun` / `AgentSwarm`. On v1 they fill after the profile when the secondary-model experiment is on. If an ordinary (non-route) profile selects a `model_alias` that is absent from `[models]`, the CLI warns and falls back to the caller's model and effort; an unknown alias passed explicitly as a tool parameter is an error.

Only the legacy tool parameter `model` (`primary` / `secondary`), the profile field `model_preference`, and the secondary recipe remain behind the secondary-model experiment. When enabled, the secondary recipe is inserted before caller inheritance. When disabled, a profile's `model_preference` is ignored with a warning, while explicitly passing the `model` tool parameter returns a clear error. Resumed and retried subagents keep their persisted model and effort; passing binding fields on an `AgentRun` continue (`resume`) is rejected. A mixed `AgentSwarm` call applies them only to item-based new spawns.

Subagent model governance compares canonical model identities after resolving `[models]` aliases. Machine `[subagent] deny_models` rejects listed models at every dispatch entry. A role file may further narrow that set with `allowed_models` and `deny_models`; those lists never widen machine permission, and a single-item `allowed_models` is the hard pin for that role. `[secondary_model] enforce_pool = true` turns the configured pool into a hard allowlist while always retaining `primary`; and the default soft-pool mode keeps exact off-pool `model_alias` values working as an escape hatch. `[secondary_model] force = true` remains the strongest machine-wide pin, binding every spawn to one model, and cannot be combined with `enforce_pool`. See the [configuration reference](../configuration/config-files.md#secondary-model) for fields and validation rules.

A file with invalid content discovered in a directory is skipped with a warning and does not affect other files. A file passed explicitly via `--agent-file` must be valid — otherwise the CLI reports the error and exits.

::: warning Note
`tools` and `disallowedTools` shape the tools shown to the model and are enforced again before execution. `subagents` works the same way: the `AgentRun` tool lists only the sub-agent types the caller may delegate to, and both `AgentRun` and `AgentSwarm` re-check the allowlist before dispatching; continuing an existing sub-agent is exempt. Permission rules remain a separate control for operations that require approval.
:::

When a custom agent runs as a dispatched sub-agent, Kimi prepends a short handoff notice: the last message is the complete deliverable for the caller. An independent host invocation (MCP / SDK) gets a different notice: there is no parent agent. Main-agent binds inject nothing. Put `${delegation_context}` in the body to place the notice; otherwise it is prepended. Set `delegation_notice: off` on the profile, or `[agents.delegation] sub = false` / `independent = false` in `config.toml`, to skip it. A configured path must exist and be non-empty, or bind fails.

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

For main-agent customization, reference `${parent_prompt}` or `${base_prompt}` in the body so the environment, workspace-instruction, Skill, and plugin injections already present in the effective default prompt stay in effect. `${builtin_prompt}` is the stock default even when `SYSTEM.md` exists. When you want to replace the default prompt but keep only plugin-contributed instructions, use `${plugin_sections}` instead. A body without `${parent_prompt}` / `${base_prompt}` or `${plugin_sections}` owns the entire prompt and excludes plugin instructions, which fits self-contained sub-agents.

### Overriding the main agent's system prompt with SYSTEM.md

To override the default main agent permanently — without passing `--agent` or `--agent-file` on every launch — write a `$KIMI_CODE_HOME/SYSTEM.md` file (default: `~/.kimi-code/SYSTEM.md`; it moves with `KIMI_CODE_HOME`). A missing or empty file has no effect. A read failure falls back to the built-in prompt with a warning. SYSTEM.md takes effect in every launch mode, including interactive TUI sessions.

How the file is parsed depends on its first line:

- **Legacy body.** The file does not start with `---` followed by a YAML mapping. Only the prompt is replaced; description, tools, and the sub-agent allowlist stay on the built-in defaults. Frontmatter is not required or read.
- **Upgraded profile.** The file starts with `---` and that fence parses as a YAML mapping. It loads as a normal agent file named `agent`, with `override` forced on. Fields you omit (`tools`, `disallowedTools`, `subagents`) still copy the built-in defaults; fields you declare take effect.

Explicit intent still outranks it: a project-scoped same-name agent file declaring `override: true` and any file passed via `--agent-file` take precedence, and selecting another agent with `--agent` bypasses it entirely. Within the user scope itself, SYSTEM.md wins over a same-name file discovered in the `agents/` directories.

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
