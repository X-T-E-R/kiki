---
layout: home
hero:
  name: Kiki
  text: Agents that answer to you.
  tagline: An open-source AI agent workbench on your machine. Desktop, terminal, and browser share one local daemon.
  actions:
    - theme: brand
      text: Get Started
      link: ./getting-started/installation
    - theme: alt
      text: All features
      link: https://github.com/X-T-E-R/kiki/blob/kiki/marketing/features.en.md
    - theme: alt
      text: Release Notes
      link: ./release-notes/changelog
features:
  - title: "Freedom: a model per role"
    details: Bind each role to its own model and mix vendors in one session. A frontier model can plan while DeepSeek or GLM does the routine work and another vendor reviews.
    link: ./customization/agents
  - title: "Freedom: agents are your files"
    details: An agent is a Markdown file with its tools, model, and dispatch rules in the frontmatter. Claude Code and OpenCode agent files load as they are, and edits reload in about 200 ms.
    link: ./customization/agent-profiles
  - title: "Freedom: rewrite any prompt field"
    details: Override built-in prompt text down to a single tool's description, globally, per model, or per agent, then see what the model receives with kiki prompt-fields.
    link: ./customization/prompt-fields
  - title: "Power: many lines at once"
    details: The lead agent dispatches subagents and background tasks, and hears back automatically when they finish.
    link: ./reference/tools#background-tasks
  - title: "Power: talk while it works"
    details: Messages sent while the agent is busy wait in a queue, and each one can go out when the agent is idle, after its subagents finish, or after its tasks finish.
    link: ./guides/interface#input-box
  - title: "Power: work that outlasts a session"
    details: A per-workspace requirement board the agent reads and writes, goals pursued across turns, and cron-scheduled prompts.
    link: ./guides/sessions#requirements-board
---
