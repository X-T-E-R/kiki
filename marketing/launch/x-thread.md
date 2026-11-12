# X thread (5 posts)

Attach media to posts 1, 2, 3, 4. Post 1 opens with the multi-model fleet screenshot (`docs/public/shots/workbench/workbench-per-role-models.en.png`), or the 30 s real recording if it exists alongside it.

**1/**
One task, several models. Each doing its part.
Your agents, your call.

Kiki is an open-source (MIT) agent workbench running as a service on your own machine: desktop, terminal (`kiki`), browser (`kiki web`), and phone all show the same work.
[`docs/public/shots/workbench/workbench-per-role-models.en.png`]

**2/**
Claude Code is tuned for Claude; Codex is tuned for GPT.
Fitted to each model: Kiki tunes itself to each native model you connect through a Recipe — prompts + model settings (+ optional script hooks), installed once, bound to a model, with per-binding options.

5 recipes published (MIT): GPT-6.1 Sol, GPT-6 Astra, DeepSeek V4.1, Gemini 4 Argon, Gemini 3.8 Flash → github.com/X-T-E-R/kiki-recipes
[`docs/public/shots/freedom/d02-prompt-fields.en.png`]

**3/**
Each agent is a Markdown file you own.
Frontmatter sets tools, `model_alias`, effort, and permitted child agents; body is the system prompt.
Saved edits apply to the next dispatch; no silent fallback when a subagent has no model bound.
Any built-in prompt field can also be overridden per model (`kiki prompt-fields explain`).
[`docs/public/shots/agents/r01-reviewer-profile.en.png`]

**4/**
Built for long, many-threaded work on your machine:
- subagents and background tasks notify the lead when done
- messages you type while it is busy queue per-message: when idle, after subagents, or after tasks
- `/goal` across turns, cron while a session is held open, and optional `kiki-task-board`
[`docs/public/shots/long-work/long-work-goal-queue.en.png`]

**5/**
Sessions, history, and config stay in your local Kiki home; work files stay in your folder; model requests go only to providers or local servers you connect.
Import Claude Code / Codex / OpenCode history, connect Zed or JetBrains via `kiki acp`.

Early `0.x` (`0.5.1`).
`npm i -g kiki-agent` (Node 24.22.1+ or 26.12.1+)
github.com/X-T-E-R/kiki
