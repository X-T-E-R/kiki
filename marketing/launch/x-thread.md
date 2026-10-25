# X thread (6 posts)

Attach media to posts 1, 2, 4, 5. Post 1 media is the 30 s real recording if it exists; otherwise h01 (and don't call it a recording).

**1/**
Hand Kiki a folder: a codebase, a stack of PDFs and spreadsheets, a draft.
An open-source AI agent workbench on your machine. The lead dispatches subagents on the models you pick.
Agents that answer to you. 🧵
[video: 30 s real recording, or image: h01]

**2/**
An agent is a Markdown file.
Frontmatter: tools, model, effort, which agents it may dispatch.
Body: its system prompt.

Saved edits apply to the next dispatch. A running session keeps its startup snapshot until you rebuild its context.
[image: r01]

**3/**
Each role picks its own model.
The lead runs a frontier model, workers run DeepSeek or GLM, the reviewer runs another vendor.

No silent fallback: with no model bound and no default, the dispatch fails loudly.

**4/**
Every built-in prompt field can be overridden, down to one tool's description, and layered globally → per model → per agent.

`kiki prompt-fields explain` shows the value the model actually receives and where it came from.

Handy when a cheap model keeps misusing a tool.
[image: d02]

**5/**
For long, many-threaded work:
- the lead dispatches subagents + background tasks and is notified when done
- keep typing while it's busy: each message waits for idle, subagents, or tasks
- goals, cron while a session is held open, and the optional kiki-task-board plugin
[image: r02]

**6/**
Desktop, TUI, browser on one local daemon. Sessions stay in your Kiki home; models use your providers. Plugins handle PDFs, spreadsheets, drafts. MIT.

Early (0.x), rough edges.
npm i -g kiki-agent (Node 24.22.1+ or 26.12.1+)
github.com/X-T-E-R/kiki

What would you rewrite first?
