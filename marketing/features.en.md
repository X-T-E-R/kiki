# Kiki features

Each capability below has one line on what it does for you, one screenshot, and a link to the full docs. [Back to the README](../README.md) · [Screenshot tour](gallery.en.md)

*Screenshots are rendered by the real Kiki UI on an example project. They show the interface, not measured model performance. Items marked "coming soon" are still in development and are not yet in a release.*

## Agents and models

### Subagents, each on its own model

The main agent dispatches subagents itself, and each role can run a different provider's model, so a strong model can plan while cheaper models do the routine work. Each subagent has its own context, and you can open its transcript.

![A dispatch tree where each role is bound to a different model.](shots/r05-multi-model-fleet.en.light.png)

[Named child agents →](https://x-t-e-r.github.io/kiki/en/customization/agents#named-child-agents)

### Agent files you own

Each agent is a Markdown file: the frontmatter sets its tools, model, and which subagents it may dispatch, and the body is its system prompt. Claude Code and OpenCode agent files load unchanged. Creating agents from templates in the app is coming soon.

![A subagent's Markdown profile open in Settings.](shots/r01-reviewer-profile.en.light.png)

[Agent file format →](https://x-t-e-r.github.io/kiki/en/customization/agents#agent-file-format)

### Prompt field overrides

You can replace any named part of the built-in prompt, down to a single tool description, globally, per model, or per agent, and `kiki prompt-fields` shows what the model will receive.

![Prompt field overrides with a rendered preview.](shots/d02-prompt-fields.en.light.png)

[Prompt field overrides →](https://x-t-e-r.github.io/kiki/en/customization/prompt-fields)

### Providers and models

Connect Kimi, Anthropic, OpenAI-compatible services such as DeepSeek or Qwen, the OpenAI Responses API, Gemini, or Vertex AI, and give each model a short alias so you can bind it to a role.

*Screenshot coming (not yet in the reshoot plan).*

[Providers and models →](https://x-t-e-r.github.io/kiki/en/configuration/providers)

## Long-running work

### Background tasks

Long commands and subagents can run in the background. When one finishes, its result goes back to the agent automatically, so neither you nor the agent has to keep checking on it.

![The tasks page with a running task expanded.](shots/d03-tasks-page.en.light.png)

[Background tasks →](https://x-t-e-r.github.io/kiki/en/reference/tools#background-tasks)

### Goals and the message queue

Give the agent a goal with `/goal` and it keeps working toward it across turns. `/goal next` lines up the next goal, and messages you send while the agent is busy wait in a queue instead of cutting it off.

![An active goal with queued messages.](shots/r02-goal-queue.en.light.png)

[Goals →](https://x-t-e-r.github.io/kiki/en/guides/goals#queue-upcoming-goals)

### Scheduled tasks

The agent can schedule a prompt to run in the current session, either once or on a cron schedule. Use this for recurring checks, reports, and reminders.

![Recurring and one-shot scheduled tasks.](shots/d05-cron-panel.en.light.png)

[Scheduled tasks →](https://x-t-e-r.github.io/kiki/en/reference/tools#scheduled-tasks)

### Task board

Each workspace has a kanban board where requirements are cards, each linked to the sessions working on it. The main agent can read and update the board too.

![The workspace task board.](shots/r04-task-board.en.light.png)

[Task board spotlight →](task-board.en.md) · [Docs →](https://x-t-e-r.github.io/kiki/en/guides/sessions#requirements-board)

## Finding things

### Web search and fetch

Search and page fetching run on named lanes you can inspect. GitHub and Context7 lanes work without a key, and multiple keys per provider rotate with cooldowns.

![Search lanes with their readiness and reasons.](shots/d06-search-lanes.en.light.png)

[nb-search spotlight →](nb-search.en.md) · [Docs →](https://x-t-e-r.github.io/kiki/en/reference/tools)

### Session search

Press Cmd/Ctrl+K to search sessions by title, workspace, and last prompt. Searching inside conversation content is coming soon.

*Screenshot coming: `a03-session-search`.*

[Release notes →](https://x-t-e-r.github.io/kiki/en/release-notes/changelog)

### Video input

Paste a screen recording or clip into the chat and have the model look at it, provided the current model accepts video.

![A video attachment playing inline in a session.](shots/d08-video-attachment.en.light.png)

[Pasting images and video →](https://x-t-e-r.github.io/kiki/en/guides/interaction#pasting-images-and-video)

## Control and extension

### Permission modes

You choose how often the agent asks before acting. Manual asks for side effects, Auto handles routine work and still asks about sensitive targets, YOLO approves everything, and explicit deny rules always win. **Approve for me**, where a reviewer model you pick decides on risky actions and hands uncertain ones back to you, is coming soon.

*Screenshot coming: `a01-approve-for-me`.*

[Interaction and approvals →](https://x-t-e-r.github.io/kiki/en/guides/interaction)

### Plugins, MCP, and skills

Connect MCP servers for external tools, save reusable workflows as skills that also work as slash commands, and install plugins that bundle skills, agents, and MCP servers together.

*Screenshot coming (not yet in the reshoot plan).*

[Plugins →](https://x-t-e-r.github.io/kiki/en/customization/plugins) · [MCP →](https://x-t-e-r.github.io/kiki/en/server/mcp) · [Skills →](https://x-t-e-r.github.io/kiki/en/customization/skills)

### Hooks

Run your own scripts on lifecycle events: block a dangerous shell command, add context when a message is submitted, or get a notification when a task finishes.

*Screenshot coming (not yet in the reshoot plan).*

[Hooks →](https://x-t-e-r.github.io/kiki/en/customization/hooks)

## Where you use it

### Desktop, terminal, and browser

The desktop app, the terminal UI (`kiki`), and the browser UI (`kiki web`) share one local daemon and read and write the same session data.

![The Kiki desktop workbench.](shots/h01-fleet-workbench.en.light.png)

[Desktop app →](https://x-t-e-r.github.io/kiki/en/getting-started/desktop-app) · [First launch →](https://x-t-e-r.github.io/kiki/en/getting-started/first-launch) · [Local server and browser UI →](https://x-t-e-r.github.io/kiki/en/server/local-server)

### Editors over ACP

Run `kiki acp` to use Kiki as the agent inside Zed, JetBrains IDEs, or other Agent Client Protocol clients.

*Screenshot coming (not yet in the reshoot plan).*

[Using Kiki in IDEs →](https://x-t-e-r.github.io/kiki/en/server/ide)
