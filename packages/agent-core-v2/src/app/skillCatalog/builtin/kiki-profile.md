---
name: kiki-profile
description: Create or edit Kiki agent profile files — Markdown role definitions with YAML frontmatter under `~/.kiki/agents/`, a project's `.kiki/agents/` or `.agents/agents/`, or `$KIKI_HOME/SYSTEM.md`. Use when writing a new agent or main profile, changing a profile's fields (model pin, tools, subagents, prompt body, prompt_overrides), or fixing a profile that fails to load. Not needed when merely dispatching an agent or selecting an existing profile.
---

# Kiki profile authoring (kiki-profile)

Author and repair Kiki agent profile files. An agent profile is one Markdown file: a YAML frontmatter block declares the role's name, description, model, and tool access, and the Markdown body is the role's system prompt. This skill gives the loading rules, the file format, and the prompt-replacement semantics you must get right; the complete field-by-field reference lives in the installed docs at `<KIKI_HOME>/docs/<locale>/customization/agents.md`.

## Where profiles live

Kiki discovers profile files by scope; more specific scopes win on a name collision: **Explicit (`--agent-file` / `profile_file`) > Project > Extra > User > Plugin > Built-in**.

| Scope | Location |
| --- | --- |
| User (all projects) | `$KIKI_HOME/agents/` (default `~/.kiki/agents/`); falls back to `~/.agents/agents/` |
| Project (nearest `.git` root) | `.kiki/agents/`; falls back to `.agents/agents/` |
| Extra | `extra_agent_dirs` entries in `config.toml` |
| Plugin | the enabled plugin's manifest `agents` field |
| Built-in | shipped with Kiki; lowest priority |

Rules that surprise people:

- Each directory is scanned recursively for `.md` files. Dot-directories, `node_modules`, and `_private` are skipped.
- A directory-discovered file does **not** replace a same-name built-in profile unless its frontmatter declares `override: true`.
- Files are watched and hot-reload about 200 ms after you save — no restart or `/reload` needed.
- `$KIKI_HOME/SYSTEM.md` permanently overrides the default main agent's prompt. It is not part of directory discovery: without a frontmatter fence only the prompt body is replaced; with a `---` YAML fence it loads as a normal profile named `agent` with `override` forced on.
- A file that fails validation is skipped with a warning and never reaches the catalog — the role simply "does not exist" for dispatch. Always verify a new file actually loads (see the verify section).

## File format

```markdown
---
name: code-reviewer
description: Strict read-only reviewer that reports severity-ranked findings
whenToUse: Code reviews and PR checks before merge
model_alias: fast-model
allowed_models: [fast-model]
thinking_effort: high
tools: [Read, Grep, Glob]
disallowedTools: [Bash]
subagents: [explore]
---

You are a strict code reviewer. Read the diff, then report findings grouped by severity…
```

- Frontmatter is a YAML mapping between `---` fences. `description` is required; `name` defaults to the file name and must be kebab-case (`my-reviewer`, not `MyReviewer`).
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
| `override` | Allow replacing a same-name built-in (default `false`) |
| `main` | `true` marks a main-agent candidate (GUI selector); hidden from the `AgentRun` default role list |
| `private` | Hidden from public role listings; still resolvable by explicit name or as a scoped source |
| `model_alias` | Exact alias from `[models]`; the profile's model pin |
| `allowed_models` / `deny_models` | Narrowing lists matched by canonical identity; a single-item `allowed_models` is the hard pin |
| `thinking_effort` / `allowed_efforts` | Effort pin and its allowlist |
| `model_profiles` | Per-alias recipes: `alias` + optional `when`, `thinking_effort`, `prompt_mode` (`prepend`/`append`/`wrap`), `prompt`, `prompt_overrides`, budgets. `when` is shown to the dispatcher |
| `tools` / `disallowedTools` | Omit or `*` = all tools; `[]` = none; `mcp__server__*` globs for MCP; deny applies after allow |
| `subagents` | Allowlist of dispatchable roles; omit or `*` = all; `[]` = leaf |
| `executor` | Omit for the native engine; external ids come from `agent-executors.toml`; main profiles are native-only |
| `service_tier` | `auto`, `default`, `flex`, or `priority` |
| `request_params` | Scalar map (string/number/boolean) sent with every request |
| `context_budget` / `max_completion_tokens` | Caps only; the smallest declared layer wins |
| `prompt_overrides` | Field-level prompt overrides; see below |
| `delegation_notice` | `auto` (default) injects a handoff notice when running as a sub-agent; `off` skips it |

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

## Best practices

- **Default replace is the trap.** If the role should keep the default environment, skills, or plugin scaffolding, use `prepend` / `append` / `inherit`, or place `${base_prompt}` deliberately — don't assume anything is merged for you.
- **Field-only tweak? Don't fork the prompt.** To change a built-in role's model, tools, or a few prompt fields, use `system_prompt_mode: inherit` with an empty body instead of copying the stock prompt text.
- **Write `description` and `whenToUse` for the dispatcher.** State the task shapes this role owns and what it returns; the main agent chooses roles from that text alone.
- **Pin deliberately.** Pair `model_alias` with a single-item `allowed_models` for a hard pin; add `model_profiles[].when` lines so alternate models stay a conscious dispatch choice. An `allowed_models` list without `model_alias` loads with a warning and makes unnamed dispatch fail closed.
- **Keep sub-agent prompts self-contained.** A sub-agent sees neither the caller's history nor your `AGENTS.md` unless the template includes it.
- **Prefer the smallest tool surface that can do the job.** `tools` + `disallowedTools` are both a model-facing declaration and an execution-time gate.
- **Editing surfaces share one parser.** Settings → Agents in the GUI and direct file edits validate with the same rules, and files hot-reload; pick whichever surface is convenient.
- **Treat project-level profiles as code from the repo.** A project file with `override: true` can replace a built-in agent's whole prompt — review `.kiki/agents/` in unfamiliar repositories before running Kiki there.

## Verify before reporting done

A written file is not a loaded profile. After creating or editing:

1. Save and let the watcher reload (~200 ms).
2. Confirm the role actually appears: Settings → Agents / Dispatch capabilities in the GUI, or ask the agent to list its dispatchable profiles. A file that failed validation was skipped with a warning — check for skip diagnostics naming your path.
3. If you changed dispatch-relevant fields (`description`, `model_alias`, `allowed_models`, `tools`), do one real dispatch against the profile before calling the work done.

Never claim a profile "works" from file existence alone.

## Ground truth

- Full field reference (installed with Kiki): `<KIKI_HOME>/docs/<locale>/customization/agents.md`; prompt-override field ids: `<KIKI_HOME>/docs/<locale>/configuration/config-files.md#prompt`.
- Kiki repository development only — the parser is the source of truth when docs and behavior disagree: `packages/agent-profiles/src/agentFile.ts` (closed key set, validation), `agentFileDiscovery.ts` + `packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/internal/agentRoots.ts` (scan roots), `profileShared.ts` (template variables), `system.md` (built-in default prompt).
