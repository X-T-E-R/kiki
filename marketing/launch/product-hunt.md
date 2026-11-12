# Product Hunt

**Name:** Kiki

**Tagline** (≤ 60 chars): One task, several models, each doing its part.

Alternates: "Your agents, your call." · "Local multi-model agent workbench, MIT open source"

**Description** (≤ 260 chars):
One task, several models, each doing its part. Kiki is an open-source local agent workbench running on your own machine: desktop, terminal, browser, and phone show the same work, with per-role models, installable Recipes, and inspectable prompt overrides.

**Topics:** Developer Tools · Artificial Intelligence · Open Source

**Gallery** (1270×760, in this order; every still is a rendered example scene, so say so in the caption):
1. Real screen recording, 30 s cut (see [demo-storyboard.md](demo-storyboard.md)). Label: "Real session, sped up".
2. `workbench-per-role-models.en.png`: "One task, several models, each doing its part (rendered example)"
3. `hero-workbench.en.png`: "Desktop, terminal, browser, and phone on one local service (rendered example)"
4. `d02-prompt-fields.en.png`: "Rewrite any prompt field, per model (rendered example)"
5. `long-work-goal-queue.en.png`: "Queue messages, each with its own timing (rendered example)"
6. `r04-task-board.en.png`: "A requirement board that outlasts sessions (rendered example)"
7. `r01-reviewer-profile.en.png`: "An agent is a Markdown file (rendered example)"

If the recording isn't ready, lead with `workbench-per-role-models.en.png` and drop item 1. Don't use the fixture fallback cut as PH video.

**Maker comment:**

Hi Product Hunt. One task, several models, each doing its part. Your agents, your call. Kiki is an open-source (MIT) agent workbench that runs as a service on your own machine, so desktop, terminal (`kiki`), browser (`kiki web`), and your phone all show the same work.

- **You choose the models, per role.** The lead session splits the work: a strong model plans, cheaper models handle exploration or routine edits, and a different vendor reviews so it does not share the implementer's blind spots. Each agent is a plain Markdown file you own: frontmatter sets tools, `model_alias`, effort, and which agents it may dispatch; the body is the system prompt. Saved edits apply to the next dispatch, while a running session keeps its startup snapshot until you rebuild its context. Any built-in prompt field, down to a single tool description, can also be overridden per model, and `kiki prompt-fields explain` shows what the model receives.
- **Fitted to each model.** Claude Code is tuned for Claude and Codex for GPT. For models Kiki runs natively, it tunes itself to each model you connect through a Recipe: prompts plus model settings (and optional script hooks), installed once, bound to that model, with per-binding options. The author has published five recipes (GPT-6.1 Sol, GPT-6 Astra, DeepSeek V4.1, Gemini 4 Argon, Gemini 3.8 Flash) in the public repository `https://github.com/X-T-E-R/kiki-recipes` (MIT) — adapt one or write your own. Recipes apply to native models, not when an external executor like Claude Code or Codex runs the turn.
- **Runs on your machine, built for long work.** Work files stay in the folder you choose; sessions, history, and configuration stay in your local Kiki home; model requests go only to the providers or local servers you connect. Background commands and subagents notify the lead when they finish. You can keep typing while it is busy — each queued message waits until idle, after subagents finish, or after tasks finish. `/goal` across turns, cron prompts while a Kiki process holds that session open, optional plugins (`kiki-task-board`, `Kiki Extract` for local PDFs/Office with Python and MarkItDown, `Kiki Office Suite`, `Kiki Work`), and WeChat/QQ phone sessions keep work moving.

It is early (`0.5.1`, `0.x`). The macOS build is unsigned, and Windows needs Git for Windows. I'd love to hear which models you split across a task and what you would customize first.
