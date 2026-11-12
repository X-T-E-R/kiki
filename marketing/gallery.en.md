# Kiki screenshot tour

The Kiki workbench, one capability at a time. [Back to the README](../README.md) · [All features](features.en.md) · [Online features →](https://x-t-e-r.github.io/kiki/en/features/)

## One workbench, many lines

Each role in the dispatch tree runs its own model. Here the thinker runs Astra at xhigh, the reviewer runs Fable, the builders run DeepSeek, and the scouts run GLM, all in one session.

![A dispatch tree with per-role model bindings.](../docs/public/shots/workbench/workbench-per-role-models.en.png)

Open any dispatched agent to read its own transcript: what it was asked, what it did, and what it concluded.

![A subagent's own workspace, previewed next to the main session.](../docs/public/shots/workbench/d01-agent-preview.en.png)

Long-running work moves into background tasks, each with its status, output, and a stop control.

![The per-session tasks page with a running task expanded.](../docs/public/shots/workbench/d03-tasks-page.en.png)

## The workbench

The whole window: sessions on the left, the working transcript in the center, the dispatch tree on the right, and a goal with a queued message at the bottom.

![The Kiki workbench in light theme.](../docs/public/shots/index/hero-workbench.en.png)

The same workbench in dark theme:

![The Kiki workbench in dark theme.](../docs/public/shots/theme-dark/hero-workbench.en.dark.png)

## Work that runs long

Set a goal the agent pursues across turns, and queue follow-up messages, each with its own send timing, while it works.

![An active goal and a message queue with timing controls.](../docs/public/shots/long-work/long-work-goal-queue.en.png)

When the context window fills up, you choose what happens at the compaction point: compress into a summary, restart from the agent's working notes, or let it decide per run.

![The context meter's detail card, with the compaction track and the renewal strategy set to Fresh.](../docs/public/shots/long-work/long-work-context-fresh.en.png)

Memory keeps facts across sessions, as global, per workspace, or per persona. Each entry says what it is based on, and every change can be undone.

![The memory page showing the three scopes, an entry, and its change history.](../docs/public/shots/long-work/long-work-memory-scopes.en.png)

Scheduled tasks send prompts into sessions on a cron schedule while a Kiki process holds that session open, and you can inspect or cancel each one.

![The scheduled-tasks panel with recurring, one-shot, and paused entries.](../docs/public/shots/long-work/d05-cron-panel.en.png)

With the optional `kiki-task-board` plugin, each workspace gets a requirement board that outlasts any one session, and each card links to the sessions working on it.

![The workspace task board.](../docs/public/shots/long-work/r04-task-board.en.png)

![A task card's detail view with its linked sessions.](../docs/public/shots/long-work/board-task-detail.en.png)

## The daily driver

Tool steps fold away, and completion notices stay on the timeline where you can check them.

![Folded tool steps and an expanded background-task completion notice.](../docs/public/shots/daily/d04-tool-steps-notification.en.png)

The usage page breaks a date range into tokens and cost, with separate indicators for whether each figure is complete.

![The usage page on its History tab.](../docs/public/shots/daily/daily-usage.en.png)

Its Live tab shows what is running and what is waiting, and names the concurrency rule holding each waiting request — the same rule, editable, right below.

![The Live tab, with a waiting request and the concurrency rules that gate it.](../docs/public/shots/daily/ux-usage-live.en.png)

External sync sends the content-free numbers to a webhook, a VibeCafe account, or a script you approve, and shows each destination's own state — including a refused credential that kept its queue.

![The External sync tab, with a webhook, a VibeCafe destination, and a script in three different states.](../docs/public/shots/daily/ux-usage-export.en.png)

## Roles you can talk to

A persona is an identity with its own memory. The card names it, gives it an avatar, and says what it is for.

![The persona editor, with the identity card and its standing rules.](../docs/public/shots/people/people-persona-card.en.png)

Clicking a persona's name always opens the same conversation, while the persona can hold several at once.

![A persona's daily conversation, with the list of its other conversations.](../docs/public/shots/people/people-daily-conversation.en.png)

In a room, two to six personas discuss one topic in order, with a host and a budget.

![A room where three personas discuss a release, each message attributed to its speaker.](../docs/public/shots/people/people-room.en.png)

## Your data, your machines

A space is one Kiki you open, and each subspace decides whether it shares credentials with the main space or keeps its own.

![The spaces list, with a subspace's credential scope.](../docs/public/shots/spaces/spaces-spaces-list.en.png)

A remote connection points one Kiki home at another, and the target approves the source before anything flows.

![The remote connections list, with one connected home and its actions.](../docs/public/shots/spaces/spaces-remote-connections.en.png)

Web access opens this Kiki in a browser on another device, through a single-use link.

![Web access turned on, with the mode and the signed-in browsers listed.](../docs/public/shots/spaces/spaces-web-access.en.png)

## Every layer is yours

Every agent is a Markdown file. In Settings you can read and edit the raw profile: source path, frontmatter bindings, and system prompt.

![Editing a subagent profile's raw Markdown file in Settings.](../docs/public/shots/agents/r01-reviewer-profile.en.png)

Every built-in prompt field can be overridden, with a live preview of what the model will see.

![Prompt field overrides with a rendered preview.](../docs/public/shots/freedom/d02-prompt-fields.en.png)

Every way Kiki reaches a model is one row in one list, and how it authenticates is part of that row.

![The connections list, with signed-in and expired rows side by side.](../docs/public/shots/freedom/freedom-connections.en.png)

## Bring your history, meet other tools

Another tool's conversations can become Kiki sessions you keep working in, and the preview says what is kept and what is not.

![The history import preview, listing the sources and what the import would drop.](../docs/public/shots/ecosystem/ecosystem-history-import.en.png)

## Find things on the web

Web search and fetch run on named lanes you can inspect, and some work without a key.

![Search lanes with readiness states and reasons.](../docs/public/shots/extend/d06-search-lanes.en.png)

![A fetch extraction chain with visible fallbacks.](../docs/public/shots/extend/d07-fetch-chain.en.png)

Drop a screen recording into the chat, and the agent watches it with you.

![A video attachment playing inline in a session.](../docs/public/shots/daily/d08-video-attachment.en.png)
