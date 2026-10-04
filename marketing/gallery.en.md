# Kiki screenshot tour

Agents that answer to you. Kiki is an open-source AI agent workbench on your machine. [Back to the README](../README.md) · [All features](features.en.md) · [Online features →](https://x-t-e-r.github.io/kiki/en/features/)

*All scenes below are rendered by the real Kiki UI on an example project. They show the interface, not measured model performance.*

## The workbench

The whole window: sessions on the left, the working transcript in the center, the dispatch tree on the right, and a goal with a queued message at the bottom.

![The Kiki workbench in light theme.](shots/h01-fleet-workbench.en.light.png)

The same workbench in dark theme:

![The Kiki workbench in dark theme.](shots/h01-fleet-workbench.en.dark.png)

## Freedom: every layer is yours

Each role gets its own model. Here the thinker runs Astra at xhigh, the reviewer runs Fable, the builders run DeepSeek, and the scouts run GLM, all in one session.

![A dispatch tree with per-role model bindings.](shots/r05-multi-model-fleet.en.light.png)

Every agent is a Markdown file. In Settings you can read and edit the raw profile: source path, frontmatter bindings, and system prompt.

![Editing a subagent profile's raw Markdown file in Settings.](shots/r01-reviewer-profile.en.light.png)

Every built-in prompt field can be overridden, with a live preview of what the model will see.

![Prompt field overrides with a rendered preview.](shots/d02-prompt-fields.en.light.png)

## Power: built for long, many-threaded work

Open any dispatched agent to read its own transcript: what it was asked, what it did, and what it concluded.

![A subagent's own workspace, previewed next to the main session.](shots/d01-agent-preview.en.light.png)

Long-running work moves into background tasks, each with its status, output, and a stop control.

![The per-session tasks page with a running task expanded.](shots/d03-tasks-page.en.light.png)

Tool steps fold away. Completion notices stay on the timeline where you can check them.

![Folded tool steps and an expanded background-task completion notice.](shots/d04-tool-steps-notification.en.light.png)

Set a goal the agent pursues across turns, and queue follow-up messages, each with its own send timing, while it works.

![An active goal and a message queue with timing controls.](shots/r02-goal-queue.en.light.png)

Scheduled tasks send prompts into sessions on a cron schedule, and you can inspect, pause, or trigger each one by hand.

![The scheduled-tasks panel with recurring, one-shot, and paused entries.](shots/d05-cron-panel.en.light.png)

Each workspace has a requirement board that outlasts any one session, and each card links to the sessions working on it.

![The workspace task board.](shots/r04-task-board.en.light.png)

![A task card's detail view with its linked sessions.](shots/board-task-detail.en.light.png)

Web search and fetch run on named lanes you can inspect, and some work without a key.

![Search lanes with readiness states and reasons.](shots/d06-search-lanes.en.light.png)

![A fetch extraction chain with visible fallbacks.](shots/d07-fetch-chain.en.light.png)

Drop a screen recording into the chat, and the agent watches it with you.

![A video attachment playing inline in a session.](shots/d08-video-attachment.en.light.png)
