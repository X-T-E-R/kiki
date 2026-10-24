---
title: What Kiki Can Do
---

# What Kiki Can Do

Kiki is an open-source AI agent workbench that runs on your machine. Hand it a folder and the outcome you want — an unfamiliar codebase mapped out, a stack of PDFs and spreadsheets cross-checked, a report drafted, or a multi-file engineering change shipped — and the lead session plans the work, dispatches separable parts to subagents, and keeps the target in view across turns.

Work files stay in the folder you pick; sessions, history, and configuration stay in your local Kiki home, and model requests go only to the providers or local servers you connect. The desktop app, the terminal UI (`kiki`), and the browser UI (`kiki web`) all connect to the same local daemon, so you can start a task in one window and pick it up in another.

![The Kiki workbench: the subagents a lead session dispatched, an active goal, and a queued message, all on one screen.](/shots/index/wl-20261005-hero-workbench.en.png)

New to Kiki? Start with [Installation](/en/getting-started/installation) and [First launch](/en/getting-started/first-launch), then come back here. Already running it? Browse by what you want to get done — each section below matches the left sidebar and links to the dedicated feature page and settings entry.

## Multi-model & parallel work

When a job outgrows a single turn or a single model, Kiki splits the work across specialized roles and models while keeping long-running goals and project memory intact.

- **[Subagents & Multi-Model](/en/features/workbench)**: the main agent dispatches isolated subagents and lets you bind planning, exploration, and review to different models or vendors in the same session. Open any subagent to read its transcript or message it directly, while background tasks notify the lead session when they finish.
- **[Agent Profiles](/en/features/agent-workflows)**: each role is a plain Markdown file defining its model, thinking effort, allowed tools, starting system prompt, and permitted child agents. Start from shipped roles and the `implementer` / `reviewer` templates, or write your own with live hot reload.
- **[Goals, Queues, Cron & Memory](/en/features/long-work)**: keep an outcome in view across turns with `/goal`, queue messages while the agent is busy with per-message delivery timing, schedule recurring local-timezone prompts, track workspace requirements on the optional `kiki-task-board`, choose context renewal (`Summarize`, `Fresh`, `Auto`), and manage undoable memory across global, workspace, and persona scopes.
- **[Personas & Discussion Rooms](/en/features/people)**: give a standing collaborator (Persona) its own identity, isolated memory, and fixed daily conversation entry, or pull two to six personas and existing session threads into a moderated room under a host and a message budget.

![Several models in one session: a dispatch tree with a different model bound to each role.](/shots/workbench/workbench-per-role-models.en.png)

## Browser & computer control

When work moves beyond local files into live web pages, signed-in dashboards, or desktop software that has no API, open **[Browser & Computer Control](/en/features/browser-and-computer)** to set up and enable what you need. Kiki's browser driver, any independent browser it starts, and computer control run on the Kiki server machine, while you can also attach to an existing local or remote browser.

