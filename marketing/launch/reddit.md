# Reddit drafts

Post as a text post with the image inline. Reply to every question in the first few hours. Don't cross-post the same day.

## r/LocalLLaMA

**Title:** I wanted planning, implementation and review on different vendors' models, so I built an open-source local agent workbench

**Body:**

I wanted planning, implementation and review on different vendors' models, so I built this. Kiki (`kiki-agent`, MIT) is an open-source agent workbench running as one service on your own machine, so the desktop app, the terminal (`kiki`), the browser (`kiki web`), and your phone all show the same work. One task, several models, each doing its part. Your agents, your call.

On a real coding task, the lead agent runs a frontier reasoning model to plan and accept the result, dispatches a fast read-only `explore` subagent on another model to inspect the codebase, sends scoped edits to an `implementer` bound to a cheap or self-hosted OpenAI-compatible endpoint, and runs a `reviewer` on a third vendor so it does not share the implementer's blind spots. Each role is a Markdown file (`tools`, `model_alias`, `thinking_effort`, permitted children in frontmatter; system prompt in the body). A subagent with no model bound and no `[subagent].default_model` fails loudly with `model.not_configured` instead of silently falling back to the lead's model.

**Fitted to each model.** Claude Code is tuned for Claude and Codex for GPT. For models Kiki runs natively, it tunes itself to each model you connect through a Recipe: prompts plus model settings (and optional script hooks), installed once, bound to that model, with per-binding options. The author has published five recipes (GPT-6.1 Sol, GPT-6 Astra, DeepSeek V4.1, Gemini 4 Argon, Gemini 3.8 Flash) in `https://github.com/X-T-E-R/kiki-recipes` (MIT) — for example, pushing DeepSeek V4.1 to work out the mechanism and counter-examples before acting, or anchoring Gemini 3.8 Flash on a sample first. Recipes apply to native models, not external executors.

**Override any built-in prompt field per model.** If a smaller local model keeps misusing a tool, you can replace that tool's description only for that model alias:

```toml
[models.cheap-worker.prompt_overrides]
files = ["prompt/cheap-worker.toml"]   # holds e.g. "tool.web-search.description" = "..."
```

`kiki prompt-fields explain <field> --model cheap-worker` shows the effective value and which layer it came from. Saved edits apply to the next dispatch; a running session keeps its startup snapshot until you rebuild its context.

[image: `docs/public/shots/workbench/workbench-per-role-models.en.png`]

Other details: conversation history from Claude Code, Codex, Pi, Grok Build, or OpenCode imports as a continuable session or read-only archive, while agent files from other tools have closed frontmatter keys and must be migrated (the loader names any unrecognised key). Caveats: early (`0.5.1`, `0.x`); unsigned, unnotarized macOS build; Windows needs Git for Windows; npm install requires Node.js 24.22.1+ or 26.12.1+. Screenshots are rendered example scenes, not benchmarks. Repo: https://github.com/X-T-E-R/kiki

Question: which roles would you hand to a local model first, and which tool descriptions trip your local models up?

## r/ChatGPTCoding

**Title:** One task, several models, each doing its part: an open-source local agent workbench with per-role models and Recipes

**Body:**

I wanted planning, implementation and review on different vendors' models, so I built this. Kiki (`kiki-agent`, MIT) runs as one service on your own machine so the desktop app, the terminal (`kiki`), the browser (`kiki web`), and your phone all show the same work. Your agents, your call.

For a multi-file change, the lead session splits the work: a reasoning model plans and verifies the final result, an `explore` subagent searches the repo on a fast model, an `implementer` handles scoped edits on DeepSeek or another OpenAI-compatible model, and a `reviewer` checks the diff on a different vendor.

- **Fitted to each model.** For models Kiki runs natively, a Recipe packages prompts plus model settings (and optional script hooks), installed once, bound to a model, with per-binding options. The author has published five recipes (GPT-6.1 Sol, GPT-6 Astra, DeepSeek V4.1, Gemini 4 Argon, Gemini 3.8 Flash) at `https://github.com/X-T-E-R/kiki-recipes` (MIT). Recipes do not apply when an external executor like Claude Code or Codex runs the turn.
- **Agent definitions are files you edit.** Each agent is a Markdown file: frontmatter for tools, model, effort, and which agents it may dispatch; body for the system prompt. Save it and the next dispatch uses it; a running session keeps its starting snapshot until you rebuild its context.
- **Rewrite a single tool description for one model.** Every built-in prompt field can be overridden globally, per model alias, or per agent. `kiki prompt-fields explain` prints what the model receives.
- **Keep working while it works.** The lead dispatches subagents and background tasks and gets notified when they finish. Messages you send meanwhile queue up, and each one can wait until the agent is idle, until subagents finish, or until tasks finish.
- **Bring your history and tools.** Claude Code, Codex, Pi, Grok Build, and OpenCode conversations import as continuable Kiki sessions or read-only archives, with a preview of what the import drops. Catalog plugins handle local PDFs and Office files (`Kiki Extract`, needing Python with MarkItDown), Word/Excel/PowerPoint (`Kiki Office Suite`), local CSV checks (`Kiki Work`), and `kiki-task-board`. Desktop app, TUI, and browser UI share one local daemon; Zed and JetBrains connect over `kiki acp`.

[video: 30 s real recording, or image: `docs/public/shots/workbench/workbench-per-role-models.en.png`]

Early (`0.5.1`, `0.x`), rough edges. Screenshots are rendered example scenes. https://github.com/X-T-E-R/kiki

What does your planner / worker / reviewer split look like today?
