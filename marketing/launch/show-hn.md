# Show HN draft

**Title** (≤ 80 chars):

Show HN: Kiki – Open-source local agent workbench with per-role models & prompts

Alternates:
- Show HN: Kiki – a local agent workbench where each role gets its own model
- Show HN: Kiki – override any prompt field, down to one tool description
- Show HN: Kiki – desktop, TUI, and browser on one local daemon

**URL:** https://github.com/X-T-E-R/kiki

**First comment (post immediately):**

Hi HN. Kiki is an MIT-licensed AI agent workbench that runs on your machine. The desktop app, the terminal UI (`kiki`), and the browser UI (`kiki web`) connect to one local daemon and share the same store under your local Kiki home: sessions, history, and configuration. Your project folders stay where they are. Model requests go only to the providers or local servers you configure. It started as a fork of Kimi Code and is now developed independently.

I built it for work that outgrows a single chat turn or a single model — mapping or refactoring an unfamiliar repo, reconciling a folder of PDFs and spreadsheets into a cited summary, or running research and writing workflows — without locking the agent's instructions and routing inside a black box:

- **Per-role model bindings.** The main agent plans and dispatches isolated subagents (`AgentRun`, `AgentList`, `AgentSend`). You can bind the lead to a frontier model, read-only explorers or workers to cheaper or local OpenAI-compatible endpoints, and a reviewer to a third vendor so it doesn't share the implementer's blind spots. A subagent never silently inherits the parent's expensive model: with no model bound and no default set, dispatch fails with `model.not_configured`.
- **Agents are plain Markdown files.** Each profile sets tools, model, effort, and permitted child agents in frontmatter, with the system prompt as the body. Saved edits apply to the next dispatch, while a running session keeps its startup snapshot until you rebuild its context. Frontmatter keys are closed, so a field carried over from another tool fails the load and is named rather than silently ignored; the docs hold the migration mapping.
- **Prompt field overrides down to one tool description.** Smaller models often fail by misusing one specific tool rather than failing to reason altogether. Every named piece of the built-in prompt — down to `tool.web-search.description` — can be overridden globally, per model alias, or per agent. `kiki prompt-fields explain <field> --agent X --model Y` prints the effective text and the layer it came from.
- **Steerable long-running work.** Background commands and subagents notify the lead when they finish instead of polling. Messages you send while the agent is busy join a queue where each message picks its own delivery timing: when idle, after subagents finish, or after tasks finish. `/goal` across turns, cron prompts (firing while a Kiki process holds that session open), undoable memory (global / workspace / persona), and requirement cards from the optional `kiki-task-board` plugin carry work across sessions.
- **Live concurrency and honest cost.** The Usage page's Live tab names the exact concurrency rule holding a waiting request back, and History marks calls where a provider returned no usage as unknown rather than faking a zero.
- **When the work leaves plain text.** Catalog plugins add local PDF/Office-to-Markdown extraction (`Kiki Extract`; PDF and Office input need Python with MarkItDown on the machine running Kiki), local Word/Excel/PowerPoint editing (`Kiki Office Suite`), local CSV reconciliation (`Kiki Work`), manuscript drafting (`Kiki Writing`), and media generation (`Kiki Media`). Kimi Datasource answers market, macro, company, literature, and Chinese-law queries after a Kimi Code OAuth sign-in, and spends plan quota.
- **Browsers and other tools.** Browser control is a system capability rather than one plugin: drive the browser you already use through the Kimi Browser Extension and its store extension, run a browser Kiki manages, attach an existing one over CDP, or select an Ego Lite install you set up yourself. Conversation history from Claude Code, Codex, Pi, Grok Build, or OpenCode imports as continuable sessions or read-only archives. `kiki acp` runs Kiki inside Zed or JetBrains, `kiki seat` fixes a seat for inbound MCP clients, and a subagent can run on an external harness.

Honest limits:
- Current release is `0.4.1` (`0.x`), and there are rough edges.
- The macOS `.dmg` is unsigned and not notarized (`Control-click → Open` on first launch); Windows requires Git for Windows; npm install requires Node.js 24.22.1+ or 26.12.1+.
- Kimi works out of the box; Anthropic, OpenAI-compatible services, OpenAI Responses API, Gemini, Vertex AI, and local ChatGPT / GitHub Copilot / Grok Build OAuth sign-ins are added in Settings or `config.toml`.
- Screenshots in the repo are rendered by the real UI from example scenes, not benchmarks.

Feedback I'd most appreciate: the Markdown profile contract, and which prompt fields or execution hooks you wish agent tools exposed.
