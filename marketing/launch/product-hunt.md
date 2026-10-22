# Product Hunt

**Name:** Kiki

**Tagline** (≤ 60 chars): Agents that answer to you. Open, local, any model.

Alternates: "An AI agent workbench where every layer is yours" · "Your agent files, your models, your prompts"

**Description** (≤ 260 chars):
Kiki is an open-source AI agent workbench for your machine. Hand it a folder — codebase, PDFs and spreadsheets, a draft. Each role is a Markdown file on its own model; any prompt field can be rewritten. Sessions stay local; models use providers you choose.

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

**Freedom.** Bind each role to its own model and mix vendors (Kimi, DeepSeek, GLM, Claude, GPT, Gemini). Each agent is a Markdown file you own: frontmatter sets tools, model, and which agents it may dispatch, the body is the system prompt. Save it and the next dispatch uses it, while a session already running keeps its startup snapshot until you rebuild its context. Any built-in prompt text, even a single tool's description, can be rewritten per model, and `kiki prompt-fields` shows what the model actually receives. Bringing an agent file from another tool means migrating its frontmatter — the loader names any key it does not recognise instead of guessing. Sessions, history, and configuration stay in your local Kiki home; your project folders stay put; model requests go only to the providers you connect. MIT-licensed.

**Power.** It's built for long, many-threaded work: the lead agent dispatches subagents and background tasks and is notified when they finish. You can keep typing while it's busy — each queued message waits for idle, for subagents, or for tasks. Goals keep a target in view across turns, cron prompts fire while a Kiki process holds that session open, and the optional `kiki-task-board` plugin gives each workspace requirement cards that outlast a session.

**Beyond code.** The same session that maps a codebase can read a folder of PDFs and check their figures against a spreadsheet, draft a report, or drive a browser you are already signed into. Those formats come from catalog plugins — `Kiki Extract` for PDF and Office to Markdown (needs Python with MarkItDown), `Kiki Office Suite` for Word, Excel, and PowerPoint, `Kiki Work` for local CSV checks — and browser control picks whichever source you set up.

It's early (0.x). The macOS build is unsigned, and Windows needs Git for Windows. I'd love to hear what you'd want to customize next.
