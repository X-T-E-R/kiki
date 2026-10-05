# Kiki features

What each capability does for you, and where to read the details. The online **Features** section is the long-form tour; this page is the in-repo index. [Back to the README](../README.md) · [Screenshot tour](gallery.en.md) · [Online features →](https://x-t-e-r.github.io/kiki/en/features/)

## Start here

- **Install and first run.** Node.js 24.15.0+ for npm, or a desktop build from [GitHub Releases](https://github.com/X-T-E-R/kiki/releases). New sessions start in Auto mode; `/permission` switches among Manual, Auto, Review, and YOLO. [Installation →](https://x-t-e-r.github.io/kiki/en/getting-started/installation)
- **Three surfaces, one daemon.** The desktop app, `kiki` in the terminal, and `kiki web` read and write the same sessions. [Desktop app →](https://x-t-e-r.github.io/kiki/en/getting-started/desktop-app) · [Local server →](https://x-t-e-r.github.io/kiki/en/server/local-server)
- **Sign in.** Kimi Code OAuth or a Kimi Platform API key out of the box; Anthropic, OpenAI-compatible services, the OpenAI Responses API, Gemini, and Vertex AI can be added. [Providers and models →](https://x-t-e-r.github.io/kiki/en/configuration/providers)

## Give every role its own model

- **Subagents, each on its own model.** The main agent dispatches subagents itself, and each role can run a different provider's model, so a strong model can plan while cheaper models do the routine work. Each subagent has its own context, and you can open its transcript. [Named child agents →](https://x-t-e-r.github.io/kiki/en/customization/agents#named-child-agents)
- **Agents are files you own.** One Markdown file per agent: the frontmatter sets tools, model, effort, and which subagents it may dispatch, and the body is the system prompt. Create one by copying a profile, from a shipped template, or blank. [Agent file format →](https://x-t-e-r.github.io/kiki/en/customization/agents#agent-file-format)
- **Other agents as engines.** A profile can run on Claude Code, Codex, Cursor, Gemini CLI, Kimi CLI, OpenCode, or Grok Build through ACP or the Codex app-server. [Dispatch capabilities →](https://x-t-e-r.github.io/kiki/en/guides/settings#dispatch-capabilities)
- **Background tasks.** Long commands and subagents run in the background; when one finishes its result goes back to the agent automatically. [Background tasks →](https://x-t-e-r.github.io/kiki/en/reference/tools#background-tasks)

## Keep work going past the session

- **Goals.** `/goal` gives the agent a target it keeps working toward across turns, with edit, pause, and cancel controls. [Goals →](https://x-t-e-r.github.io/kiki/en/guides/goals)
- **The message queue.** Messages you send while the agent is busy wait instead of cutting in, and each can go out when the agent is idle, after its subagents finish, or after its tasks finish. [Queue →](https://x-t-e-r.github.io/kiki/en/guides/interface#input-box)
- **Scheduled prompts.** The agent can schedule a prompt once or on a cron expression. A schedule fires while a Kiki process holds that session open. [Scheduled tasks →](https://x-t-e-r.github.io/kiki/en/reference/tools#scheduled-tasks)
- **Task board.** Each workspace has a board where requirements are cards linked to the sessions working on them; the main agent reads and updates it. [Task board →](https://x-t-e-r.github.io/kiki/en/guides/sessions#task-board) · [Spotlight →](task-board.en.md)
- **Context that lasts.** You set the compaction point, and at it the agent compresses into a summary, restarts from its working notes, or picks per run. [Context compression →](https://x-t-e-r.github.io/kiki/en/guides/sessions#context-compression)
- **Memory.** Facts kept across sessions as global, per workspace, or per persona, with a change history you can undo operation by operation. [Memory →](https://x-t-e-r.github.io/kiki/en/guides/memory)

## Work in the window you have open

- **A timeline that stays readable.** Finished stretches of tool calls fold into one line such as "Worked · 8 steps", and every fold opens back up in order. [Interface overview →](https://x-t-e-r.github.io/kiki/en/guides/interface)
- **Annotations.** Leave a note on a message and it goes out with your next one, instead of interrupting with a separate turn. [Input box →](https://x-t-e-r.github.io/kiki/en/guides/interface#input-box)
- **Usage.** Token and cost for a date range, live request and queue state with concurrency limits, and content-free external sync. [Usage →](https://x-t-e-r.github.io/kiki/en/guides/settings#usage)
- **Search.** `HistorySearch` and `HistoryRead` let the agent search earlier messages and tool output, including text from before a compaction. Session titles are searchable in the sidebar. [Built-in tools →](https://x-t-e-r.github.io/kiki/en/reference/tools#history-tools)

## Roles you can talk to

- **Personas.** A long-term identity — a name, an avatar, what it is for, the standing rules for how it works, and its own memory — stored as a Markdown file you can read and edit. [Personas and rooms →](https://x-t-e-r.github.io/kiki/en/customization/personas)
- **A fixed daily conversation.** Clicking a persona's name lands in the same conversation every time; the same persona can hold several conversations at once.
- **Rooms.** Two to six personas discuss one topic in order, with a host, a budget, and pause and continue.
- **A persona is not a profile.** A profile is execution configuration — tools, permissions, model, effort. A persona is identity — who it is and what it remembers.

## Your data, your machines

- **Spaces.** Each space is a Kiki you open, with its own shortcuts, window behavior, and credential scope — shared with the main space or isolated. [Settings →](https://x-t-e-r.github.io/kiki/en/guides/settings)
- **Remote connections.** A directed link from one Kiki home to another, approved on both sides; `inbound revoke` stops one source without touching the others. [`kiki connections` →](https://x-t-e-r.github.io/kiki/en/reference/command#kiki-connections)
- **Thread bridges.** A one-way channel for messages between two homes that never grants GUI browsing access. [`kiki bridges` →](https://x-t-e-r.github.io/kiki/en/reference/command#kiki-bridges)
- **Web access.** Opens this Kiki in a browser on another device through a single-use link; turning it off revokes every link without stopping running work. [Web access →](https://x-t-e-r.github.io/kiki/en/server/local-server#use-kiki-in-a-browser)
- **SSH in a session.** Hosts joined to a session belong to that session, so the timeline stays clean. [Input box →](https://x-t-e-r.github.io/kiki/en/guides/interface#input-box)

## Every layer is yours

- **Prompt field overrides.** Replace any named part of the built-in prompt, down to a single tool description, globally, per model, or per agent; `kiki prompt-fields` shows what the model will receive. [Prompt field overrides →](https://x-t-e-r.github.io/kiki/en/customization/prompt-fields)
- **Connections and OAuth.** Every way Kiki reaches a model is one row in one list, and how it authenticates is part of that row. Sign in with a subscription account over a device flow, or reuse a sign-in the machine already holds. [Connections →](https://x-t-e-r.github.io/kiki/en/guides/settings#connections)
- **Permission modes.** Manual asks for side effects, Auto handles routine work and still asks about sensitive targets, YOLO approves everything, and Approve for me routes policy-generated approvals to a reviewer you configured. Explicit deny rules always win. [Permission modes →](https://x-t-e-r.github.io/kiki/en/guides/interaction#permission-modes)
- **Hooks.** Run your own scripts on lifecycle events: block a dangerous shell command, add context when a message is submitted, or get a notification when a task finishes. [Hooks →](https://x-t-e-r.github.io/kiki/en/customization/hooks)

## Bring in history, plug in other tools

- **Session history import.** Import Claude Code, Codex, Pi, Grok Build, or OpenCode conversations as Kiki sessions you can keep working in, or as read-only archives. The preview states what is kept and what is not. [Session history import →](https://x-t-e-r.github.io/kiki/en/customization/plugins#session-history-import)
- **Editors over ACP.** `kiki acp` puts Kiki inside Zed, JetBrains IDEs, Paseo, or other Agent Client Protocol clients. [Using Kiki in IDEs →](https://x-t-e-r.github.io/kiki/en/server/ide) · [ACP reference →](https://x-t-e-r.github.io/kiki/en/server/acp)
- **External tools calling Kiki.** `kiki seat` fixes a seat for inbound MCP clients such as Cursor, Claude Code, and Codex: the workspace, permission mode, and model are settled before the caller connects. [`kiki seat` →](https://x-t-e-r.github.io/kiki/en/reference/command#kiki-seat)

## Look and extend

- **Skins and appearance.** Six built-in skin families, a picture or video background, and appearance packs that bundle colors with media. [GUI skins →](https://x-t-e-r.github.io/kiki/en/customization/skins)
- **Plugins.** A plugin can add skills, agents, MCP servers, hooks, commands, and tools; browse and install on the Capabilities page. [Plugins →](https://x-t-e-r.github.io/kiki/en/customization/plugins)
- **Skills.** Reusable workflows that register as slash commands you can trigger with `/name`. [Agent Skills →](https://x-t-e-r.github.io/kiki/en/customization/skills)
- **MCP servers.** Connect external tools over stdio, HTTP, or SSE. [MCP →](https://x-t-e-r.github.io/kiki/en/server/mcp)
- **Web search and fetch.** Search and page fetches run on named lanes you can inspect; GitHub and Context7 need no key, and multiple keys per provider rotate with cooldowns. [Search and retrieval →](https://x-t-e-r.github.io/kiki/en/guides/settings#search-retrieval) · [Spotlight →](nb-search.en.md)
