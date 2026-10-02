---
name: kiki-profile
description: Create, modify, or repair Kiki main/subagent profiles or SYSTEM.md (frontmatter, loading precedence, tool/model policy, prompt body, prompt_overrides). Do not use merely to select, dispatch, inspect, or discuss an existing agent.
---

# Kiki profile authoring (kiki-profile)

An agent profile is one Markdown file: a YAML frontmatter block declares the role's name and description and can select its model and tool access, and the Markdown body is the role's system prompt. Choose the loading scope, frontmatter fields, and prompt mode deliberately; consult the complete field-by-field reference in the installed docs at `<KIKI_HOME>/docs/<locale>/customization/agents.md`.

For a character's identity, voice, greetings, dialogue examples or avatar, load `kiki-persona` instead. A persona can reference an existing execution profile; create a new profile here only when the task needs different execution behavior.

## Where profiles live

Kiki discovers profile files by scope; more specific scopes win on a name collision: **Explicit (`--agent-file` / `profile_file`) > Project > Extra > User > Built-in copies > Plugin**.

| Scope | Location |
| --- | --- |
| User (all projects) | `$KIKI_HOME/agents/` (default `~/.kiki/agents/`) and `~/.agents/agents/` |
| Project (nearest `.git` root) | `.kiki/agents/` and `.agents/agents/` |
| Extra | `extra_agent_dirs` entries in `config.toml` |
| Built-in copies | installed under `$KIKI_HOME/agents/builtin/`, loaded in the user scope after ordinary user files |
| Plugin | the enabled plugin's manifest `agents` field; lowest priority |

Rules that surprise people:

- Each directory is scanned recursively for `.md` files. Dot-directories, `node_modules`, and `_private` are skipped.
- The higher-priority same-name file wins without `override: true`; `override` is legacy metadata. A project file named `agent.md` therefore replaces the default main agent.
- Files are watched and hot-reload about 200 ms after you save — no restart or `/reload` needed. An existing session's main agent keeps its bound snapshot until **Rebuild context**.
- `$KIKI_HOME/SYSTEM.md` permanently overrides the default main agent's prompt. It is not part of directory discovery: without a frontmatter fence only the prompt body is replaced; with a `---` YAML fence it loads as a normal profile named `agent` with `override` forced on.
- A file that fails validation is skipped with a warning and never reaches the catalog — the role simply "does not exist" for dispatch. Always verify a new file actually loads (see the verify section).

## File format

```markdown
---
name: code-reviewer
description: Strict read-only reviewer that reports severity-ranked findings
whenToUse: Code reviews and PR checks before merge
model_alias: fast-model
preferred_models: [fast-model]
thinking_effort: high
preferred_efforts: [high]
tools: [Read, Grep, Glob]
disallowedTools: [Bash]
subagents: [explore]
---

You are a strict code reviewer. Read the diff, then report findings grouped by severity…
```

- Frontmatter is a YAML mapping between `---` fences. `description` is required; `name` defaults to the file name and uses lowercase letters and digits separated by single hyphens or underscores (`my-reviewer` or `my_reviewer`, not `MyReviewer`).
- The key set is **closed**: an unknown frontmatter key fails the whole file. Common typos therefore look like "the profile does not exist". Removed keys also error — `model_preference` was removed; set `model_alias` instead.
- The body is required and non-empty unless `system_prompt_mode` is `inherit`.

## The prompt body replaces the default prompt

This is the semantic most profile bugs come from: **by default the body is the complete system prompt.** Kiki does not prepend, append, or merge the built-in default prompt — a replace-mode profile that never references `${skills_section}`, `${agents_md}`, or `${plugin_sections}` runs without the skill list, workspace instructions, and plugin sections the default agent has. That is usually right for a self-contained sub-agent and usually wrong for a main-agent profile.

`system_prompt_mode` controls the relationship:

| Mode | Effect | Body rule |
| --- | --- | --- |
| `replace` (default) | Body is the whole prompt | Non-empty |
| `prepend` | Body, then `${base_prompt}` | No `${parent_prompt}` / `${base_prompt}` inside |
| `append` | `${base_prompt}`, then body | No `${parent_prompt}` / `${base_prompt}` inside |
| `inherit` | Keeps the lower-priority same-name prompt; applies only this file's field overrides | Must be empty; requires non-empty `prompt_overrides` |

