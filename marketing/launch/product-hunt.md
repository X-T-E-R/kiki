# Product Hunt

**Name:** Kiki

**Tagline** (≤ 60 chars): Agents that answer to you. Open, local, any model.

Alternates: "An AI agent workbench where every layer is yours" · "Your agent files, your models, your prompts"

**Description** (≤ 260 chars):
Kiki is an open-source AI agent workbench that runs on your machine. Agents are Markdown files (Claude Code/OpenCode files work as-is), every role can use a different vendor's model, and you can rewrite any prompt field. Desktop, terminal, and browser included.

**Topics:** Developer Tools · Artificial Intelligence · Open Source

**Gallery** (1270×760, in this order; every still is a rendered example scene, so say so in the caption):
1. Real screen recording, 30 s cut (see [demo-storyboard.md](demo-storyboard.md)). Label: "Real session, sped up".
2. `h01-fleet-workbench.en.light`: "One lead session, many lines of work"
3. `d02-prompt-fields.en.light`: "Rewrite any prompt field, per model"
4. `r05-multi-model-fleet.en.light`: "A different model for each role"
5. `r02-goal-queue.en.light`: "Queue messages, each with its own timing"
6. `r04-task-board.en.light`: "A requirement board that outlasts sessions"
7. `r01-reviewer-profile.en.light`: "An agent is a Markdown file"

If the recording isn't ready, lead with h01 and drop item 1. Don't use the fixture fallback cut as PH video.

**Maker comment:**

Hi Product Hunt! I built Kiki because I wanted an AI agent I could actually open up.

**Freedom.** Every layer is yours. Bind each role to its own model and mix vendors (Kimi, DeepSeek, GLM, Claude, GPT, Gemini). Each agent is a Markdown file you own, and your Claude Code or OpenCode agent files load as they are. Any built-in prompt text, even a single tool's description, can be rewritten per model, and `kiki prompt-fields` shows what the model actually receives. Everything stays local, and it's MIT-licensed.

**Power.** It's built for long, many-threaded work. The lead agent dispatches subagents and background tasks and is notified when they finish. You can keep typing while it's busy: each queued message waits for idle, for subagents, or for tasks. A workspace requirement board, goals, and cron keep work going across sessions.

It's early (0.x). The macOS build is unsigned, and Windows needs Git for Windows. I'd love to hear what you'd want to customize next.
