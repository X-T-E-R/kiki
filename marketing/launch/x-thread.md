# X thread (6 posts)

Attach media to posts 1, 2, 4, 5. Post 1 media is the 30 s real recording if it exists; otherwise h01 (and don't call it a recording).

**1/**
Your Claude Code agent files, running on any model you like. Mix vendors per role, and rewrite any prompt the agent sees.

Kiki: an open-source AI agent workbench that runs on your machine.
Agents that answer to you. 🧵
[video: 30 s real recording, or image: h01]

**2/**
An agent is a Markdown file.
Frontmatter: tools, model, which agents it may dispatch.
Body: its system prompt.

Claude Code and OpenCode agent files load as-is. Edits reload in ~200 ms.
[image: r01]

**3/**
Each role picks its own model.
The lead runs a frontier model, workers run DeepSeek or GLM, the reviewer runs another vendor.

No silent fallback: if a subagent has no model bound, the dispatch fails loudly.

**4/**
Every built-in prompt field can be overridden, down to one tool's description, and layered globally → per model → per agent.

`kiki prompt-fields explain` shows the value the model actually receives and where it came from.

Handy when a cheap model keeps misusing a tool.
[image: d02]

**5/**
Built for long, many-threaded work:
- the lead dispatches subagents + background tasks and gets notified when they finish
- keep typing while it's busy: each queued message waits for idle, subagents, or tasks
- a workspace board, /goal, and cron that outlast a session
[image: r02]

**6/**
Desktop app, TUI, and browser on one local daemon. Zed/JetBrains via ACP. MIT.

Early (0.x), rough edges included.
npm i -g kiki-agent
github.com/X-T-E-R/kiki

Which prompt would you rewrite first?
