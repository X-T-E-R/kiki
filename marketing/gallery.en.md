# Kiki screenshot tour

*All scenes below are rendered by the real Kiki UI on an example project.*

## The workbench

One window, the whole fleet: sessions on the left, the working transcript in the center, the live dispatch tree on the right, and a goal with a queued message at the bottom.

![The Kiki workbench in light theme.](shots/h01-fleet-workbench.en.light.png)

The same workbench in dark theme:

![The Kiki workbench in dark theme.](shots/h01-fleet-workbench.en.dark.png)

## Own the agent

Every agent is a Markdown file. In Settings you can read and edit the raw profile — source path, frontmatter bindings, system prompt and all.

![Editing a subagent profile's raw Markdown file in Settings.](shots/r01-reviewer-profile.en.light.png)

Every built-in prompt is overridable field by field, with a live preview of what the model will see.

![Prompt field overrides with a rendered preview.](shots/d02-prompt-fields.en.light.png)

## Run the fleet

Pin a goal the agent pursues across turns, and queue follow-up messages with per-message timing while it works.

![An active goal and a message queue with timing controls.](shots/r02-goal-queue.en.light.png)

Long-running work detaches into background tasks with status, output, and a stop switch.

![The per-session tasks page with a running task expanded.](shots/d03-tasks-page.en.light.png)

Scheduled tasks fire prompts into sessions on a cron schedule — inspectable, pausable, triggerable by hand.

![The scheduled-tasks panel with recurring, one-shot, and paused entries.](shots/d05-cron-panel.en.light.png)

## See everything

Open any dispatched agent to read its own transcript: what it was asked, what it did, what it concluded.

![A subagent's own workspace, previewed next to the main session.](shots/d01-agent-preview.en.light.png)

Tool steps fold away; completion notices stay on the timeline where you can check them.

![Folded tool steps and an expanded background-task completion notice.](shots/d04-tool-steps-notification.en.light.png)

## Task board

Each workspace has a kanban board where requirements live as first-class objects, linked to the sessions working on them.

![The workspace task board.](shots/r04-task-board.en.light.png)

From a card to the session doing the work, in one click.

![A task card's detail view with its linked sessions.](shots/board-task-detail.en.light.png)

## Web access, with real key management

Search and fetch run on named lanes you can inspect — keyless defaults included.

![Search lanes with readiness states and reasons.](shots/d06-search-lanes.en.light.png)

Fetch extraction chains fall through visibly when one extractor fails.

![A fetch extraction chain with visible fallbacks.](shots/d07-fetch-chain.en.light.png)

## Video input

Drop a screen recording into the chat; the agent watches it with you.

![A video attachment playing inline in a session.](shots/d08-video-attachment.en.light.png)
