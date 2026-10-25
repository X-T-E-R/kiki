# Reddit drafts

Post as a text post with the image inline. Reply to every question in the first few hours. Don't cross-post the same day.

## r/LocalLLaMA

**Title:** I built an open-source agent workbench where each subagent can run a different model, and you can rewrite every tool description per model

**Body:**

Kiki is an MIT-licensed AI agent workbench that runs on your machine: a desktop app, a TUI, and a browser UI on one local daemon, with sessions, history, and configuration in a local Kiki home. Your project folders stay where they are. Two parts matter for this sub:

**Model binding is per role.** Your lead agent can run a frontier API model while the workers run whatever cheap or self-hosted OpenAI-compatible endpoint you point them at, and a reviewer uses a third. A subagent with no model bound and no default does not silently inherit the lead's model: the dispatch fails instead.

**Prompt fields are overridable per model.** Every named piece of the built-in prompt, including individual tool descriptions, can be overridden globally, per model alias, or per agent. If a smaller model keeps misusing a tool, you rewrite that tool's description for that model only:

```toml
[models.cheap-worker.prompt_overrides]
files = ["prompt/cheap-worker.toml"]   # holds e.g. "tool.web-search.description" = "..."
```

`kiki prompt-fields explain <field> --model cheap-worker` shows the effective value and which layer it came from.

Agents themselves are Markdown files (frontmatter = tools/model/dispatch, body = system prompt). A file from another tool has to be migrated rather than dropped in: frontmatter keys are closed, and the loader names any key it does not recognise. On the other side, conversation history from Claude Code, Codex, Pi, Grok Build, or OpenCode imports as a session you can keep working in, or as a read-only archive.

Saved edits apply to the next dispatch. A session already running keeps the snapshot it started with until you rebuild its context.

[image: r05 multi-model fleet]

Caveats: early (0.x); unsigned, unnotarized macOS build; Windows needs Git for Windows; npm install requires Node.js 24.22.1+ or 26.12.1+. The screenshots are rendered example scenes, not benchmarks. Repo: https://github.com/X-T-E-R/kiki

Question: which roles would you hand to a local model first, and which tool descriptions trip your local models up?

## r/ChatGPTCoding

**Title:** Mix vendors per role and import your Claude Code or Codex history: I built an open workbench where each agent gets its own model and prompts

**Body:**

Kiki is an open-source (MIT) AI agent workbench that runs on your machine.

- **Mix vendors per role.** The lead plans on one model, workers run on cheaper ones (DeepSeek, GLM, …), and a reviewer runs on another vendor, all in one session.
- **Agent definitions are files you edit.** Each agent is a Markdown file: frontmatter for tools, model, effort, and which agents it may dispatch; body for the system prompt. Save it and the next dispatch uses it; a running session keeps its starting snapshot until you rebuild its context.
- **Bring your history.** Claude Code, Codex, Pi, Grok Build, and OpenCode conversations import as continuable Kiki sessions or read-only archives, with a preview of what the import drops. Bringing an agent file over is a migration instead: frontmatter keys are closed, and an unrecognised key fails the load and gets named.
- **Rewrite a single tool description for one model.** Every built-in prompt field can be overridden globally, per model alias, or per agent. `kiki prompt-fields explain` prints what the model receives.
- **Keep working while it works.** The lead dispatches subagents and background tasks and gets notified when they finish. Messages you send meanwhile queue up, and each one can wait until the agent is idle, until subagents finish, or until tasks finish.
- **Work that lasts.** Goals across turns, cron prompts while a Kiki process holds that session open, and requirement cards from the optional `kiki-task-board` plugin.
- **Not only code.** Catalog plugins read local PDFs and Office files into Markdown (`Kiki Extract`, needs Python with MarkItDown), edit Word/Excel/PowerPoint (`Kiki Office Suite`), and check CSVs locally (`Kiki Work`).
- Desktop app, TUI, browser UI on one local daemon; Zed/JetBrains over ACP.

[video: 30 s real recording, or image: h01]

Early (0.x), rough edges. Screenshots are rendered example scenes. https://github.com/X-T-E-R/kiki

What does your planner / worker / reviewer split look like today?