`${base_prompt}` and `${parent_prompt}` are the same slot: the effective default prompt inside an agent file, the built-in default inside `SYSTEM.md`, the base profile inside a route. `${builtin_prompt}` is always the stock built-in default, even when `SYSTEM.md` exists.

The body is rendered as a template on every prompt build. Useful variables: `${skills}` / `${skills_section}`, `${agents_md}`, `${cwd}`, `${cwd_listing}`, `${os}`, `${shell}`, `${now}`, `${windows_notes}`, `${additional_dirs_section}`, `${plugin_sections}`, `${product_name}`, `${reply_style_guide}`, `${delegation_context}`. Unknown variables stay verbatim; a variable with no value renders as an empty string.

## Field quick reference

| Field | One-line rule |
| --- | --- |
| `description`, `whenToUse` | Written for the dispatcher — the main agent reads these to pick roles |
| `override` | Legacy metadata (default `false`); scope precedence decides the winner |
| `main` | `true` marks a main-agent candidate (GUI selector); hidden from the `AgentRun` default role list |
| `private` | Hidden from dispatch and selection lists; running agents keep working, new dispatches fail |
| `model_alias` | Exact alias from `[models]` for a fixed model, or `inherit` to follow the dispatch caller's model (subagents only) |
| `allowed_models` / `deny_models` | **Hard** model allow/deny lists: out-of-list or denied bindings are rejected. Native aliases match canonical identity; external executors use the effective model ID. Machine `[subagent].deny_models` is an additional hard boundary |
| `restrict_models_to_menu` | **Hard** menu ceiling when `true`; boolean, default `false`, profile top level only. Permits the author's original default `model_alias` plus `model_profiles[].alias`, captured before route / lease rewrites and frozen with the binding. Other hard allowsets intersect; denials still apply |
| `thinking_effort` | Default effort pin; explicit choices may override it only within hard rules and provider/executor capabilities |
| `allowed_efforts` | **Hard** allowlist of effective efforts; explicit pins and forced host values cannot bypass it |
| `preferred_models` / `discouraged_models` | **Soft** recommendations / models to avoid; hard-permitted executable choices continue with `model_not_preferred` / `model_discouraged` advisories |
| `preferred_efforts` | **Soft** effort recommendations; deviations continue with `effort_not_preferred`, without lowering effort |
| `spawn_constraints` | Descendant rules: hard `allowed_models`, `deny_models`, `allowed_efforts`, `disallowed_tools`; soft `preferred_models`, `discouraged_models`, `preferred_efforts`. No model/effort pins |
| `model_profiles` | Per-alias recipes: required `alias`; optional `when`, `thinking_effort`, all six hard/soft list fields, `prompt_mode` (`prepend`/`append`/`wrap`), `prompt`, `prompt_overrides`, request fields and budgets. `when` guides dispatch, not automatic selection; defaults use the first match, hard lists from all matching entries apply, including when a lease replaces their defaults |
| `tools` / `disallowedTools` | Omit `tools` or use a lone `*` for no added allowlist; `tools: []` disables all tools. Other policy limits still apply; `mcp__server__*` globs match MCP; deny applies after allow |
| `disabled-tool-groups` | Withhold built-in groups such as `shell` or `web`; a tool named in `tools` survives unless explicitly denied |
| `subagents` / `subagent_policy` | Recommended child roles; global strict enforces a declared list (`[]` = no new children), advisory records deviations. Omit or `*` for no named restriction. Legacy `strict` can tighten advisory; legacy `advisory` cannot lower global strict |
| `executor` | Omit for the native engine. External IDs are built in or configured under `[agent_executors.<id>]` in `config.toml`. For an external main agent, `allow_kiki_subagents: true` enables Kiki delegation over local stdio MCP |
| `service_tier` | `auto`, `default`, `flex`, or `priority` |
| `request_params` | Scalar map (string/number/boolean) sent with every request |
| `context_budget` / `max_completion_tokens` | Caps only; the smallest declared layer wins |
| `prompt_overrides` | Field-level prompt overrides; see below |
| `delegation_notice` | For native execution, `auto` (default) injects a position-based handoff notice for subagents or independent host agents unless `[agents.delegation] sub = false` / `independent = false`; main binds never inject it; `off` skips it. External prompt composition uses `executor_prompt`; its default `include: []` adds no delegation notice automatically |

