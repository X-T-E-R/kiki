# Agent Profiles: Concepts and Design

Every agent in Kiki — the main agent and each subagent — is defined by a **profile**. This page explains what a profile is, where the files live, when changes take effect, and how profiles relate to the other customization mechanisms (Skills, prompt-field overrides, plugins, hooks, themes). For field-level usage see [Agents and Sub-Agents](./agents.md).

## What a profile is

A profile is a single Markdown file:

- The **frontmatter** (YAML metadata block at the top) declares its name, description, tool allowlist, model binding, and more;
- The file body **is** the agent's system prompt.

Kiki ships a few built-in profiles: the main `agent` that drives sessions, the default subagent `general`, and `explore` for read-only exploration (older installs may also keep `coder` and `plan`). Creating a custom agent requires no code — write a Markdown file in the same shape and it is discovered automatically, side by side with the built-ins.

## Where the files live

Kiki discovers profile files by scope; more specific scopes win:

**Explicit (`--agent-file`) > Project > Extra directories > User > Built-in copies > Plugin**

When two files define the same `name`, the one in the higher-priority scope wins — unless it declares `system_prompt_mode: inherit`, in which case it keeps the lower-priority same-name profile's definition and applies only its own field overrides. Common locations (`$KIKI_HOME` defaults to `~/.kiki`):

- **Project level** (applies to this repository only): `<project root>/.kiki/agents/`, `<project root>/.agents/agents/`
- **User level** (applies to every project): `$KIKI_HOME/agents/`, `~/.agents/agents/`
- **Built-in copies**: installed into `$KIKI_HOME/agents/builtin/`; a same-name user file always outranks them

::: warning Note
Project-level profiles come from the repository itself — including repositories you have just cloned and do not trust yet. A project file named `agent.md` can replace the default main agent's entire system prompt. Before running Kiki in an unfamiliar repository, inspect its `.kiki/agents/` directory with the same caution you would apply to scripts.
:::

