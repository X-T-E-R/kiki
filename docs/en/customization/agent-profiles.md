# Agent Profiles: Concepts and Design

Every agent in Kiki — the main agent and each subagent — is defined by a **profile**. This page explains what a profile is, where the files live, when changes take effect, and how profiles relate to the other customization mechanisms (Skills, prompt-field overrides, plugins, hooks, themes). For field-level usage see [Agents and Sub-Agents](./agents.md).

## What a profile is

A profile is a single Markdown file. The **frontmatter** (the YAML metadata block at the top) declares its name, description, tool allowlist, model binding and more; the file body **is** the agent's system prompt.

A profile file selected directly in the composer is a session-scoped source rather than a discovered catalog entry; its controls and recovery are described in [Choosing the engine and its profile](./agents.md#choosing-the-engine-and-its-profile).

Kiki ships a few built-in profiles: the main `agent` that drives sessions, the default subagent `general`, and `explore` for read-only exploration. Creating your own agent needs no code — write a Markdown file in the same shape and it is discovered automatically, alongside the built-ins.

## Where the files live

Kiki discovers profile files by scope; more specific scopes win:

**Explicit (`--agent-file`) > Project > Extra directories > User > Built-in copies > Plugin**

When two files define the same `name`, the higher-priority one wins — unless it declares `system_prompt_mode: inherit`, which keeps the lower-priority profile's definition and applies only this file's field overrides. Common locations (`$KIKI_HOME` defaults to `~/.kiki`):

- **Project level** (applies to this repository only): `<project root>/.kiki/agents/`, `<project root>/.agents/agents/`
- **User level** (applies to every project): `$KIKI_HOME/agents/`, `~/.agents/agents/`
- **Built-in copies**: installed into `$KIKI_HOME/agents/builtin/`; a same-name user file always outranks them

::: warning Note
Project-level profiles come from the repository itself — including repositories you have just cloned and do not trust yet. A project file named `agent.md` can replace the default main agent's entire system prompt. Before running Kiki in an unfamiliar repository, inspect its `.kiki/agents/` directory with the same caution you would apply to scripts.
:::

The full scope rules and directory list are in [Agent Locations](./agents.md#agent-locations).

## When changes take effect

Profile files under the user, project and extra-directory roots — plus `$KIKI_HOME/SYSTEM.md` — are watched: additions, edits and deletions reload automatically after roughly 200 ms, and a newly dispatched subagent picks up the reloaded version immediately. An existing session's main agent stays bound to the snapshot taken when the session was created, so use **Rebuild context** to pick up your edit while keeping the conversation. See [Rebuilding a session context](./agents.md#rebuilding-a-session-context).

## Main agents and subagents

A session is driven by one **main agent**, which can dispatch **subagents** for focused sub-tasks. Both use the same profile file format; they differ in how they are used:

- **Main agent**: selected at session start with `--agent <name>` or `--agent-file <path>`, or switched in the GUI's profile selector. Profiles with `main: true` in frontmatter appear as main-agent candidates.
- **Subagent**: dispatched automatically by the main agent during the conversation, works in an isolated context, and brings back only its final conclusion. You can also name one directly, e.g. "use explore to map the files first".

Both `prompt_overrides` and the body inside each `model_profiles` entry can branch on where the agent actually runs. Omit a branch or set it to `same` to use the common declaration, `off` to skip that declaration, or supply an object to replace it for that position. Subagents use the common declaration. These branches change prompts only, not model selection or permissions, and top-level `main: true` still only marks a main-agent candidate. [Model cognition](../configuration/config-files.md#models) supports the same selection for overlay, steering and anchor files.

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

The two objects replace independently: the `main` body replaces the common `prompt_mode` / `prompt` pair, and the `main` field object replaces that declaration's files and fields. Put anything from the common declaration you still want into the object. Identity comes from the live binding, not from the profile name or its `main: true` flag — an externally delegated agent uses `independent`.

When a profile runs as a subagent, one extra layer sits on top of its `tools` and `disallowedTools` lists: tools that stay off for subagents until something names them, such as `ThreadRead`, `AskUserQuestion` or `Cron`. Naming one in `tools` opens that tool for this profile as a subagent, and nothing else changes. Putting the wildcard beside the name keeps the ordinary tools available:

```yaml
tools: ["*", ThreadRead]
```

`*` on its own opens no opt-in and never crosses a deny. A finite list stays finite: `tools: [Read, Grep, ThreadRead]` selects exactly those three. The server-wide `subagent.allowed_tools` is an alternative to naming the tool here, but the profile still has to select it — which is what the `["*", ThreadRead]` form is for. A profile with no list, or `*`, is open to everything that entry allows, and its own `disallowedTools` still denies. A main conversation is not subject to these opt-ins; the profile's own lists decide there. See [Subagent defaults](../configuration/config-files.md#subagent) for the full list and the tools that stay main-only.

To permanently replace the default main agent's configuration, use the one special file: `$KIKI_HOME/SYSTEM.md` (default `~/.kiki/SYSTEM.md`). A body-only `SYSTEM.md` replaces just the default main agent's system prompt; one starting with `---` frontmatter can also change profile fields such as `tools`, `subagents` and the model binding. See [Overriding the main agent's system prompt with SYSTEM.md](./agents.md#overriding-the-main-agent-s-system-prompt-with-system-md).

## Model menus and hard boundaries

`model_profiles` gives you per-model parameters and prompts. By default it is a menu of candidates, not a list of the only models allowed. The frontmatter field `restrict_models_to_menu` takes a boolean and defaults to `false`; set it to `true` to make the menu binding's contract for subagents, so only the declared default `model_alias` and the `model_profiles[].alias` entries are permitted. It applies to main agents, subagents, registered profiles and explicit profile files — not to routes, caller leases (caller-supplied child configuration), `spawn_constraints`, or menu entries — and enabling it on a parent does not enable it on children.

To express a complete permitted set, keep one positive list rather than repeating it in `allowed_models`:

```yaml
model_alias: fast-model
restrict_models_to_menu: true
model_profiles:
  - alias: review-model
    when: A more thorough review is needed.
    thinking_effort: high
```

This menu holds `fast-model` and `review-model`, and the default needs no duplicate entry. Models are compared by the executor's canonical identities, not by alias suffix. Changing the default changes the menu: unless the old default is also listed in `model_profiles`, replacing it drops that model and adds the new one.

The switch adds one hard allow domain. It does not change selection priority and does not pick the first menu entry for you. Kiki captures the profile's original default and menu after directory and scope resolution and freezes them with the binding, so explicit dispatch parameters, route / lease pins, a saved effective model, and a lease that replaces `model_profiles` cannot widen it. Replacing entries with a subset or an empty list neither erases nor narrows that frozen menu — use `allowed_models` for an extra hard restriction.

A caller lease that supplies `model_profiles` replaces the child's menu and parameter defaults but keeps the original role-model prompts by default (`model_prompts: preserve`): Kiki matches the child's final alias in both sources, applies the role prompt first and the lease prompt second, and merges field overrides in that order. `model_prompts: replace` drops only the original prompts; the frozen menu and hard rules stay. A lease applies to children only, so its own model-body and field declarations cannot contain `main` or `independent` branches.

For a session's **main agent**, your model choice takes priority over profile constraints. A recommendation or default pin produces no warning, and a model outside a hard domain produces only a non-blocking one; the GUI keeps configured models selectable and does not block sending. Availability and provider / executor capabilities are still checked. A `main: true` profile dispatched through `AgentRun` is a subagent, not a main session.

For **subagent bindings** these rules apply in the GUI, the CLI, `AgentRun` and the API alike:

- **An out-of-menu selection is rejected, never downgraded.** It returns `profile.constraint_violation` without falling back to the default. Leaving the model out still selects one through the usual default rules and then validates it against the menu; if that model is outside the menu the binding is rejected rather than replaced by a menu entry you did not choose.
- **Other hard rules still apply.** The menu intersects with every applicable `allowed_models` list, and a `deny_models` match always rejects. `"*"` cannot widen it. A menu equal to an `allowed_models` list is redundant, not an error; differing lists intersect, and neither layer is ignored.
- **`when` is a hint, not a gate.** It is text for the caller and is never evaluated, so a missing or apparently unmet hint changes nothing. `preferred_*` and `discouraged_models` stay advice, and menu order is not a fallback chain.
- **An empty set permits nothing.** An empty menu with a default restricts binding to that one model; with neither menu nor default, no candidates, or an empty intersection with another hard domain, the binding is rejected.
- **Resuming does not widen anything.** `resume` revalidates the frozen menu and saved hard rules plus the caller and machine rules in force now, and a rejection leaves the saved binding as it was. Changing the model still needs `allow_model_change: true`, which is not permission to leave the menu. Editing the file does not rewrite existing snapshots: a new binding uses the new definition, an existing session needs an explicit rebind or a new session.

To get past a subagent rejection, pick a menu entry that also satisfies the other hard rules, or edit the profile. A pin, a manual selection, or confirming a model change are not ways around the menu.

### When to enable it

Turn the switch on for a profile whose `model_profiles` is already the complete set you want to permit. Leave it off for a general-purpose profile, or a menu that only lists examples.

| What you are expressing | Configuration |
| --- | --- |
| The default and menu entries are the complete permitted set, with per-model parameters or prompts, shared by the GUI and callers | Enable `restrict_models_to_menu`; you do not need an equivalent `allowed_models` list |
| Advice about cost, speed or experience, where users should still be able to try other models | Leave it off; use `preferred_models`, `preferred_efforts` or `discouraged_models` |
| A real budget, compliance, deployment or descendant-tree boundary, independent of the menu | Use `allowed_models` / `deny_models` on their own, and combine with the switch only if you also want the menu enforced |

See [Agent file format](./agents.md#agent-file-format) for the field reference and more examples.

## Customization mechanism map

Each mechanism below changes a different thing. Decide what you want to change first, then pick:

| What you want to change | Use |
| --- | --- |
| A reusable identity and private memory across conversations | [Personas, Bots, and rooms](./personas.md) |
| An agent's execution instructions, tools, permissions or model | **Profile files** (this page and [Agents and Sub-Agents](./agents.md)) |
| One named passage inside the built-in prompts (language rules, tool descriptions) | [Prompt field overrides](./prompt-fields.md) |
| Expertise or workflows the agent picks up when relevant | [Agent Skills](./skills.md) |
| Prompt snippets you trigger yourself with `/name` | [Custom prompt commands](./skills.md#custom-prompt-commands) |
| Packaging profiles, Skills, commands and hooks for a team | [Plugins](./plugins.md) |
| Reacting to tool calls and session events | [Hooks](./hooks.md) |
| Terminal color scheme | [Custom Themes](./themes.md) |

## Next steps

- [Agents and Sub-Agents](./agents.md) — profile field reference, dispatch behavior, SYSTEM.md, and runtime details
- [Agent Skills](./skills.md) — inject reusable workflows into agents
