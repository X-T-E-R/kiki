---
layout: home
hero:
  name: Kiki
  text: Hand over a folder and a goal.
  tagline: An open-source AI agent workbench on your machine. Research, write, work with documents, or ship code — the lead agent brings in subagents on the models you pick, runs long tasks in the background, and remembers across sessions.
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
  - title: "Start with one folder and one task"
    details: Point Kiki at a project, a pile of PDFs, or a draft folder. Desktop, terminal (`kiki`), and browser (`kiki web`) share one local daemon, and the welcome tour runs without calling a model.
    link: ./getting-started/first-launch
  - title: "One lead, a team on different models"
    details: The main agent splits larger work across isolated subagents — an explorer on a fast model, a writer or builder on another, a reviewer on a third vendor — and hears back automatically when background tasks finish.
    link: ./features/workbench
  - title: "Reusable agents in plain Markdown"
    details: "Each agent profile is one Markdown file: frontmatter sets its model, effort, tools, and who it may dispatch; the body is its system prompt. Edits reload in ~200 ms, and Claude Code or OpenCode agent files work as-is."
    link: ./features/agent-workflows
  - title: "Work that runs across hours or days"
    details: Keep a target alive across turns with `/goal`, queue follow-up messages with per-message delivery timing while the agent is busy, run cron prompts, track workspace requirements on a board, and keep undoable memory across sessions.
    link: ./features/long-work
  - title: "Personas and multi-role rooms"
    details: Give a long-term collaborator a name, standing rules, its own memory, and a fixed daily conversation — or put two to six personas and existing threads into a room to work through one topic under a host and budget.
    link: ./features/people
  - title: "Documents, data, browser, and media"
    details: Extract local PDFs and Office files into searchable Markdown, work with Office documents and longform writing, query financial and academic data, drive your logged-in browser or desktop apps, and generate images, video, or speech.
    link: ./features/extend
  - title: "Every prompt field and permission is yours"
    details: Override any built-in prompt field down to a single tool description per model or per agent, inspect the exact effective prompt with `kiki prompt-fields`, and choose when Kiki asks — Manual, Auto, Approve for me, or YOLO.
    link: ./features/freedom
  - title: "Live queue and honest cost accounting"
    details: See which concurrency rule is holding a waiting request back, inspect token usage and cost with unknown calls marked separately instead of faked as zero, and sync content-free numbers only after you preview and approve the payload.
    link: ./features/daily
  - title: "Your machines, your phones, your other tools"
    details: Isolate credentials per space, link Kiki homes or one-way thread bridges, pair a WeChat or QQ chat to reply and approve from your phone, import history from Claude Code or Codex, and connect IDEs over ACP or MCP seats.
    link: ./features/spaces
---