Apply model/effort lists consistently across profile, caller lease, `spawn_constraints`, and matching `model_profiles` entries. Allowsets intersect; denials accumulate. Advisory role dispatch, explicit pins, manual selections, and resume cannot bypass hard rules. Global role policies (`[subagent].main_dispatch_policy = "advisory"`, `subagent_dispatch_policy = "strict"` by default) are independent of model enforcement; prefer those global controls for new configuration.

Hard allowlists accept YAML lists or comma-separated strings: omitted / `null` or a lone `"*"` adds no restriction; `[]` permits nothing. Never mix `*` with names, and never use wildcards in deny/discouraged lists. Empty deny lists forbid nothing. Soft lists do not select models or grant provider capabilities; even an empty intersection of preferences only advises. Hard violations return `profile.constraint_violation` without silently switching model or lowering effort: select a permitted value, or ask the user to revise the hard rule, then retry. A rejected resume keeps the saved binding unchanged.

With `restrict_models_to_menu` off, the menu is not exhaustive; other hard rules still apply. With it on, only the original default and declared menu are candidates. The default needs no duplicate entry. Route / lease pins, explicit choices, saved bindings, and lease menu replacements cannot expand the frozen domain; replacing entries with a subset or an empty list does not narrow it either — use a hard allowlist to narrow it. Original entry hard rules remain.

Omitting a model follows the existing selection rules and then validates; never scan the menu for an automatic fallback. `when` is a hint, not a permission predicate, and menu order is not a downgrade chain. No default and no effective menu, or an empty effective intersection, fails closed.

Resume uses the frozen menu; `allow_model_change: true` confirms a change, not extra permission. Do not teach an explicit pin as a way to bypass the menu: select an effective menu item or ask the user to revise the declaration. Disk edits apply to new bindings, not silently to saved snapshots.

## prompt_overrides

Field-level overrides of named prompt sections, without rewriting the whole prompt body:

```yaml
prompt_overrides:
  fields:
    delegation.sub.notice: "Return one compact receipt: result, evidence, open risks."
  files:
    - prompt-overrides/reviewer.toml
```

`files` entries are TOML paths relative to `KIKI_HOME` (no absolute paths, no `..`), each with `schema_version = 1` and a `[fields]` table. Layering: global < model < profile < profile-model (`model_profiles[].prompt_overrides`). The field ids and the global `[prompt]` section are documented in the installed docs under `configuration/config-files.md#prompt`.

### Minimal inherited override

`inherit` requires an empty body **and** at least one `prompt_overrides.fields` entry or `prompt_overrides.files` path. The lower-priority same-name profile must exist. A model/tools-only file or `prompt_overrides: {}` does not satisfy this contract; do not invent a prompt-field change just to pass validation.

```markdown
---
name: agent
description: Main agent with a custom subagent handoff notice
system_prompt_mode: inherit
prompt_overrides:
  fields:
    delegation.sub.notice: "Return one compact receipt: result, evidence, open risks."
---
```

### Model/tools-only override

For a main-agent profile that should keep the effective default prompt, leave the mode at `replace` and use `${base_prompt}` as the non-empty body:

```markdown
---
name: agent
description: Main agent with a configured model and read-only tools
model_alias: your-configured-model
tools: [Read, Grep, Glob]
---

${base_prompt}
```

For an existing self-contained subagent, retain its prompt body when changing only model/tools fields. `${base_prompt}` is the effective default prompt, not an arbitrary lower-priority same-name subagent's prompt.

## Best practices

