# Show HN draft

**Title** (≤ 80 chars):

Show HN: Kiki – an open-source agent workbench where you can rewrite every prompt

Alternates:
- Show HN: Kiki – run Claude Code agent files on any model, mixed per role
- Show HN: Kiki – a local AI agent workbench (desktop, TUI, browser, one daemon)

**URL:** https://github.com/X-T-E-R/kiki

**First comment (post immediately):**

Hi HN. Kiki is an MIT-licensed AI agent workbench that runs on your machine. It has a desktop app, a TUI, and a browser UI, all on one local daemon and one session store. It started as a fork of Kimi Code and is now developed independently.

I built it because I wanted every layer of the agent to be something I could open and change:

- **Agents are files.** Each agent is a Markdown file. The frontmatter holds its tools, its model, and which agents it may dispatch, and the body is its system prompt. Claude Code and OpenCode agent files load as they are. Edits reload after about 200 ms, and running agents keep the snapshot they started with.
- **Models per role.** The lead agent can run on one vendor, workers on cheap models (DeepSeek, GLM, anything OpenAI-compatible), and a reviewer on a third vendor. A subagent never silently falls back to the caller's model: if no model is bound, the dispatch fails.
- **Prompt fields.** Every named piece of the built-in prompt can be overridden globally, per model alias, or per agent, down to a single tool's description. `kiki prompt-fields explain <field> --agent X --model Y` shows the effective value and the source chain. I use this mostly to rewrite tool descriptions for smaller models.
- **Long, parallel work.** The lead agent dispatches subagents and background tasks itself and is notified when they finish, so it doesn't poll. Messages you send while it's busy go into a queue, and each message can wait for idle, for subagents to finish, or for tasks to finish. There is also a per-workspace requirement board the agent reads and writes, which outlives sessions, plus `/goal` and cron prompts.
- Zed and JetBrains can use it over ACP (`kiki acp`).

Honest limits:
- It's early (0.x), and there are rough edges.
- The macOS build is unsigned and not notarized.
- Windows needs Git for Windows.
- Kimi works out of the box; other providers need a config entry.
- The README images are rendered by the real UI from example data. They aren't benchmarks, and I'm not making any performance claims.
- A lot of what's here (subagents, multiple models, goals) exists in other tools too. The parts I haven't seen elsewhere are the prompt-field layering and the per-message queue timing.

Feedback I'd most like: the agent-file format, and which prompt fields you'd want exposed that aren't.
