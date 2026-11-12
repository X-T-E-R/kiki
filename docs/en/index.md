---
layout: home
title: Kiki (kiki-agent) — Multi-Model AI Agent Workbench
titleTemplate: false
hero:
  name: Kiki
  text: One task, several models, each doing its part.
  tagline: An open-source, local agent workbench. The lead session splits the work — a strong model plans, cheaper models do the routine parts, and a different vendor reviews. Which model does which part is your call. Your agents, your call.
  actions:
    - theme: brand
      text: Get Started
      link: ./getting-started/installation
    - theme: alt
      text: See what it does
      link: ./features/index
    - theme: alt
      text: Release Notes
      link: ./release-notes/changelog
features:
  - title: "One lead session, several models"
    details: "When a job divides, the main agent dispatches isolated subagents — a fast model to explore, another to write or implement, a third vendor to review. Open any subagent's own transcript, while background tasks notify the lead when they finish."
    link: ./features/workbench
  - title: "Fitted to each model"
    details: "Other tools are tuned for their own vendor's model. Kiki tunes itself to each model you connect through a Recipe: prompts plus model settings, installed once and bound to that model. The author has published five, for GPT-6.1 Sol, GPT-6 Astra, DeepSeek V4.1, Gemini 4 Argon, and Gemini 3.8 Flash; adapt one or write your own."
    link: ./customization/recipes
  - title: "On your machine, the same work in every window"
    details: "Work files stay in the folder you choose, and sessions, history, and configuration stay on this computer. A session you start in the desktop app, `kiki` in the terminal, or `kiki web` in the browser is the same session everywhere."
    link: ./getting-started/first-launch
  - title: "Reusable roles in plain Markdown"
    details: "Each agent profile is one Markdown file you own: frontmatter sets its model, thinking effort, allowed tools, and which child agents it may dispatch; the body is its system prompt. Start from built-in roles like `explore`, `implementer`, and `reviewer`, or write your own."
    link: ./features/agent-workflows
  - title: "Work that outlives a single turn"
    details: "Keep a target in view across turns with `/goal`, queue messages while the agent is busy with per-message send timing, run cron prompts while a Kiki process holds the session, and keep undoable memory across global, workspace, and persona scopes."
    link: ./features/long-work
  - title: "Personas and moderated rooms"
    details: "Give a recurring collaborator a name, standing rules, isolated memory, and a fixed daily conversation — or pull two to six personas and existing threads into a room to work through one topic under a host and a message budget."
    link: ./features/people
  - title: "Documents, Office files, data, browser, and media"
    details: "When work goes beyond plain text, connect a browser (Ego Lite, an extension, or an isolated profile) or install plugins for what you need: extract local PDFs and Office files (`Kiki Extract`), edit Word, Excel, and PowerPoint (`Kiki Office Suite`), audit CSVs (`Kiki Work`), query data (`Kimi Datasource`), or generate media (`Kiki Media`)."
    link: ./features/extend
  - title: "Prompts, tools, and approvals you can change"
    details: "Replace any named part of the built-in prompt globally, per model, or per agent — down to rewriting one tool description a model misuses — inspect the effective prompt with `kiki prompt-fields`, and choose between Manual, Auto, Approve for me, and YOLO."
    link: ./features/freedom
  - title: "See the cost and what is holding a request"
    details: "The Usage page names the concurrency rule holding each waiting request back, marks calls where a provider returned no usage as unknown instead of a fake zero, and syncs content-free stats only after you explicitly agree to the current destination and scope; preview is optional."
    link: ./features/daily
  - title: "Your machine, your phone, your other tools"
    details: "Work files stay in your folder while sessions, history, and credentials stay in your local Kiki home. Isolate work and personal spaces, pair a WeChat or QQ chat to reply and approve from your phone, import earlier history as a session or archive, or connect editors over `kiki acp` and `kiki seat`."
    link: ./features/spaces
---
