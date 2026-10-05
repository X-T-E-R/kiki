# Kiki screenshot tour

The Kiki workbench, one capability at a time. [Back to the README](../README.md) · [All features](features.en.md) · [Online features →](https://x-t-e-r.github.io/kiki/en/features/)

## The workbench

The whole window: sessions on the left, the working transcript in the center, the dispatch tree on the right, and a goal with a queued message at the bottom.

![The Kiki workbench in light theme.](shots/h01-fleet-workbench.en.light.png)

The same workbench in dark theme:

![The Kiki workbench in dark theme.](shots/h01-fleet-workbench.en.dark.png)

## One workbench, many lines

Each role in the dispatch tree runs its own model. Here the thinker runs Astra at xhigh, the reviewer runs Fable, the builders run DeepSeek, and the scouts run GLM, all in one session.

![A dispatch tree with per-role model bindings.](shots/r05-multi-model-fleet.en.light.png)

Open any dispatched agent to read its own transcript: what it was asked, what it did, and what it concluded.

![A subagent's own workspace, previewed next to the main session.](shots/d01-agent-preview.en.light.png)

Long-running work moves into background tasks, each with its status, output, and a stop control.

![The per-session tasks page with a running task expanded.](shots/d03-tasks-page.en.light.png)

## Work that runs long

Set a goal the agent pursues across turns, and queue follow-up messages, each with its own send timing, while it works.

![An active goal and a message queue with timing controls.](shots/r02-goal-queue.en.light.png)

When the context window fills up, you choose what happens at the compaction point: compress into a summary, restart from the agent's working notes, or let it decide per run.

![The context meter's detail card, with the compaction track and the renewal strategy set to Fresh.](shots/long-work-context-fresh.en.light.png)

Memory keeps facts across sessions, as global, per workspace, or per persona, and every change can be undone.

![The memory page showing the three scopes, an entry, and its change history.](shots/long-work-memory-scopes.en.light.png)

Scheduled tasks send prompts into sessions on a cron schedule while a Kiki process holds that session open, and you can inspect or cancel each one.

![The scheduled-tasks panel with recurring, one-shot, and paused entries.](shots/d05-cron-panel.en.light.png)

Each workspace has a requirement board that outlasts any one session, and each card links to the sessions working on it.

![The workspace task board.](shots/r04-task-board.en.light.png)

![A task card's detail view with its linked sessions.](shots/board-task-detail.en.light.png)

## The daily driver

Tool steps fold away, and completion notices stay on the timeline where you can check them.

![Folded tool steps and an expanded background-task completion notice.](shots/d04-tool-steps-notification.en.light.png)

The usage page breaks a date range into tokens and cost, with separate indicators for whether each figure is complete.

![The usage page on its History tab.](shots/daily-usage.en.light.png)

## Roles you can talk to

A persona is an identity with its own memory. The card names it, gives it an avatar, and says what it is for.

![The persona editor, with the identity card and its standing rules.](shots/people-persona-card.en.light.png)

Clicking a persona's name always opens the same conversation, while the persona can hold several at once.

![A persona's daily conversation, with the list of its other conversations.](shots/people-daily-conversation.en.light.png)

In a room, two to six personas discuss one topic in order, with a host and a budget.

![A room where three personas discuss a release, each message attributed to its speaker.](shots/people-room.en.light.png)

## Your data, your machines

A space is one Kiki you open, and each subspace decides whether it shares credentials with the main space or keeps its own.

![The spaces list, with a subspace's credential scope.](shots/spaces-spaces-list.en.light.png)

A remote connection points one Kiki home at another, and the target approves the source before anything flows.

![The remote connections list, with one connected home and its actions.](shots/spaces-remote-connections.en.light.png)

Web access opens this Kiki in a browser on another device, through a single-use link.

![Web access turned on, with the mode and the signed-in browsers listed.](shots/spaces-web-access.en.light.png)

## Every layer is yours

Every agent is a Markdown file. In Settings you can read and edit the raw profile: source path, frontmatter bindings, and system prompt.

![Editing a subagent profile's raw Markdown file in Settings.](shots/r01-reviewer-profile.en.light.png)

Every built-in prompt field can be overridden, with a live preview of what the model will see.

![Prompt field overrides with a rendered preview.](shots/d02-prompt-fields.en.light.png)

Every way Kiki reaches a model is one row in one list, and how it authenticates is part of that row.

![The connections list, with signed-in and expired rows side by side.](shots/freedom-connections.en.light.png)

## Bring your history, meet other tools

Another tool's conversations can become Kiki sessions you keep working in, and the preview says what is kept and what is not.

![The history import preview, listing the sources and what the import would drop.](shots/ecosystem-history-import.en.light.png)

## Find things on the web

Web search and fetch run on named lanes you can inspect, and some work without a key.

![Search lanes with readiness states and reasons.](shots/d06-search-lanes.en.light.png)

![A fetch extraction chain with visible fallbacks.](shots/d07-fetch-chain.en.light.png)

Drop a screen recording into the chat, and the agent watches it with you.

![A video attachment playing inline in a session.](shots/d08-video-attachment.en.light.png)
