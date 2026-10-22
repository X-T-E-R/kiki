---
title: Features
---

# Features

Kiki is an open-source AI agent workbench that runs on your machine. You give it a folder and a result you want — an unfamiliar codebase explained, a stack of PDFs and spreadsheets cross-checked, a report drafted, or a multi-file change shipped — and the lead session plans the work, hands separable parts to subagents, and keeps the target in view across turns. Work files stay in the folder you pick; sessions, history, and configuration stay in your local Kiki home, and model requests go only to the providers or local servers you connect.

The desktop app, the terminal UI (`kiki`), and the browser UI (`kiki web`) all connect to the same local daemon, so you can start a task in one window and pick it up in another.

![The Kiki workbench: the subagents a lead session dispatched, an active goal, and a queued message, all on one screen.](/shots/index/wl-20261005-hero-workbench.en.png)

New to Kiki? Start with [Installation](/en/getting-started/installation) and [First launch](/en/getting-started/first-launch), then come back here. Already running it? Jump to the situation you are in — each page introduces the capability and links to the guide or reference with the full controls.

## Delegate and orchestrate work

When one context window or one model is not enough, Kiki splits the work across roles, models, and time.

| Page | When you need it | What it covers |
| --- | --- | --- |
| [One workbench, many lines](/en/features/workbench) | A task is bigger than one turn or one model | The main agent dispatching isolated subagents, binding each role to a different model or vendor, reading any subagent's own transcript, and background tasks that report back when they finish |
| [Agent Profiles](/en/features/agent-workflows) | You want reusable specialists instead of re-explaining a role | One Markdown file per role: model, effort, allowed tools, system prompt, and which child agents it may dispatch; shipped roles and templates (`explore`, `implementer`, `reviewer`), plus how edits apply to new dispatches and live sessions |
| [Work that runs long](/en/features/long-work) | Work spans hours, days, or a recurring schedule | `/goal` across turns, the queue for messages you send while the agent is busy (with per-message send timing), scheduled prompts while a Kiki process holds that session, the optional `kiki-task-board` requirement board plugin, context renewal (`Summarize`, `Fresh`, `Auto`), and undoable memory across global, workspace, and persona scopes |
| [Roles you can talk to](/en/features/people) | You want a standing collaborator or several perspectives on one topic | Personas with their own standing rules, isolated memory, and a fixed daily conversation entry, plus rooms where two to six personas or existing threads discuss a topic under a host and a message budget |

## Inspect, control, and extend

You can see what the agents are doing, what it costs, and which instructions they actually receive.

| Page | When you need it | What it covers |
| --- | --- | --- |
| [The daily driver](/en/features/daily) | You are watching cost, throughput, or a waiting request | Folded tool steps, message annotations, the "Needs you" approval tray, the right rail that follows the focused agent, and the Usage page: History cost with honest completeness flags, Live concurrency rules naming the rule holding each request, and opt-in content-free external sync |
| [Every layer is yours](/en/features/freedom) | A model misuses a tool, or you want different auth and approval rules | Prompt field overrides down to a single tool description globally, per model, or per agent (`kiki prompt-fields`), connections and OAuth in one list (including reusing local ChatGPT or Grok Build sign-ins), permission modes (`manual`, `auto`, `review`, `yolo`), and lifecycle hooks |
| [Make it yours to extend](/en/features/extend) | The work leaves plain text: documents, spreadsheets, data, browsers, media | Connecting tools and installing plugins when needed (`Kiki Extract` for local PDF/Office-to-Markdown, `Kiki Office Suite`, `Kiki Work`, `Kiki Writing`, `Kiki Notion`, `Kiki Media`, `Kimi Datasource`), multi-source browser control (Ego Lite, browser extensions, or an independent profile), `/skill` workflows, MCP servers, and inspectable web search and fetch lanes |
| [Look and feel](/en/features/look) | You want the window to fit how you read | Six built-in light and dark skin families, accent and typography tuning, local picture or video backgrounds with a contrast check, and appearance packs |

## Connect your machines, phones, and other tools

Kiki keeps sessions and configuration under your local Kiki home and opens a door only where you ask it to.

| Page | When you need it | What it covers |
| --- | --- | --- |
| [Your data, your machines](/en/features/spaces) | You separate work and personal accounts, or run across hosts | Spaces with shared or isolated credentials, Work mode presets, remote Kiki connections approved on both sides, one-way thread bridges, single-use Web access links, and SSH hosts joined to a session |
| [Phone session](/en/features/phone) | You are away from the desk and a step is waiting | Pairing a WeChat or QQ chat to a persona or session, choosing whether a message queues or steers into the running turn, and answering pending questions and approvals from your phone |
| [Bring your history, meet other tools](/en/features/ecosystem) | You already use Claude Code, Codex, Cursor, Zed, or JetBrains | Importing conversations from Claude Code, Codex, Pi, Grok Build, or OpenCode as continuable Kiki sessions or read-only archives (with a preview of what carries over), running Kiki inside an editor over `kiki acp`, fixing a seat for inbound MCP clients with `kiki seat`, and running subagents on external harnesses |
