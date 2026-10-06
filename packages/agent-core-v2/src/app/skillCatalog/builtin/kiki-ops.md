---
name: kiki-ops
description: 'Use when configuring or fixing Kiki: providers/default-model, config.toml hot reload, concurrency limits/queues/429, Usage, tui.toml, WebSearch/FetchURL, sessions, subagents, MCP, approvals, plugins. Do not use for ordinary tasks or another app.'
when_to_use: The user asks how Kiki works or how to change it - first-run setup, request concurrency or queued requests, model/provider limits, 429 or request.queue_timeout errors, whether edits need a restart, Usage controls, memory maintenance reminders, effective prompts or Check all branches, cockpit/preview controls, permission or plan mode, /goal, scheduled (cron) prompts, background tasks, requirements board, themes, skills, GUI connection, providers or models, web search, subagents or agent profiles, or a Kiki error.
---

# Kiki operations (kiki-ops)

Help the user use, configure, and troubleshoot the installed Kiki. Creating or editing an agent profile or `SYSTEM.md` belongs to `kiki-profile`; load it for that. Creating a persona's identity, voice, greetings or avatar belongs to `kiki-persona`. Writing or repairing event hooks belongs to `kiki-hooks`. Making a GUI skin file or an appearance pack (colors, background picture or video) belongs to `kiki-appearance`.

## Decision path

1. **Classify the intent.** Question → answer. Change → configure. Breakage → troubleshoot. If the user only needs where a control is, name it and stop.
2. **Check state when needed.** For explanation-only questions, use documented defaults without reading private configuration. For diagnosis or edits, resolve the connected server host and actual `KIKI_HOME` before reading config or running a read-only check (`/status`, `/mcp`, `Cron` with `action=list`, `TaskList`); do not assume the browser's machine or default home is the target. Ask only for what you cannot infer.
3. **One change at a time.** Say what changes and where (GUI location, or file + key), make it, verify.
4. **Verify the effect, not the write.** Re-read the effective setting and check the relevant surface (Usage rules/counts, one search, the dispatch list). Report the observed result and the setting's actual apply timing.

## Ground truth: installed docs

Docs matching this version live in `<KIKI_HOME>/docs/{en,zh}/` (`KIKI_HOME`, else `~/.kiki`; on the server host). `Grep`/`Read` them before stating a key, command, or behavior; cite the path. Never use upstream Kimi Code docs; if the docs do not settle it, say so.

| Topic | Doc |
| --- | --- |
| GUI layout, queue, approvals; modes (permission, plan, shell) | `guides/interface.md`, `guides/interaction.md` |
| Goals; sessions, fork, export, requirements board | `guides/goals.md`, `guides/sessions.md` |
| Request concurrency, model/provider targets, queue errors, config hot reload | Read `configuration/config-files.md` → `[request_governance]` and Applying configuration changes; read `guides/settings.md` → Usage for GUI controls |
| Memory maintenance reminders | Read `configuration/config-files.md` → Continuity reminder settings before choosing `memory_maintenance` |
| Effective prompts, Check all branches, cockpit/preview controls | Read `guides/settings.md` → Session controls; use `customization/agents.md` → Rebuilding a session context / Instruction Files for reload and scoped rules |
| Every other `config.toml` key; providers, env vars, data paths | `configuration/*.md` |
| Subagents, profiles, peer threads; skills, plugins, hooks, themes | `customization/*.md` |
| Slash commands, CLI, tools (incl. cron); MCP, server token | `reference/*.md`, `server/{mcp,local-server}.md` |

## Where things are

- **GUI Settings** (`/settings/<id>`): General (language, theme, composer) · Models & providers (Connections / Available models / Defaults — default permission mode and Reviewer are under Defaults) · Agents · Subagent rules · Agent communication · Tasks · Skills · MCP · Plugins · Search & retrieval · Browser control · Computer control · Permissions (tool policy) · Hooks · Workspaces · Connection · Advanced · About & updates.
- **Elsewhere in the GUI:** Usage (`/usage`: History opens by default for tokens/cost; Live contains Request details and Concurrency limits; legacy `?panel=limits` links focus the rules on Live), Task board (`/board`), Scheduled tasks (`/cron`), Dispatch capabilities (right rail); per-session model, permission mode, and plan mode in the composer.
- **TUI:** `/login`, `/provider`, `/model`, `/permission`, `/plan`, `/goal`, `/mcp`, `/plugins`, `/theme`, `/settings`. **CLI:** `kiki doctor`, `kiki provider`, `kiki export`.
- **Files in `<KIKI_HOME>`:** `config.toml`, `credentials/credentials.toml` (secrets), `tui.toml` (terminal only), `mcp.json`. Project MCP: repo-root `.mcp.json`, then `.kiki/mcp.json`; later wins by server name.

## Topic notes

