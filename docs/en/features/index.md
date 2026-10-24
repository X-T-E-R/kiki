---
title: What Kiki Can Do
---

# What Kiki Can Do

Kiki is an open-source AI agent workbench that runs on your machine. Hand it a folder and the outcome you want — an unfamiliar codebase mapped out, a stack of PDFs and spreadsheets cross-checked, a report drafted, or a multi-file engineering change shipped — and the lead session plans the work, dispatches separable parts to subagents, and keeps the target in view across turns.

Work files stay in the folder you pick; sessions, history, and configuration stay in your local Kiki home, and model requests go only to the providers or local servers you connect. The desktop app, the terminal UI (`kiki`), and the browser UI (`kiki web`) all connect to the same local daemon, so you can start a task in one window and pick it up in another.

![The Kiki workbench: the subagents a lead session dispatched, an active goal, and a queued message, all on one screen.](/shots/index/wl-20261005-hero-workbench.en.png)

New to Kiki? Start with [Installation](/en/getting-started/installation) and [First launch](/en/getting-started/first-launch), then come back here. Already running it? Browse by what you want to get done — each section explains what Kiki actually does and links to the feature page or settings entry with the full controls.

## Multi-model & parallel work

When a job outgrows a single turn or a single model, Kiki splits the work across specialized roles and models while keeping long-running goals and project memory intact.

### Subagents & multi-model

In [One workbench, many lines](/en/features/workbench), you talk to one main agent; when a subtask can be separated cleanly, the main agent dispatches subagents that work in their own isolated contexts. You can bind the main agent, explorers, and reviewers to different models or vendors in the same session — a strong reasoning model to plan, a fast model to explore, and another vendor to review.

Open any subagent to read its full transcript or message it directly. You can also push long shell commands or subagents into the background so they automatically notify the lead session when they finish.

![Several models in one session: a dispatch tree with a different model bound to each role.](/shots/workbench/workbench-per-role-models.en.png)

### Agent Profiles

Instead of re-explaining your rules every time, [Agent Profiles](/en/features/agent-workflows) let you define each role in a plain Markdown file you can read, diff, and commit: frontmatter sets the model, thinking effort, allowed tools, and which child agents it may dispatch, while the body is its starting system prompt.

Start from the shipped `agent`, `general`, and `explore` profiles or the built-in `implementer` and `reviewer` templates, or write your own; edits hot-reload for new dispatches, and live sessions can pick them up through **Rebuild context**.

### Goals, queues & memory

[Work that runs long](/en/features/long-work) handles jobs that span hours, days, or a recurring schedule. Start a `/goal` to keep an outcome in view across turns until the check passes; send messages while the agent is busy and choose per message whether it delivers after idle, after subagents finish, or after all background tasks complete.

You can also schedule recurring prompts in your local timezone (triggered while a Kiki process holds that session), install the optional `kiki-task-board` plugin for workspace requirement cards, pick how context renews near the window limit (`Summarize`, model-free `Fresh` handoff packets, or `Auto`), and manage undoable memory across global, workspace, and persona scopes on `/memory`.

![An active goal with two queued messages waiting underneath, each carrying its own send timing.](/shots/long-work/long-work-goal-queue.en.png)

### Personas & rooms

When you want a long-term partner or several perspectives on one problem, [Roles you can talk to](/en/features/people) gives each persona a name, standing instructions, isolated memory, and a fixed daily conversation entry, with Character Card V3 import and export. You can also pull two to six personas or existing session threads into a moderated room to work through a topic under a host and a message budget.

![A room in which three personas are discussing a release, with each message labeled by speaker.](/shots/people/people-room.en.png)

## Browser & computer control

When work moves beyond local files into live web pages, signed-in dashboards, or desktop software that has no API, you can set up and enable browser and computer control under **Settings → Capabilities → Browser & computer** (and matching plugins). Kiki's browser driver, any independent browser it starts, and computer control run on the Kiki server machine, while you can also attach to an existing local or remote browser.

### Browser control