The full scope rules and directory list are in [Agent Locations](./agents.md#agent-locations).

## When changes take effect

Profile files under the user, project, and extra-directory roots — plus `$KIKI_HOME/SYSTEM.md` — are watched: additions, edits, and deletions reload automatically after roughly 200 ms, no restart needed, and newly dispatched subagents pick up the reloaded version immediately. An existing session's main agent stays bound to the profile snapshot from when the session was created; after editing a file, use **Rebuild context** in the session to pick up the new version while keeping the conversation. See [Rebuilding a session context](./agents.md#rebuilding-a-session-context).

The agent detail's prompt preview separates the bound configuration from disk changes and the latest actual request. Before the first request, request evidence is empty. Checking all prompt files explicitly also checks common and other identity branches, without applying them or changing the binding; a missing file in an unselected branch can be reported there while the current agent continues to run.

## Main agents and subagents

A session is driven by one **main agent**, which can dispatch **subagents** for focused sub-tasks. Both use the same profile file format; they differ in how they are used:

- **Main agent**: selected at session start with `--agent <name>` or `--agent-file <path>`, or switched in the GUI's profile selector. Profiles with `main: true` in frontmatter appear as main-agent candidates.
- **Subagent**: dispatched automatically by the main agent during the conversation, works in an isolated context, and brings back only its final conclusion. You can also name one directly, e.g. "use explore to map the files first".

Prompt declarations can follow the agent's actual position without maintaining separate profiles. Both `prompt_overrides` and the body inside each `model_profiles` entry accept `main` and `independent` branches: omit a branch or set it to `same` to use the common declaration, set it to `off` to skip only that declaration, or supply an object to replace the whole declaration for that position. Subagents use the common declaration. These branches do not change model selection or permissions; top-level `main: true` still only marks a main-agent candidate. [Model cognition](../configuration/config-files.md#models) supports the same selection for overlay, steering, and anchor files.

```yaml
model_profiles:
  - alias: review-model
    prompt_mode: append
    prompt: Check the evidence before drawing conclusions.
    main:
      prompt_mode: append
      prompt: Coordinate the work and report the verified result.
    independent: off
prompt_overrides:
  fields:
    system.shared: State your findings clearly.
  main:
    fields:
      system.shared: Give the user a concise result and next action.
```

The objects are independent: the `main` body replaces the common `prompt_mode` / `prompt` pair, and the `main` field object replaces that declaration's common files and fields. Include any common content you also want in the object. Identity is determined by the live binding, not the profile name or its `main: true` flag; an externally delegated agent uses `independent` rather than a main-agent branch.

A profile used as a subagent has one extra layer on top of its `tools` and `disallowedTools` lists: a set of tools that are off for subagents until something names them, such as `ThreadRead`, `AskUserQuestion`, or `Cron`. Naming one tool in `tools` opens that tool for this profile as a subagent and nothing else. A profile that writes no allowlist keeps it that way with the wildcard beside the name, so one extra tool does not cost you the ordinary ones:

```yaml
tools: ["*", ThreadRead]
```

`*` on its own opens no opt-in and never crosses a deny. A finite list stays finite: `tools: [Read, Grep, ThreadRead]` selects exactly those three. The server-wide `subagent.allowed_tools` is an alternative to naming the tool here, but this list still filters the outcome: a tool that entry names is open for this profile only when the profile also selects it, which is why the `["*", ThreadRead]` form above exists. A profile writing no list (or `*`) is open to everything that entry allows, and this profile's own `disallowedTools` still denies it. A main conversation is not restricted by these opt-ins; the same profile's own lists still decide which tools a main conversation can pick. See [Subagent defaults](../configuration/config-files.md#subagent) for the full list and the `MemoryWrite`, `ThreadSend`, `SendMessage`, and goal tools that stay main-only.

To permanently replace the default main agent's configuration, there is one special file: `$KIKI_HOME/SYSTEM.md` (default `~/.kiki/SYSTEM.md`). A body-only `SYSTEM.md` replaces just the default main agent's system prompt; an upgraded file starting with `---` frontmatter can also change profile fields such as `tools`, `subagents`, and the model binding. Precedence details are in [Overriding the main agent's system prompt with SYSTEM.md](./agents.md#overriding-the-main-agent-s-system-prompt-with-system-md).

## Model menus and hard boundaries

`model_profiles` provides per-model parameters and prompts; by default, it is a candidate menu, not an exhaustive list of permitted models. The top-level frontmatter field `restrict_models_to_menu` accepts only a boolean and defaults to `false`. For subagent bindings, set it to `true` to make the menu the profile's model-binding contract: only the author's declared default `model_alias` and `model_profiles[].alias` are permitted, subject to other hard rules and executor capabilities. It applies to main agents, subagents, registered profiles, and explicit profile files, not to routes, caller leases (caller-supplied child configuration overrides), `spawn_constraints`, or menu entries. Enabling it on a parent profile does not enable it on child profiles.

For a complete permitted menu, maintain one positive list rather than copying it into `allowed_models`:

```yaml
model_alias: fast-model
restrict_models_to_menu: true
model_profiles:
  - alias: review-model
    when: A more thorough review is needed.
    thinking_effort: high
```

This menu contains `fast-model` and `review-model`; the default needs no duplicate empty entry. Models are compared using the executor's canonical identities, not alias suffix matching. An unresolvable or unexecutable declaration does not gain execution capability. Changing the default also changes the menu: if the old default is not separately listed in `model_profiles`, replacing the default removes the old model and adds the new one.

The switch adds one **hard allow domain**. It does not change model-selection priority or automatically select the first menu entry. After directory and scope resolution selects the profile, Kiki captures its original default and menu before route or lease rewrites and freezes them with the binding. Explicit dispatch parameters, route / lease pins (default model selections), a saved effective model, and lease replacements of `model_profiles` cannot expand that domain. Replacing entries with a subset or an empty list neither erases nor narrows the original menu; use `allowed_models` for an additional hard restriction. Hard rules from the original menu entries remain in force.

When a caller lease supplies `model_profiles`, it replaces the child's menu and parameter defaults but preserves the original role-model prompts by default (`model_prompts: preserve`). Kiki matches the child's final alias in both sources, applies the original role prompt first and the lease prompt second, and merges field overrides in that order. Set `model_prompts: replace` alongside a lease menu to drop only the original prompt sources; the saved model menu and hard rules remain in force. A caller lease applies only to children, so its own model-body and field declarations cannot contain `main` or `independent` branches.

For a session's **main agent**, the user's model choice takes priority over profile model constraints. Recommendations and default pins produce no warning; a model outside a hard profile domain produces only a non-blocking warning. The GUI keeps configured models selectable and does not block sending because of profile model rules, including when the constraint projection is still loading. Model availability and provider / executor capabilities are still checked. A `main: true` profile dispatched through `AgentRun` is a subagent, not a user-controlled main session.

For **subagent bindings**, these rules apply equally in the GUI, CLI, `AgentRun`, and API:

- **Reject outside the menu; do not downgrade.** When enabled, an explicit out-of-menu selection returns `profile.constraint_violation`, without falling back to the default. Omitting the model still selects it through the existing default rules, then validates the menu. A default or configured fallback outside the menu is rejected; Kiki does not scan the menu for a replacement. Failure to select any model still reports an unbound model.
- **Every hard domain applies.** The menu intersects with all applicable `allowed_models` lists, and a `deny_models` match always rejects. `"*"` cannot widen the menu. Machine denials and model / effort capability limits retain their existing scope. Turning the switch off does not remove those hard rules or hard rules inside menu entries. An equivalent menu and `allowed_models` list are redundant, not a loading error; different lists still intersect, with neither layer ignored.
- **Hints are not gates.** `when` is text for the caller, not an evaluated condition. An omitted hint, an apparently unmet condition, or several apparently matching conditions do not change permission. `preferred_*` and `discouraged_models` remain soft advice when the menu is enabled. Menu order is not a downgrade chain.
- **An empty domain does not permit execution.** An empty menu with a default restricts binding to that one model. With neither menu nor default, no effective candidates, or an empty intersection with other hard domains, binding is rejected rather than treating an empty set as unrestricted (fail closed).
- **Resume does not expand permission.** `resume` validates the frozen menu and saved hard rules, plus applicable current caller / machine hard domains; rejection leaves the saved binding unchanged. Model changes still require `allow_model_change: true`, which does not authorize going outside the menu. Editing the switch or menu on disk never silently rewrites existing snapshots. New bindings use the new definition; existing sessions require an explicit rebind or a new session.

To recover from a subagent hard rejection, select an effective menu item that also satisfies other hard rules, or edit the profile declaration. Explicit pins, manual selections, and model-change confirmation are not ways to bypass the menu.

### When to enable it

Prefer enabling the switch for profiles whose `model_profiles` is **already maintained as a complete permitted menu**. Leave it off for general-purpose profiles or menus that only list a few examples. Kiki does not bulk-enable or automatically migrate existing profiles. Choose by intent:

| Scenario | Recommended configuration |
| --- | --- |
| The default and menu entries are the complete permitted candidates, with per-model parameters / prompts and one shared candidate source for the GUI and callers | Enable `restrict_models_to_menu` and maintain the default plus `model_profiles`; usually do not duplicate an equivalent `allowed_models` list |
| Cost, speed, or experience-based advice only, while users or callers should still be able to try models outside the menu | Leave it off and use soft `preferred_models`, `preferred_efforts` / `discouraged_models` |
| A real budget, compliance, deployment, or descendant-tree boundary that is independent of the profile menu | Use hard `allowed_models` / `deny_models`, without inventing menu entries; combine with the switch if needed, taking the effective intersection |

See [Agent file format](./agents.md#agent-file-format) for the field reference and more examples.

## Customization mechanism map

Kiki separates customization mechanisms by concern. Decide what you want to change first, then pick the mechanism:

| What you want to change | Use |
| --- | --- |
| A reusable identity and private memory across conversations | [Personas, Bots, and rooms](./personas.md) |
| An agent's execution instructions, tools, permissions, or model | **Profile files** (this page and [Agents and Sub-Agents](./agents.md)) |
| One named passage inside the built-in prompts (e.g. language rules, tool descriptions) | [Prompt field overrides](./prompt-fields.md) |
| Expertise or workflows the agent invokes automatically when relevant | [Agent Skills](./skills.md) |
| Prompt snippets you trigger yourself with `/name` | [Custom prompt commands](./skills.md#custom-prompt-commands) |
| Packaging profiles, Skills, commands, and hooks for a team | [Plugins](./plugins.md) |
| Intercepting or notifying on tool calls and session events | [Hooks](./hooks.md) |
| Terminal color scheme | [Custom Themes](./themes.md) |

## Next steps

- [Agents and Sub-Agents](./agents.md) — profile field reference, dispatch behavior, SYSTEM.md, and runtime details
- [Agent Skills](./skills.md) — inject reusable workflows into agents
