# Show HN draft

**Title** (≤ 80 chars):

Show HN: Kiki – One task, several models, each doing its part

Alternates:
- Show HN: Kiki – an open-source workbench where each role runs its own model
- Show HN: Kiki – override any prompt field or model Recipe on your own machine
- Show HN: Kiki – desktop, TUI, and browser on one local daemon

**URL:** https://github.com/X-T-E-R/kiki

**First comment (post immediately):**

I wanted planning, implementation and review on different vendors' models, so I built this. Kiki (`kiki-agent`, MIT) is an open-source local agent workbench: one service runs on your own machine, and the desktop app, the terminal (`kiki`), the browser (`kiki web`), and your phone all show the same work. One task, several models, each doing its part. Your agents, your call.

On a multi-file change or an unfamiliar repo, the lead session splits the job: a reasoning model plans and reviews the final diff, a fast read-only `explore` subagent maps the codebase on its own model, an `implementer` runs the scoped edits on a cheaper or local OpenAI-compatible endpoint, and a `reviewer` on a third vendor checks the result without sharing the implementer's blind spots. Each role is a plain Markdown file with frontmatter (`tools`, `model_alias`, `thinking_effort`, permitted child agents) and a system prompt body. A subagent with no model bound and no `[subagent].default_model` fails loudly with `model.not_configured` rather than silently borrowing the lead's expensive model.

- **Fitted to each model.** Claude Code is tuned for Claude and Codex for GPT. For models Kiki runs natively, it tunes itself to each model you connect through a Recipe: prompts plus model settings (and optional script hooks), installed once, bound to that model, with per-binding options. The author has published five recipes (GPT-6.1 Sol, GPT-6 Astra, DeepSeek V4.1, Gemini 4 Argon, Gemini 3.8 Flash) in the public MIT repository `https://github.com/X-T-E-R/kiki-recipes`, where one model is prompted to work out mechanism and counter-examples before acting and another anchors on a sample first. Adapt one or write your own; recipes apply to native models rather than external executors.
- **Per-model prompt overrides and transparency.** Every named piece of the built-in prompt — down to `tool.web-search.description` — can be overridden globally, per model alias, or per agent. `kiki prompt-fields explain <field> --agent X --model Y` prints the effective text and the full source chain.
- **Runs on your machine, every step in view.** Work files stay in the folder you choose; sessions, history, and configuration stay in your local Kiki home; model requests go only to the providers or local servers you configure. Background commands and subagents notify the lead when they finish. While an agent is busy, queued messages let you set delivery timing per message (when idle, after subagents finish, or after tasks finish). The Usage page's Live tab names the concurrency rule holding a waiting request, and History marks missing provider usage as unknown rather than zero.
- **Extending beyond plain text.** Optional catalog plugins cover local PDF/Office-to-Markdown extraction (`Kiki Extract`, needing Python with MarkItDown on the server machine), Word/Excel/PowerPoint (`Kiki Office Suite`), local CSV checks (`Kiki Work`), manuscript drafting (`Kiki Writing`), `kiki-task-board`, `Kimi Datasource`, and `Kiki Media`. Conversation history from Claude Code, Codex, Pi, Grok Build, or OpenCode imports as continuable sessions or read-only archives, `kiki acp` runs Kiki inside Zed or JetBrains, `kiki seat` fixes an inbound MCP seat, and a subagent can run on an external harness.

Honest limits:
- Current release is `0.5.1` (`0.x`), and there are rough edges.
- The macOS `.dmg` is unsigned and not notarized (`Control-click → Open` on first launch); Windows requires Git for Windows; npm install requires Node.js 24.22.1+ or 26.12.1+.
- Kimi works out of the box; Anthropic, OpenAI-compatible services, OpenAI Responses API, Gemini, Vertex AI, and GitHub Copilot / ChatGPT / Grok Build OAuth sign-ins are added in Settings or `config.toml`.
- Screenshots in the repo are rendered by the real UI from example scenes (`docs/public/shots/`), not benchmarks.

Feedback I'd most appreciate: the Markdown profile contract, Recipes for the models you run most, and which prompt fields or hooks you wish agent tools exposed.