After you set up the components and check the browsers an agent may use under [Browser control](/en/guides/settings#browser-control), agents can open pages, read snapshots, click, fill forms, and take screenshots through the [browser tools](/en/reference/tools#browser-tools) (connections start only when requested):

- **Your everyday signed-in browser**: use the **Kimi Browser Extension** or **Codex / ChatGPT browser extension** to drive the browser you already use, keeping your existing sign-ins and cookies for research, form filling, and cross-site collection.
- **Kiki-managed independent browser**: Kiki runs a separate browser and sign-in profile on the server without copying your everyday cookies (headless by default, with an option to show the window).
- **Ego Lite and existing browsers (CDP)**: connect a self-installed Ego Lite setup to run automation scripts with screenshots attached back to the timeline, or attach directly to any local or remote browser that exposes a CDP address under the advanced settings.

Each source and each browser has its own enable switch and **Allow agent use** checkbox, and you choose which allowed browser new sessions use by default.

### Computer control

For desktop apps without a CLI or API, cross-app data entry, or visual UI walkthroughs, Kiki provides two desktop control paths, both requiring your manual installation and approval before use:

- **Built-in computer control ([Settings → Capabilities → Browser & computer → Computer control](/en/guides/settings#computer-control))**: installs a pinned open-source executor on the Kiki server to drive its desktop. By default, models prefer CLI, API, scripts, and browser tools, using desktop control only when you explicitly ask or switch the preference to **Prefer**.
- **[Kimi Computer Use plugin](/en/customization/plugins#kimi-computer-use)**: an official desktop plugin installed from a direct URL for clicking, dragging, scrolling, and typing. On macOS it runs silently in the background without taking over your mouse after you grant system permissions; on Windows it runs in an interactive desktop session and briefly uses your active window, mouse, and keyboard while acting.

## Documents, data & media

Through [Make it yours to extend](/en/features/extend), you can equip the workbench with document extraction, Office editing, financial and academic datasets, reusable workflows, and inspectable web retrieval.

- **Local document extraction and Office files**: install on-demand plugins from the **Official** catalog — `Kiki Extract` (converts local PDF, Office, HTML, and text files into readable Markdown without modifying originals), `Kiki Office Suite` (creates and edits local Word, Excel, and PowerPoint files), `Kiki Work` (audits CSV/TSV keys and reconciles two tables locally without uploading data), and `Kiki Writing` (focused manuscript panel and draft continuation commands).
- **Structured datasets and external services**: install `Kimi Datasource` (requires Kimi Code OAuth login and consumes plan quota) to query stock markets, macro indicators, corporate records, academic papers, and Chinese law in natural language; connect `Kiki Notion` to search Notion and write cited briefs back to a named page; or use `Cloudflare Tunnel` and `Kiki Sites` to expose local services and deploy sites.
- **Multimodal media generation**: configure built-in image, video, and speech providers or attach your own local scripts under `Kiki Media` and [Media Sources](/en/customization/plugins#media-sources) to generate assets on demand.
- **Inspectable web search and fetch chains**: built-in `WebSearch` and `FetchURL` search the web out of the box without a key, alongside named lanes for repositories and docs plus multi-key rotation. In **Settings → Capabilities → Search & retrieval**, you can inspect where each search lane gets its credentials and see the exact sequence of extractors and fallbacks a URL passes through.
- **Agent Skills and MCP servers**: package reusable workflows and domain rules as Markdown [Agent Skills](/en/customization/skills) triggered automatically or via `/skill:<name>`, or connect external tools over `stdio`, `HTTP`, or `SSE` through [Model Context Protocol (MCP)](/en/server/mcp) under the same approval model as built-in tools.

![The fetch chain tab, with the pipelines a web address is read through in order and what each one falls back to.](/shots/extend/ce-20261005-extend-fetch-chain.en.png)

## Usage, models & permissions

What the agents are doing, what they cost, which rule is holding a waiting request back, and the exact prompt text a model receives are all visible and editable in the workbench.

### Timeline & usage

[The daily driver](/en/features/daily) keeps busy sessions readable: finished tool steps fold into compact rows, message annotations let you attach notes to specific replies and send them together on the next turn, the "Needs you" tray above the composer gathers pending approvals and questions in one place, and the right rail follows whichever main agent or subagent you focus.

The **Usage** page in the sidebar lets you check historical token usage and cost with honest completeness flags rather than fake zeros, see the exact concurrency rule (and rule ID) holding any waiting request so you can adjust or pause it on the spot, view remaining account quotas, and export content-free usage batches only after you preview and approve the payload.

![The Live tab on the Usage page: active and queued counts per model, one waiting request naming the kimi-cap rule holding it, and concurrency limit rules below with one enabled and one disabled.](/shots/daily/ux-usage-live.en.png)

### Models, prompts & auth

[Every layer is yours](/en/features/freedom) opens up the stack underneath the agent. Under **Settings → Models & providers → Services & accounts**, API keys, OAuth subscriptions (Kimi Code, ChatGPT/Codex, Grok Build, GitHub Copilot), and local servers sit in one unified list; for ChatGPT (Codex) and Grok Build, you can **Check this machine** and directly reuse an existing desktop app sign-in with automatic renewal and no credential copying.

When a model misuses a tool, you do not need to fork a whole profile — use [Prompt field overrides](/en/customization/prompt-fields) (or `kiki prompt-fields`) to replace a single tool description or system section globally, per model, or per agent. Combined with four permission modes (`manual`, `auto`, reviewer-backed `review`, and `yolo`), Plan mode, and lifecycle [Hooks](/en/customization/hooks), you decide when the agent acts on its own and when it asks.

![Prompt field overrides down to a single tool description, with a live preview of what the model will actually receive.](/shots/freedom/ce-20261005-freedom-prompt-overrides.en.png)

### Skins & backgrounds

In [Look and feel](/en/features/look), start from six built-in light and dark skin families (or appearance packs and TUI themes), tune accent color, font, corner radius, and density live, or place a local image or looping video behind the window. Kiki measures background brightness and automatically raises panel opacity when needed so text stays readable.

## Phone, remote & tools

Sessions and configuration stay in your local Kiki home by default, and connect across workspaces, machines, phones, and external harnesses only where you open a door.

- **Isolated spaces, remote links, and in-session SSH ([Your data, your machines](/en/features/spaces))**: separate work and personal environments with **Spaces** (sharing credentials with the main space or keeping them isolated, plus optional **Work mode** presets for document and Office workflows); connect two Kiki homes over mutually approved one-way **remote connections** or message-only **thread bridges** that grant no browsing rights; open your workbench to another device's browser with single-use `kiki web` links; or attach **SSH** hosts to a session from the composer to read/edit remote files over SFTP and run remote commands.
- **WeChat and QQ phone sessions ([Phone session](/en/features/phone))**: when you are away from the desk, pair a WeChat account by QR code or connect a QQ bot under **Settings → Notifications & messages** to route specific chats to a persona or session. Send messages from your phone (queued or steered into the running turn), read replies, and answer pending questions and approvals with option numbers.
- **History import, IDE integration, and external engines ([Bring your history, meet other tools](/en/features/ecosystem))**: import conversations from Claude Code, Codex, Pi, Grok Build, or OpenCode into continuable Kiki sessions or read-only archives with an upfront preview of what carries over and what is dropped; run Kiki inside Zed, JetBrains, and other editors over `kiki acp` or fix an inbound MCP caller seat for Cursor, Claude Code, and Codex with `kiki seat`; or run Kiki subagents on external harnesses and expose Kiki's native context back to them as needed.

![Importing history: six readable sources and a preview of one conversation showing what will not be carried over.](/shots/ecosystem/ecosystem-history-import.en.png)

## All feature pages

If you want to browse module by module or jump straight to the dedicated page for a specific capability, start from the index below:

| Page | Focus and key capabilities |
| --- | --- |
| [One workbench, many lines](/en/features/workbench) | Shared local daemon across desktop / TUI / Web, main agent dispatching isolated subagents, per-role model binding, subagent transcripts, background tasks that report back |
| [Agent Profiles](/en/features/agent-workflows) | Single-file Markdown profiles, model and effort inheritance, shipped roles and `implementer` / `reviewer` templates, hot reload, and context rebuild for live sessions |
| [Work that runs long](/en/features/long-work) | Cross-turn `/goal`, busy message queue with per-message timing, local-timezone scheduled prompts (Cron), optional task board, context renewal (`Summarize` / `Fresh` / `Auto`), and undoable 3-scope memory |
| [Roles you can talk to](/en/features/people) | Persona cards, fixed daily conversation entry, isolated persona memory, and moderated rooms where 2–6 personas or threads discuss a topic under a message budget |
| [The daily driver](/en/features/daily) | Folded step timeline, message annotations, "Needs you" approval tray, focus-following right rail, and Usage page (history cost, live rule IDs, account quotas, consented external sync) |
| [Every layer is yours](/en/features/freedom) | Prompt field overrides (`kiki prompt-fields`), unified connections and OAuth list, reusing local ChatGPT / Grok Build sign-ins, four permission modes with reviewer approval, and lifecycle Hooks |
| [Make it yours to extend](/en/features/extend) | Official and curated plugins (document extraction, Office, CSV audit, writing, Notion, media generation, financial & academic data), browser and computer control, `/skill`, MCP, and inspectable search & fetch lanes |
| [Your data, your machines](/en/features/spaces) | Multi-space credential isolation or sharing, Work mode presets, mutually approved remote connections, one-way thread bridges, single-use Web access links, and in-session SSH hosts |
| [Phone session](/en/features/phone) | WeChat QR and QQ bot pairing, per-contact routing to personas or sessions, busy steering vs. queueing, and numeric replies for questions and approvals from your phone |
| [Bring your history, meet other tools](/en/features/ecosystem) | Previewed history import from Claude Code / Codex / Pi / Grok Build / OpenCode, `kiki acp` IDE integration, `kiki seat` inbound MCP seats, and external executor harnesses with Kiki context bridging |
| [Look and feel](/en/features/look) | Six built-in light and dark skin families, live accent and typography tuning, local image and video backgrounds with automatic contrast protection, appearance packs, and TUI themes |
