---
title: Features
---

# Features

Kiki is an open-source AI agent workbench that runs on your machine. You give it a folder and an outcome — mapping an unfamiliar codebase, synthesizing a stack of PDFs and spreadsheets, drafting a report, or shipping a multi-file change — and the lead session plans the work, brings in subagents when the job splits cleanly, and keeps going across turns and sessions.

The desktop app, the terminal UI (`kiki`), and the browser UI (`kiki web`) all connect to the same local daemon, so you can start a task in one window and check or steer it from another.

![The Kiki workbench: the subagents a lead session dispatched, an active goal, and a queued message, all on one screen.](/shots/index/wl-20261005-hero-workbench.en.png)

New to Kiki? Start with [Installation](/en/getting-started/installation) and [First launch](/en/getting-started/first-launch), then come back here. Already running it? Jump to the situation you are trying to solve — each page introduces how the capability works and links to the guide or reference with the full controls.

## Delegate and orchestrate work

When a task is too large or too noisy for one context window, Kiki splits the work across roles, models, and time.

| Page | When you need it | What it covers |
| --- | --- | --- |
| [One workbench, many lines](/en/features/workbench) | A task is bigger than one turn or one model | How the lead session dispatches isolated subagents, binds each role to its own model or vendor, keeps subagent transcripts inspectable, and runs background tasks that notify on completion |
| [Agent Profiles](/en/features/agent-workflows) | You want reusable specialists for recurring work | Defining an agent in a single Markdown file (model, effort, tools, system prompt, and permitted child agents), built-in roles and templates (`explore`, `implementer`, `reviewer`), and ~200 ms live reload |
| [Work that runs long](/en/features/long-work) | Work spans hours, days, or recurring schedules | Multi-turn `/goal` tracking, queuing messages while the agent is busy with per-message delivery timing, cron scheduled prompts, the workspace task board, context renewal (`Summarize`, `Fresh`, `Auto`), and undoable memory across global, workspace, and persona scopes |
| [Roles you can talk to](/en/features/people) | You want persistent collaborators or multi-perspective debate | Long-term personas with their own standing rules, memory, and fixed daily conversation, plus rooms where two to six personas or threads discuss a topic under a host and message budget |

## Inspect, steer, and customize every layer

You can see what the agents are doing, what they are costing, and what instructions they actually receive — and change any part of the stack without forking code.

| Page | When you need it | What it covers |
| --- | --- | --- |
| [The daily driver](/en/features/daily) | You are working in the window and watching cost or throughput | Folded tool steps, message annotations, the "Needs you" approval tray, the context-following right rail, and the Usage page: History cost with honest completeness flags, Live concurrency-rule queues, and opt-in content-free external sync |
| [Every layer is yours](/en/features/freedom) | A model misuses a tool, or you want tighter control over auth and approvals | Overriding any built-in prompt field down to a single tool description globally, per model, or per agent (`kiki prompt-fields`), unified OAuth and API connections (including reusing local ChatGPT or Grok Build sign-ins), permission modes (`manual`, `auto`, `review`, `yolo`), and lifecycle hooks |
| [Make it yours to extend](/en/features/extend) | The work reaches beyond local text files into Office docs, web data, browsers, or media | Plugins (including Kiki Extract for PDF/Office-to-Markdown, Kiki Writing, Kiki Office Suite, Kiki Notion, Kiki Media, Kimi Datasource, Kimi Browser Extension, and Kimi Computer Use), `/skill` workflows, MCP servers, and inspectable web search and fetch lanes |
| [Look and feel](/en/features/look) | You want the workbench to match your reading environment | Six built-in light/dark skin pairs, live accent and typography tuning, local picture or video backgrounds with automatic WCAG AA contrast protection, and appearance packs |

## Connect your machines, phones, and other tools

Kiki keeps sessions under your local home directory by default, and opens controlled doors when you want to reach another machine, reply from your phone, or work alongside other AI tools.

| Page | When you need it | What it covers |
| --- | --- | --- |
| [Your data, your machines](/en/features/spaces) | You separate work and personal accounts, or run across multiple hosts | Spaces with shared or isolated credentials, Work mode presets, mutually approved remote Kiki connections, one-way thread bridges, single-use Web access links, and in-session SSH hosts |
| [Phone session](/en/features/phone) | You are away from the desk and need to reply or approve a step | Pairing a WeChat (QR scan) or QQ chat to a persona or session, steering or queuing messages while a turn is busy, and answering pending questions or approvals from your phone |
| [Bring your history, meet other tools](/en/features/ecosystem) | You already use Claude Code, Codex, Cursor, Zed, or JetBrains | Importing conversations from Claude Code, Codex, Pi, Grok Build, or OpenCode as continuable Kiki sessions; running Kiki inside editors over `kiki acp`; exposing fixed MCP seats with `kiki seat`; and running subagents on external agent harnesses |
