---
name: kiki-ops
description: Configure, operate, or troubleshoot Kiki itself. Use for Kiki product questions, first-run provider, authentication, and default-model setup, config.toml or tui.toml changes, WebSearch/FetchURL setup, sessions, subagents, background tasks, the requirements board, MCP, themes, imports, and interpreting Kiki errors. Do not use for ordinary coding, writing, research, or other project work that merely happens inside Kiki.
---

# Kiki operations (kiki-ops)

Help the user use, configure, and troubleshoot the installed Kiki product. This is the single general Kiki operations skill. Ground answers in the documentation installed with the running version, keep configuration changes narrow and reversible, and continue a setup flow step by step instead of only describing it.

Agent profile authoring is intentionally separate. If the user wants to create or modify an agent profile or `SYSTEM.md`, load `kiki-profile` instead.

## Installed documentation is the source of truth

Kiki installs version-matched documentation under `<KIKI_HOME>/docs/`, where `<KIKI_HOME>` is the configured `KIKI_HOME` value or the platform default `~/.kiki`. Resolve the actual data root before reading files; never assume the default when `KIKI_HOME` is set.

Choose the user's locale when available and fall back to `en/`. Use `Glob`, `Grep`, and `Read` against the local Markdown tree before answering questions about product behavior. Do not fetch upstream Kimi Code documentation to explain Kiki: this fork may differ.

Start with the most specific area:

| Question | Local documentation |
| --- | --- |
| Installation, first launch, migration | `{locale}/getting-started/` |
| GUI/TUI interaction, sessions, goals, settings | `{locale}/guides/` |
| Profiles, skills, plugins, hooks, themes | `{locale}/customization/` |
| `config.toml`, providers, search/fetch, environment, data paths | `{locale}/configuration/` |
| Slash commands, CLI commands, tools, keyboard | `{locale}/reference/` |
| MCP, local server, IDE/ACP, REST/SDK | `{locale}/server/` |
| Version history | `{locale}/release-notes/changelog.md` |

Cite the local relative paths used. If the installed docs do not establish a claim, say so instead of inventing a key, command, model id, or error meaning.

## First-run configuration guide

When the user opens a new session with `/kiki-ops help me configure...`, `/kiki-ops 帮我配置...`, or an equivalent onboarding prompt, act as an interactive setup guide. Do not answer with a static checklist and stop.

1. Ask which provider type they want: Kimi Code OAuth, an API-key provider from Kiki's catalog, or a custom OpenAI-/Anthropic-compatible endpoint. If they are unsure, explain the choices briefly before asking them to select one.
2. Ask which authentication method that provider supports or they prefer: OAuth or API key. Never ask the user to paste a secret into ordinary chat. Route OAuth through the product login flow; route an API key through the secure Settings/provider credential field or the documented environment/config mechanism, and never echo a key back.
3. Ask which configured model should be the default. If the provider exposes a catalog, help the user select an available model rather than guessing an id.
4. Ask whether they need web search, URL fetching, both, or neither. If either is wanted, continue through the search and retrieval setup below.
5. Offer two optional example subagent profiles separately: `implementer` owns an engineering task through verification and handoff; `reviewer` independently checks work as a read-only leaf. Ask whether to create `implementer` in `<KIKI_HOME>/agents/implementer.md`, then ask separately about `reviewer` in `<KIKI_HOME>/agents/reviewer.md`. Neither is installed automatically. Only after an affirmative answer for a particular role, load `kiki-profile` for its complete embedded template, check that role's destination does not already exist, and create only the approved file. Copy the template with its `model_alias: inherit` frontmatter unchanged: this follows the model the parent is using at dispatch time without pinning a provider. Tell the user they can later switch to a fixed model in Settings. If a file already exists, leave it alone unless the user explicitly approves replacing it.
6. Apply one step at a time using the available GUI management surface or documented commands. After each step, verify the resulting provider/model/tool readiness and each created profile actually loads before moving on.
7. Finish with a compact summary of the selected provider, auth method, default model, search/fetch readiness, profiles created or declined, files or settings changed, and any reload/new-session action still required. Never include secret values.

