# Reddit drafts

Post as a text post with the image inline. Reply to every question in the first few hours. Don't cross-post the same day.

## r/LocalLLaMA

**Title:** I built an open-source agent workbench where each subagent can run a different model, and you can rewrite every tool description per model

**Body:**

Kiki is an MIT-licensed AI agent workbench that runs locally: a desktop app, a TUI, and a browser UI on one daemon. Two parts matter for this sub:

**Model binding is per role.** Your lead agent can run a frontier API model while the workers run whatever cheap or self-hosted OpenAI-compatible endpoint you point them at, and a reviewer uses a third. Subagents never silently inherit a model: with no binding, the dispatch fails with an error instead of quietly using the expensive one.

**Prompt fields are overridable per model.** Every named piece of the built-in prompt, including individual tool descriptions, can be overridden globally, per model alias, or per agent. If a smaller model keeps misusing a tool, you rewrite that tool's description for that model only:

```toml
[models.cheap-worker.prompt_overrides]
files = ["prompt/cheap-worker.toml"]   # holds e.g. "tool.web-search.description" = "..."
```

`kiki prompt-fields explain <field> --model cheap-worker` shows the effective value and which layer it came from.

Agents themselves are Markdown files (frontmatter = tools/model/dispatch, body = system prompt). Claude Code and OpenCode agent files load as-is.

[image: r05 multi-model fleet]

Caveats: early (0.x); unsigned macOS build; Windows needs Git for Windows; the screenshots are rendered example scenes, not benchmarks. Repo: https://github.com/X-T-E-R/kiki

Question: which roles would you hand to a local model first, and which tool descriptions trip your local models up?

## r/ChatGPTCoding

**Title:** Your Claude Code agent files, running on any model: I built an open workbench where each role can use a different vendor

**Body:**

Kiki is an open-source (MIT) AI agent workbench that runs on your machine.

- **Bring your agent files.** Each agent is a Markdown file. Claude Code and OpenCode agent files load as they are, and edits reload in about 200 ms.
- **Mix vendors per role.** The lead plans on one model, workers run on cheaper ones (DeepSeek, GLM, …), and a reviewer runs on another vendor.
- **Keep working while it works.** The lead dispatches subagents and background tasks and gets notified when they finish. Messages you send meanwhile queue up, and each one can wait until the agent is idle, until subagents finish, or until tasks finish.
- **Work that lasts.** A per-workspace requirement board the agent reads and writes, `/goal` across turns, cron prompts.
- Desktop app, TUI, browser UI on one local daemon; Zed/JetBrains via ACP.

[video: 30 s real recording, or image: h01]

Early (0.x), rough edges. Screenshots are rendered example scenes. https://github.com/X-T-E-R/kiki

What does your planner / worker / reviewer split look like today?
