---
name: kiki-ops
description: 'Configure or troubleshoot Kiki itself: first-run, provider/default-model, config.toml, tui.toml, WebSearch/FetchURL, sessions, subagents, background tasks, requirements board, approvals, MCP, plugins, themes, errors. Do not use for ordinary tasks.'
when_to_use: The user asks how Kiki works or how to change it - stop approval prompts or pick a permission mode, plan mode or /goal, scheduled (cron) prompts, plugins or skills, connecting the GUI or a token, adding a provider or switching model, web search, subagents or agent profiles, a Kiki error message, or where a GUI feature is and how to use it.
---

# Kiki operations (kiki-ops)

Help the user use, configure, and troubleshoot the installed Kiki. Creating or editing an agent profile or `SYSTEM.md` belongs to `kiki-profile`; load it for that.

## Decision path

1. **Classify the intent.** Question → answer. Change → configure. Breakage → troubleshoot. If the user only needs where a control is, name it and stop.
2. **Check state before asking.** Read the config or run a read-only check (`/status`, `/mcp`, `CronList`, `TaskList`). Ask only for what you cannot infer.
3. **One change at a time.** Say what changes and where (GUI location, or file + key), make it, verify.
4. **Verify the effect, not the write.** Re-read the setting and exercise it (one search, one tool call, the profile in the dispatch list). Report what was verified and what still needs `/reload` or a new session.

## Ground truth: installed docs

Docs matching this version live in `<KIKI_HOME>/docs/{en,zh}/` (`KIKI_HOME`, else `~/.kiki`; on the server host). `Grep`/`Read` them before stating a key, command, or behavior; cite the path. Never use upstream Kimi Code docs; if the docs do not settle it, say so.

| Topic | Doc |
| --- | --- |
| GUI layout, queue, approvals; modes (permission, plan, shell) | `guides/interface.md`, `guides/interaction.md` |
| Goals; sessions, fork, export, requirements board | `guides/goals.md`, `guides/sessions.md` |
| Every `config.toml` key; providers, env vars, data paths | `configuration/*.md` |
| Subagents, profiles, peer threads; skills, plugins, hooks, themes | `customization/*.md` |
| Slash commands, CLI, tools (incl. cron); MCP, server token | `reference/*.md`, `server/{mcp,local-server}.md` |

## Where things are

- **GUI Settings** (`/settings/<id>`): General (language, theme, composer) · Models & providers (Connections / Available models / Defaults — default permission mode and Reviewer are under Defaults) · Agents · Subagent rules · Agent communication · Plan & tasks · Skills · MCP · Plugins · Tools & automations (tool policy, hooks) · Search & retrieval · Workspaces · Connection · Advanced · About & updates.
- **Elsewhere in the GUI:** Task board (`/board`), Scheduled tasks (`/cron`), Dispatch capabilities (right rail); per-session model, permission mode, and plan mode in the composer.
- **TUI:** `/login`, `/provider`, `/model`, `/permission`, `/plan`, `/goal`, `/mcp`, `/plugins`, `/theme`, `/settings`. **CLI:** `kiki doctor`, `kiki provider`, `kiki export`.
- **Files in `<KIKI_HOME>`:** `config.toml`, `credentials.toml` (secrets), `tui.toml` (terminal only), `mcp.json`. Project MCP: repo-root `.mcp.json`, then `.kiki/mcp.json`; later wins by server name.

## Topic notes

- **Permission modes** (composer or `/permission` per session; `default_permission_mode`, default `auto`, for new ones): `manual` asks before anything not on the safe list · `auto` approves routine work and plan exits, but sensitive files, external links, and dangerous Bash still ask · `review` is `auto` with a `[permission.reviewer]` deciding first and asking the user only when unsure · `yolo` approves everything, sensitive files included. `[[permission.rules]]` `deny`/`ask` win in every mode. "Stop asking me" usually means `auto` or one `allow` rule; name the tradeoff before suggesting `yolo`.
- **Plan and goals.** Plan mode via the composer or `/plan` (`default_plan_mode` for new sessions). `/goal <objective>` runs until complete, blocked, or paused; the objective needs a finish line and evidence.
- **Scheduled tasks.** `CronCreate`/`CronList`/`CronDelete` schedule prompts into this session (5-field cron, local time). Unattended fires cannot get approvals: requests are cancelled, questions dismissed.
- **Search and fetch.** The default `WebSearch` lane, `github.repositories`, covers repositories only. General web search needs a provider lane, its credential (Search & retrieval → Services & credentials, or the slot's env var on the server), and `[nb_search.defaults] search_lane`. `FetchURL` works keyless. Keys never go in `config.toml`.
- **Connection.** The desktop app finds or starts a local server itself. A browser needs the URL and the token in `<KIKI_HOME>/server.token`; `kiki web rotate-token` replaces a leaked one; `kiki doctor` checks reachability.
- **Subagents vs threads.** `AgentRun` starts a child in this session that reports back. `ThreadCreate` opens an independent session, only when the user asks.

## First-run and guided setup

The GUI wizard already covers language, theme, a model connection, workspace, and default permission mode (recommends `auto`), then offers starter prompts such as "Set up web search". A setup request usually means finishing what is missing.

1. Detect what is done (provider, default model, permission mode, search lane) and say it in one line.
2. Ask one question at a time, about the most important gap, with a default ("Kimi sign-in is quickest; use it?"). Keep answers already given.
3. Credentials never go through chat: OAuth via `/login` or Models & providers → Connections; API keys via the Settings credential field or `credentials.toml`. Never echo a key.
4. Web search, MCP, plugins, and subagent roles are opt-in: offer them once at the end.
5. Only if the user wants subagent roles: Ask whether to create `implementer` (owns an engineering task through verification), and ask separately about `reviewer` (read-only check). Load `kiki-profile` for the template, confirm the destination under `<KIKI_HOME>/agents/` is free, and Copy the template with its `model_alias: inherit` frontmatter unchanged.
6. Finish with a short summary: changed, verified, still needs a new session. No secrets.

**Asking.** Use `AskUserQuestion` for discrete choices, also in `auto` and `review` (main agent only). If it is dismissed because no interactive user is attached, ask in your text response. With a background question, hold the dependent change until the answer arrives. Free-form values (a custom endpoint) go in a plain question.

## Changing files safely

Prefer the GUI page or a dedicated command. For a direct edit:

1. Resolve the real path and read the file; on a parse error, stop instead of overwriting.
2. Confirm key, type, and section in `configuration/config-files.md`; keep unrelated entries and comments.
3. Back up with a timestamp, write, re-read. Never overwrite a user file without permission.
4. Apply: `/reload` in the TUI for `config.toml` (the server also watches `config.toml` and `credentials.toml`; confirm the effect), `/reload-tui` for `tui.toml`. Profile, skill, and MCP changes may need a new session or **Rebuild context**.

For a deprecation warning, rename exactly the named key and keep its value; env-var warnings are fixed where the variable is set.

## Troubleshooting

- **Tool refused or approval never came:** permission mode, `[[permission.rules]]`, and whether a client was attached (scheduled runs have none).
- **Model or provider error:** `/status` for the active model; Models & providers → Connections for credentials. Never invent a model id.
- **MCP server needs OAuth:** call its `mcp__<server>__authenticate` tool and show the URL verbatim.
- **Turn exceeded the step limit:** raise `loop_control.max_steps_per_turn`.
- **Anything else:** `<KIKI_HOME>/logs/kimi-code.log` and the session's `logs/`; `kiki export` or `/export-debug-zip` for bug reports.

Keep secrets out of chat, logs, and examples, and keep the GUI machine and the server host apart when they differ.