- **Permission modes** (composer or `/permission` per session; `default_permission_mode`, default `auto`, for new ones): `manual` asks before anything not on the safe list · `auto` approves routine work and plan exits, but sensitive files, external links, and dangerous Bash still ask · `review` is `auto` with a `[permission.reviewer]` deciding first and asking the user only when unsure · `yolo` approves everything, sensitive files included. `[[permission.rules]]` `deny`/`ask` win in every mode. "Stop asking me" usually means `auto` or one `allow` rule; name the tradeoff before suggesting `yolo`.
- **Plan and goals.** Plan mode via the composer or `/plan` (`default_plan_mode` for new sessions). `/goal <objective>` runs until complete, blocked, or paused; the objective needs a finish line and evidence.
- **Scheduled tasks.** `Cron` with `action=create/list/delete` schedules prompts into this session (5-field cron, local time). Unattended fires cannot get approvals: requests are cancelled, questions dismissed.
- **Search and fetch.** `WebSearch` defaults to keyless general-web `duckduckgo.search`: no registration, API key or lane selection is needed. Public HTML challenges or rate limits are errors; wait before retrying, or explicitly choose another configured source. Existing defaults, explicit selections and removals take precedence; failures never silently switch providers. Other sources are optional (Search & retrieval → Providers, and `[nb_search.defaults] search_lane`). `FetchURL` works keyless. Keys never go in `config.toml`.
- **Connection.** The desktop app finds or starts a local server itself. A browser needs the URL and the token in `<KIKI_HOME>/server.token`; `kiki web rotate-token` replaces a leaked one; `kiki doctor` checks reachability.
- **Subagents vs threads.** `AgentRun` starts a child in this session that reports back. `ThreadCreate` opens an independent session, only when the user asks.
- **Memory reminders.** Read the continuity settings before changing `[loop_control.continuity_cadence] memory_maintenance`. Omitted/`true` enables periodic maintenance during active work; `false` disables only that periodic reminder, not standing-instruction or pre-compaction checks, memory tools, approvals, or TodoList notes. No useful lasting change means no write. Do not duplicate pending memory proposals.
- **Session prompt diagnostics.** Header ⋯ → Effective prompts opens a drawer independently of the rail, even on narrow screens. Read the current identity, source/override states and latest actual-request evidence; a displayed composition is not proof it was sent. Check all branches is explicit and does not activate other identities. Use Rebuild context only when the user wants a source refresh, while idle.
- **Cockpit.** On desktop widths, the right-panel Standard / Cockpit selector temporarily gives the cockpit the preview space. Standard / Exit cockpit restores preview content, tabs, draft and width; exiting leaves the standard rail open. Opening a file, agent detail or skill preview restores the preview workspace. Do not suggest clearing preview state or changing the saved standard-panel width.

## First-run and guided setup

The GUI wizard already covers language, theme, a model connection, and default permission mode (recommends `auto`). Its last button, and one optional row per capability (web search, SSH host, MCP or plugin, scheduled task, bot), each open a session with a pre-filled `/kiki-ops` request. **Set up later** only closes the dialog — it never sends anything, so the user is not obliged to do any of this. A setup request usually means finishing what is missing.

The first-run request is broader than one capability: it asks what the user is here for, whether they want a first agent, and what Explore should run on. Walk it in that order and keep every step optional — an unasked-for change is worse than a missing one.

1. Detect what is done (provider, default model, permission mode, search lane) and say it in one line.
2. Ask one question at a time, about the most important gap, with a default ("Kimi sign-in is quickest; use it?"). Keep answers already given.
3. **What the user mainly uses Kiki for.** It decides whether a first agent is worth writing at all, so ask before creating one — and let the answer decide what kind. Only when the answer is engineering work *and* they want an agent, Ask whether to create `implementer` (owns an engineering task through verification), and ask separately about `reviewer` (read-only check). For any other use, do not walk them through engineering roles: create a profile for what they actually need, or none, and say "later" is a complete answer. Never offer a chain of roles. Load `kiki-profile` for the template, confirm the destination under `<KIKI_HOME>/agents/` is free, and Copy the template with its `model_alias: inherit` frontmatter unchanged.
4. **Explore's default model and effort.** A fresh subagent with no default has to name a concrete `model_alias` and `effort` on every single dispatch; setting a default removes that work once instead of forever. When no default is bound, that is the reason to offer one — not a fault to report, and the user never types an alias by hand, the main agent supplies it. When a default already resolves, say what it is and offer to keep it.
5. Offer a low-cost model from what is actually connected and in the catalog, matched to an effort that model really supports. Prefer what the user already pays for. If this machine exposes no cost or price data for the candidates, say so and let the user choose instead of inventing a ranking. Never name an alias from your own host.
6. Turning Explore off is a legitimate answer, and "leave it alone" is too. If the user wants that role gone but not the others, use its row switch in Settings → Agents (`disabled_named_profiles`) or `private: true` in its file — either removes it from dispatch and selection while running agents keep their snapshot. On the callers, `deny_subagents: [explore]` excludes that one name; `allowed_subagents` narrows the set, and `allowed_subagents: []` allows no presets while a definition supplied by path still works. There is no single switch for "no subagents at all": `[subagent] default_profile = ""` only makes a target mandatory, and the `agent` tool group in Permissions (tool policy) is the coarse gate for every child agent. Pick the narrowest one that matches the request, and name which you used.
7. Credentials never go through chat: OAuth via `/login` or Models & providers → Connections; API keys via the Settings credential field or `credentials.toml`. Never echo a key.
8. General-web search already works keyless by default; check it directly when requested instead of asking for a key. Additional search sources, MCP, plugins, and other subagent roles are opt-in: offer them once at the end.
9. Finish with a short summary: changed, verified, still needs a new session. No secrets.

