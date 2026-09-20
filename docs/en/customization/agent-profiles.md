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

## Main agents and subagents

A session is driven by one **main agent**, which can dispatch **subagents** for focused sub-tasks. Both use the same profile file format; they differ in how they are used:

- **Main agent**: selected at session start with `--agent <name>` or `--agent-file <path>`, or switched in the GUI's profile selector. Profiles with `main: true` in frontmatter appear as main-agent candidates.
- **Subagent**: dispatched automatically by the main agent during the conversation, works in an isolated context, and brings back only its final conclusion. You can also name one directly, e.g. "use explore to map the files first".

To permanently replace the default main agent's configuration, there is one special file: `$KIKI_HOME/SYSTEM.md` (default `~/.kiki/SYSTEM.md`). A body-only `SYSTEM.md` replaces just the default main agent's system prompt; an upgraded file starting with `---` frontmatter can also change profile fields such as `tools`, `subagents`, and the model binding. Precedence details are in [Overriding the main agent's system prompt with SYSTEM.md](./agents.md#overriding-the-main-agent-s-system-prompt-with-system-md).

## Customization mechanism map

Kiki has six customization mechanisms, each owning one concern. Decide what you want to change first, then pick the mechanism:

| What you want to change | Use |
| --- | --- |
| An agent's identity, system prompt, tools, or model | **Profile files** (this page and [Agents and Sub-Agents](./agents.md)) |
| One named passage inside the built-in prompts (e.g. language rules, tool descriptions) | [Prompt field overrides](./prompt-fields.md) |
| Expertise or workflows the agent invokes automatically when relevant | [Agent Skills](./skills.md) |
| Prompt snippets you trigger yourself with `/name` | [Custom prompt commands](./skills.md#custom-prompt-commands) |
| Packaging profiles, Skills, commands, and hooks for a team | [Plugins](./plugins.md) |
| Intercepting or notifying on tool calls and session events | [Hooks](./hooks.md) |
| Terminal color scheme | [Custom Themes](./themes.md) |

## Next steps

- [Agents and Sub-Agents](./agents.md) — profile field reference, dispatch behavior, SYSTEM.md, and runtime details
- [Agent Skills](./skills.md) — inject reusable workflows into agents