Use `AskUserQuestion` for discrete choices when available. Free-form values such as a custom endpoint belong in a plain question. If the invocation already supplies an answer, keep it and ask only for missing information.

## Configuration workflow

Prefer the GUI Settings pages or dedicated management commands when they expose the requested setting. For file-level work, first read the matching installed documentation and the current file:

- `<KIKI_HOME>/config.toml`: providers, models, default model, permissions, subagents, MCP defaults, search/retrieval, and runtime behavior.
- `<KIKI_HOME>/tui.toml`: terminal theme, editor, notifications, status line, and other TUI preferences.
- `<KIKI_HOME>/mcp.json` and project `.kiki/mcp.json`: MCP server declarations.

For a direct file change:

1. Resolve the real path and read the existing file. Stop on parse errors instead of overwriting a broken file.
2. Confirm the exact documented key, section, type, and scope. Preserve unrelated entries and comments.
3. Work on a candidate copy, validate it with the documented Kiki command or parser, create a timestamped backup of the original, then replace it.
4. Explain how the change takes effect: `/reload` for runtime config, `/reload-tui` for TUI preferences, `/theme` for selecting a theme, or a new session when the capability is session-scoped.

Treat deprecation warnings literally: rename only the key named by the warning and keep its value. Environment-variable warnings must be fixed where that environment variable is set, not by inventing a TOML entry.

## Search and URL-fetch setup

`WebSearch` and `FetchURL` use Kiki's built-in search and retrieval module. Read `{locale}/configuration/config-files.md#nb-search`, `{locale}/configuration/env-vars.md`, and `{locale}/reference/tools.md` before changing it.

- Search needs an available lane and normally a `[nb_search.defaults] search_lane`. Configure the selected provider's credential slot through its documented environment variable; do not store secret values in `config.toml`.
- URL fetch uses the configured fetch chain. The built-in URL chain can work independently from a search lane; do not claim search and fetch have identical credential requirements.
- The GUI's **Settings → Search & retrieval** page shows the active source and whether local nb-search configuration is reused. For a remote Kiki server, settings, files, and environment variables belong to the server host, not the browser machine.
- After configuration, run one small search and one harmless public URL fetch for the capabilities the user enabled. Report tool readiness separately; a saved setting is not proof that a provider is reachable.

## Core operating map

- **Sessions and workspaces:** `/new` starts a new session, `/sessions` resumes one, `/fork` creates an independent copy, and `/compact` compresses context. The GUI groups sessions by workspace. Read `{locale}/guides/sessions.md` for persistence, recovery, export, and activity behavior.
- **Subagents:** the main agent can dispatch focused child agents with `AgentRun`, inspect them with `AgentList`, and message them with `AgentSend`. Each child has isolated context and returns a result to its parent. The GUI's **Dispatch capabilities** view shows effective profiles, models, routes, and launch constraints. Read `{locale}/customization/agents.md`.
- **Background tasks:** `TaskList`, `TaskOutput`, `TaskStop`, and `TaskWait` manage tracked background work. Completion notifications normally arrive automatically; do not busy-poll.
- **Requirements board and todos:** the GUI requirements board stores durable requirement cards and session references; `BoardRead`/`BoardWrite` operate on it. `TodoList` is a separate per-agent execution checklist, and background tasks are a third, separate runtime concept. Read `{locale}/guides/sessions.md#requirements-board`.
- **MCP:** `/mcp` shows status. Use `/kiki-ops configure MCP ...` or `/kiki-ops help me log in to MCP ...` for guided changes; inspect `{locale}/server/mcp.md` before editing declarations or starting OAuth.
- **Themes and imports:** use `/kiki-ops create a theme ...` or `/kiki-ops import from Claude Code/Codex ...`. Follow the installed customization and migration docs, preserve existing files, preview destructive changes, and never import credentials or session history.

## Safety and answer style

- Keep secrets out of chat, logs, examples, and committed files. Prefer OAuth or environment-backed credentials.
- State the target path and intended change before writing. Preserve unrelated settings and keep recoverable backups.
- Distinguish local GUI state from server-side state, especially when the GUI connects to a remote Kiki server.
- For read-only questions, answer directly after checking the local docs; do not turn every product question into a configuration flow.