- **Default replace is the trap.** If the role should keep the default environment, skills, or plugin scaffolding, use `prepend` / `append` / `inherit`, or place `${base_prompt}` deliberately — don't assume anything is merged for you.
- **Prompt-field tweak? Don't fork the prompt.** Use `system_prompt_mode: inherit` with an empty body and non-empty `prompt_overrides` to keep a lower-priority same-name prompt. For model/tools-only changes, use the non-empty-body approach above instead.
- **Write `description` and `whenToUse` for the dispatcher.** State the task shapes this role owns and what it returns; the main agent chooses roles from that text alone.
- **Prefer soft fields by default.** Users usually need soft preferences, especially for main-agent profiles. Use `preferred_models`, `preferred_efforts`, and `discouraged_models` for guidance while keeping executable alternatives available. Use hard fields only when the user explicitly requests enforcement. If a safety or cost red line seems to need a hard limit, explain the reason and consequences and obtain the user's consent before adding it; never silently write a hard constraint.
- **Choose menu policy by intent.** Prefer `restrict_models_to_menu: true` only when `model_profiles` is already a complete permitted menu (plus the declared default), with per-model recipes and one candidate source for GUI and dispatch; avoid duplicating an equivalent `allowed_models` list. For cost, speed, or experience-based advice that should leave alternatives open, keep the switch off and use soft `preferred_*` / `discouraged_models`. For an independent budget, compliance, deployment, or descendant-tree boundary, use hard `allowed_models` / `deny_models` without inventing menu entries; these can intersect with a restricted menu. Keep general-purpose or example-only menus off, and never bulk-enable or automatically migrate existing profiles. Obtain consent before adding this hard ceiling, just as for other hard rules.
- **Pin deliberately.** `model_alias` selects the default model; pair it with `preferred_models` and add `model_profiles[].when` hints for conscious alternate choices. Lists never select a model. For a new subagent without a pin, supply a concrete dispatch model or configure `[subagent].default_model`; with none of these, dispatch fails with `model.not_configured`. A pin is a soft default, not permission to bypass a hard list.
- **Migrate advice by intent.** There is no legacy-soft mode for `allowed_models`, `deny_models`, or `allowed_efforts`. Rename advice-only lists to `preferred_models`, `discouraged_models`, or `preferred_efforts` in every affected scope. Keep genuine hard boundaries, `model_profiles` recipes, and default pins; confirm any widening of a hard list with the user.
- **Keep sub-agent prompts self-contained.** A sub-agent sees neither the caller's history nor your `AGENTS.md` unless the template includes it.
- **Prefer the smallest tool surface that can do the job.** `tools` + `disallowedTools` are both a model-facing declaration and an execution-time gate.
- **Editing surfaces share one parser.** Settings → Agents in the GUI and direct file edits validate with the same rules, and files hot-reload; pick whichever surface is convenient.
- **Treat project-level profiles as code from the repo.** A same-name project file replaces a built-in agent's whole prompt without needing `override: true` — review `.kiki/agents/` and `.agents/agents/` in unfamiliar repositories before running Kiki there.

## Optional example subagent profiles

This installed skill includes the complete, version-matched `implementer.md` and `reviewer.md` example files below. They are **examples, not installed roles**. `implementer` owns a bounded engineering objective through verification and handoff; `reviewer` independently judges a candidate or decision as a read-only leaf. On first-run setup, offer each separately. After the user opts in to a specific role, resolve the real Kiki data home on the server host and check whether that role's destination exists; never overwrite without explicit consent. Use the embedded Markdown template as the source, not a repository path or a paraphrase.

Both templates set `model_alias: inherit` and leave `thinking_effort` unset. Copy the approved template unchanged: `inherit` follows the parent agent's model at dispatch time rather than fixing a provider in the example. Tell the user this model choice follows the caller and can later be changed to a fixed model in Settings. Check that the written file loads. To use a configured default model instead, replace `inherit` with its alias and optionally set an effort and preference list, for example:

```yaml
model_alias: your-configured-model
thinking_effort: high
preferred_models: [your-configured-model]
```

The following complete example files are embedded by the built-in skill from the versioned templates shipped in the application. They are available even when the source repository is absent.

## Verify before reporting done

A written file is not a loaded profile. After creating or editing:

1. Save and let the watcher reload (~200 ms).
2. Confirm the role actually appears: Settings → Agents / Dispatch capabilities in the GUI, or ask the agent to list its dispatchable profiles. A file that failed validation was skipped with a warning — check for skip diagnostics naming your path.
3. If you changed dispatch-relevant fields (`description`, `model_alias`, hard/soft lists, `tools`), exercise the intended binding: use a real dispatch for a subagent or start a main-agent session. Check the accepted model/effort and any expected advisory. For a user-approved hard limit, also confirm an out-of-domain choice is rejected without changing the binding.

Never claim a profile "works" from file existence alone.

## Ground truth

- Full field reference (installed with Kiki): `<KIKI_HOME>/docs/<locale>/customization/agents.md`; prompt-override field ids: `<KIKI_HOME>/docs/<locale>/configuration/config-files.md#prompt`.
- Kiki repository development only — the parser is the source of truth when docs and behavior disagree: `packages/agent-profiles/src/agentFile.ts` (closed key set, validation), `agentFileDiscovery.ts` + `packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/internal/agentRoots.ts` (scan roots), `profileShared.ts` (template variables), `system.md` (built-in default prompt).