- **[Browser control](/en/features/browser-and-computer#browser-control)**: after component setup and per-browser approval, agents can open pages, read snapshots, click, fill forms, and take screenshots. Drive your everyday signed-in browser through the **Kimi or Codex browser extensions**, run a **Kiki-managed independent browser** with isolated cookies, connect a self-installed **Ego Lite** setup, or attach over **CDP** to an existing local or remote browser.
- **[Computer control](/en/features/browser-and-computer#computer-control)**: two desktop control paths, both requiring your manual installation and approval — install the pinned open-source executor under [Settings → Computer control](/en/guides/settings#computer-control) (models default to CLI, API, scripts, and browser tools unless you ask for desktop control or switch the preference to **Prefer**), or install the **[Kimi Computer Use plugin](/en/customization/plugins#kimi-computer-use)** (silent background clicks and typing on macOS; interactive desktop control on Windows).

## Documents, data & media

Through **[Plugins, Skills, MCP & Search](/en/features/extend)**, equip the workbench with document extraction, Office editing, structured datasets, media generation, and inspectable web retrieval:

- **Local document extraction and Office files**: install on-demand plugins from the **Official** catalog — `Kiki Extract` (local PDF, Office, HTML, and text to Markdown without modifying originals), `Kiki Office Suite` (create and edit local Word, Excel, and PowerPoint files), `Kiki Work` (audit CSV/TSV keys and reconcile two tables locally without uploading), and `Kiki Writing` (manuscript panel and draft commands).
- **Structured datasets, external services, and media generation**: install `Kimi Datasource` to query stock markets, macro indicators, corporate records, academic papers, and Chinese law in natural language; connect `Kiki Notion` to search and write back to Notion; or configure image, video, and speech providers under `Kiki Media`.
- **Inspectable web search, fetch chains, Skills, and MCP**: use `WebSearch` to find pages and `FetchURL` to read their contents. The default lanes work without a key, and you can connect specialized lanes for repositories and docs. In **Settings → Capabilities → Search & retrieval**, inspect credential sources, key rotation, and the exact sequence of extractors and fallbacks a URL passes through. Package reusable workflows as Markdown [Agent Skills](/en/customization/skills), or connect external tools over `stdio`, `HTTP`, or `SSE` via [MCP](/en/server/mcp).

![The fetch chain tab, with the pipelines a web address is read through in order and what each one falls back to.](/shots/extend/ce-20261005-extend-fetch-chain.en.png)

## Usage, models & permissions

What the agents are doing, what they cost, which rule is holding a waiting request back, and the exact prompt text a model receives are all visible and editable in the workbench.

- **[Timeline, Approvals & Usage](/en/features/daily)**: folded tool steps, message annotations, the "Needs you" approval tray, and the focus-following right rail keep busy sessions readable; the **Usage** page shows historical cost with honest completeness flags rather than fake zeros, live concurrency rules (with rule IDs) holding waiting requests, remaining account quotas, and consented content-free external sync.
- **[Models, Prompts & Permissions](/en/features/freedom)**: manage API keys, OAuth subscriptions, and local servers in one list, including reusing an existing local ChatGPT (Codex) or Grok Build app sign-in after **Check this machine**; override prompt fields down to a single tool description (`kiki prompt-fields`), and govern actions with four permission modes (`manual`, `auto`, `review`, `yolo`), Plan mode, and lifecycle Hooks.
- **[Skins, Fonts & Backgrounds](/en/features/look)**: choose from six built-in light and dark skin families (plus appearance packs and TUI themes), tune accent color, font, radius, and density live, or set a local image or video background with automatic text-contrast protection.

![The Live tab on the Usage page: active and queued counts per model, one waiting request naming the kimi-cap rule holding it, and concurrency limit rules below with one enabled and one disabled.](/shots/daily/ux-usage-live.en.png)

## Phone, remote & tools

Sessions and configuration stay in your local Kiki home by default, and connect across workspaces, machines, phones, and external harnesses only where you open a door.

- **[Spaces, Remote Links & SSH](/en/features/spaces)**: separate work and personal setups with **Spaces** (shared or isolated credentials, plus **Work mode** presets); connect two Kiki homes over mutually approved one-way **remote connections** or message-only **thread bridges**; open your workbench to another browser with single-use `kiki web` links; or attach **SSH** hosts to a session to edit remote files over SFTP and run remote commands.
- **[Phone Session](/en/features/phone)**: pair a WeChat account by QR code or connect a QQ bot under **Settings → Notifications & messages** to route chats to a persona or session; send messages from your phone (queued or steered into the active turn), read replies, and answer pending questions and approvals with option numbers.
- **[History Import, IDEs & Engines](/en/features/ecosystem)**: preview and import conversations from Claude Code, Codex, Pi, Grok Build, or OpenCode as continuable sessions or read-only archives; drive Kiki inside Zed, JetBrains, and other IDEs over `kiki acp`; fix an inbound MCP seat with `kiki seat`; or run subagents on external harnesses with Kiki context bridging.

![Importing history: six readable sources and a preview of one conversation showing what will not be carried over.](/shots/ecosystem/ecosystem-history-import.en.png)

## All feature pages

| Page | When you need it | What it covers |
| --- | --- | --- |
| [Subagents & Multi-Model](/en/features/workbench) | A task is bigger than one turn or one model | Shared local daemon across desktop / TUI / Web, isolated subagents, per-role model binding, subagent transcripts, background tasks |
| [Agent Profiles](/en/features/agent-workflows) | You want reusable specialist roles | Single-file Markdown profiles, model and effort inheritance, shipped roles and `implementer` / `reviewer` templates, live hot reload |
| [Goals, Queues, Cron & Memory](/en/features/long-work) | Work spans hours, days, or a recurring schedule | Cross-turn `/goal`, busy message queue with per-message timing, scheduled prompts, optional task board, context renewal, and 3-scope memory |
| [Personas & Discussion Rooms](/en/features/people) | You want a standing collaborator or multi-perspective room | Persona cards, fixed daily conversation entry, isolated persona memory, and moderated rooms for 2–6 personas or threads |
| [Browser & Computer Control](/en/features/browser-and-computer) | The task needs a live browser or desktop GUI app | Everyday signed-in browser extensions, independent browser, Ego Lite, and CDP attachment; built-in desktop executor and Kimi Computer Use plugin |
| [Plugins, Skills, MCP & Search](/en/features/extend) | Work involves PDFs, Office files, datasets, web search, or media | Local PDF/Office extraction and editing, CSV audit, financial & academic data, media generation, `WebSearch` & `FetchURL` lanes, `/skill`, and MCP |
| [Timeline, Approvals & Usage](/en/features/daily) | You are watching progress, cost, or a waiting request | Folded step timeline, message annotations, "Needs you" tray, focus-following right rail, and Usage (history cost, live rule IDs, quotas, external sync) |
| [Models, Prompts & Permissions](/en/features/freedom) | You want to customize model auth, prompts, or approvals | Unified connections and OAuth list, reusing local ChatGPT / Grok Build sign-ins, `kiki prompt-fields` overrides, permission modes, and Hooks |
| [Skins, Fonts & Backgrounds](/en/features/look) | You want the window to match how you read | Six built-in light and dark skin families, live accent and font tuning, contrast-checked image and video backgrounds, appearance packs, and TUI themes |
| [Spaces, Remote Links & SSH](/en/features/spaces) | You separate work and personal accounts, or work across hosts | Multi-space credential isolation or sharing, Work mode presets, mutually approved remote connections, thread bridges, Web access links, and in-session SSH |
| [Phone Session](/en/features/phone) | You are away from the desk and a step is waiting | WeChat QR and QQ bot pairing, per-contact routing to personas or sessions, busy steering vs. queueing, and numeric replies for approvals |
| [History Import, IDEs & Engines](/en/features/ecosystem) | You also use Claude Code, Codex, Cursor, Zed, or JetBrains | Previewed history import, `kiki acp` IDE integration, `kiki seat` inbound MCP seats, and external executor harnesses with Kiki context bridging |