**Verify the effect, not the write.** A file written is not a profile that loaded, and a saved value is not a value in effect. After enabling or configuring a role, re-read Dispatch capabilities (right rail) or Settings → Agents and confirm the effective binding is the chosen model and effort. After disabling one, confirm that role is gone from the dispatch list instead — that is the proof, and asking whether it still dispatches is the wrong question for a role the user just turned off. A spoken "done" is not configuration.

**Asking.** Use `AskUserQuestion` for discrete choices, also in `auto` and `review` (main agent only). If it is dismissed because no interactive user is attached, ask in your text response. With a background question, hold the dependent change until the answer arrives. Free-form values (a custom endpoint) go in a plain question.

## Changing files safely

Prefer the GUI page or a dedicated command. For a direct edit:

1. Resolve the real path and read the file; on a parse error, stop instead of overwriting.
2. Confirm key, type, and section in `configuration/config-files.md`; keep unrelated entries and comments.
3. Back up with a timestamp, write, re-read. Never overwrite a user file without permission.
4. Verify automatic reload for `config.toml` and `credentials/credentials.toml`: Kiki waits for stable content and retries incomplete saves. A parse failure retains the last valid configuration; fix the diagnostic instead of overwriting. Request rules re-evaluate queued work without a restart. Session defaults apply to new sessions; `identity` needs a process restart. Use `/reload-tui` for `tui.toml`; `/reload` remains an explicit TUI reload, not a required step for every edit. For profile, skill, and MCP edits, follow the topic's documented apply timing.

For a deprecation warning, rename exactly the named key and keep its value; env-var warnings are fixed where the variable is set.

## Request limits, queues, and 429

Read the installed `configuration/config-files.md` → `[request_governance]` before choosing a rule. Use the existing request-governance capability rather than inventing a subagent scheduling workaround.

1. **Identify what is limited.** Concurrent native model requests → `request_governance`; simultaneous child runs → `[subagent] max_direct_children/max_total_subagents`; Bash/background tasks → `[background]`; search/fetch calls → `[nb_search.execution]`. A request slot lasts through stream cleanup, not tool work or retry backoff. External executors are unmanaged.
2. **Choose the target and scope.** `models` uses exact canonical `[models]` keys, not display names, upstream model names, or alternate aliases. `providers` uses exact `[providers]` keys. IDs in one list share a combined cap; different selectors are AND, and all matching enabled rules apply. `global` shares capacity across this Kiki service's sessions, not independent CLI processes; `each_session` shares a bucket within each session's main/subagent tree. Add `subagents_only = true` only if main/system requests should be excluded.
3. **Inspect before adjusting.** Usage → Live shows active/queued counts; expand Request details for waiting time and blocking rule IDs. Stale counts are not current capacity. Usage → Live → Concurrency limits edits or pauses rules. `request.limit_rejected` means a full `reject` rule, `request.queue_full` means the shared queue is full, and `request.queue_timeout` means the cumulative local wait budget was exhausted. These do not automatically retry. Provider HTTP 429 / `provider.rate_limit` is separate: check the provider message, quota/balance, and `Retry-After`; `[retry]` controls transient retries, not exhausted quota.
4. **Apply and check.** Save the smallest matching rule, then verify it in Usage and check queued work. No rules means no cap; `enabled = false` pauses a rule; omit `max_concurrent` for no cap (zero is invalid). Rule edits automatically re-evaluate waiters and leave active streams running. Stop cancels a queued turn without sending it. Do not send paid test requests unless the task authorizes them. This is concurrency control, not a requests-per-minute, token, or money budget.

## Troubleshooting

- **Tool refused or approval never came:** permission mode, `[[permission.rules]]`, and whether a client was attached (scheduled runs have none).
- **Model or provider error:** `/status` for the active model; Models & providers → Connections for credentials. Never invent a model id.
- **MCP server needs OAuth:** call its `mcp__<server>__authenticate` tool and show the URL verbatim.
- **Turn exceeded the step limit:** raise `loop_control.max_steps_per_turn`.
- **Anything else:** `<KIKI_HOME>/logs/kimi-code.log` and the session's `logs/`; `kiki export` or `/export-debug-zip` for bug reports.
