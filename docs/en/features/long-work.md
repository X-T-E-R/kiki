---
title: Work that runs long
---

# Work that runs long

Some work does not fit in one turn. It spans a morning, or a week, or it depends on a schedule. This page covers the parts of Kiki built for that: goals that carry across turns, the queue for what you type while the agent is busy, scheduled tasks and the task board for work that outlives a session, the context window that decides what happens when a conversation fills up, and memory for the facts that should survive all of it.

## Goals keep the target in view

A normal prompt says what to do next; a goal says what must become true. Start one with `/goal` and the agent keeps working toward it across turns, checking the goal's own states after each turn — complete, blocked, paused, or still active. You can edit, pause, and cancel the goal as it runs.

Goals work best when the objective names the result and the evidence that proves it — including when the first clue turns out not to be the root cause, because the goal describes the outcome and the agent adapts on the way. They are worth avoiding for broad topics with no finish line, for work already known to be impossible, and for objectives too ambiguous to judge complete. See [Using goals](/en/guides/goals) for when to use them and how to manage the lifecycle.

## The queue holds what you type while it works

While the agent is busy, a new message joins a queue above the input box instead of interrupting. Each queued message carries its own send timing: **when idle** (as soon as the agent finishes its turn), **after subagents** (once the running subagents finish), or **after tasks** (once all background tasks finish). You can change the timing, edit the text, reorder, or send one right away from its row.

Hovering the send button (or focusing it and pressing `↓`) opens the same choices, plus the option to deliver the message into the current turn at the next safe step boundary — the same as `Ctrl-Enter`. The timing choice applies only to that message and does not change the default. After a restart, restored queued messages wait for confirmation: **Send now** sends one, **Resume queue** releases them all.

The full behavior is described in [Interface overview](/en/guides/interface#input-box).

![An active goal with two queued messages, each with its own send timing.](/shots/long-work/long-work-goal-queue.en.png)

## Work that outlives the session

Two features carry work beyond a single conversation. Both are listed globally rather than per-session, but what they hold is scoped differently.

**Scheduled tasks.** The agent can schedule a prompt to fire at a future time, either once or on a cron expression in your local timezone, and a global panel lists every schedule. A schedule is ticked by a Kiki that has its session open — the interactive daemon or server, or a print run for the sessions that run already has open. It does not scan the rest of the home or wake a closed session, so a schedule only fires while some Kiki is holding that session. Recurring tasks are shifted forward by deterministic jitter so everyone does not fire on the hour, and one that missed fire times fires once with the missed count. Schedules are bound to their session and do not carry into a brand-new session, and a session holds at most 50 active ones. See [Scheduled tasks](/en/reference/tools#scheduled-tasks).

**The task board.** Each workspace has a board where requirements are cards, and each card links to the sessions working on it. Cards are persistent requirements, not agent runs — reading a card does not change it, and the board does not update from todo lists. The main agent reads and writes the board itself with `BoardRead` and `BoardWrite`, under the normal approval rules. Open it from the fixed button at the bottom of the main agent's right panel. See [Task board](/en/guides/sessions#task-board).

## The context window: when it fills up

As a conversation grows, Kiki compresses the history when the context approaches the window limit. You decide where that point is, and what happens when it is reached.

The context meter sits below the composer. Opening it gives you a detail card with two parts: the **context window** track (used, compaction point, reserved, and the available ceiling, where you can set the compaction point directly as a token count or a percentage), and **this session — cumulative**, the input, output, cache-read, and cache-write tokens and the cost so far. In the terminal, `/autocompact` shows or changes the same compaction point.

The card also holds the **renewal strategy** — a three-way choice for what happens at the compaction point:

- **Summarize** (the default) — compress the history into a summary and keep going.
- **Fresh** — do not carry the history. Restart from the agent's working notes alone.
- **Auto** — let the agent decide per run.

The source label next to it says which layer the current value came from (session, profile, global, or inherited) and doubles as the control that saves it more broadly or resets it. Subagents and external executors read this value but do not set it.

**Fresh has real conditions.** Restarting from notes throws away the conversation, so Kiki only does it when nothing would be lost — the history is available, the working notes exist and have been reviewed in the current window, and the restart will fit. When something arrived after the last handoff, or a result cannot be recovered from notes, Kiki compacts instead of clearing. Treat Fresh as "restart from notes when that is safe", not "clear the history at any moment".

For the manual side, `/compact` compresses on demand and accepts a hint about what to prioritize. See [Context compression](/en/guides/sessions#context-compression) and [`/autocompact`](/en/reference/slash-commands).

![The context meter detail card, with the context window track and Fresh selected as the renewal strategy.](/shots/long-work/long-work-context-fresh.en.png)

## Memory keeps the facts across sessions

A session ends. Memory is what does not. The agent saves user preferences, feedback, verified project facts, and reference pointers, and finds them again later. On the `/memory` page you choose which body of memory you are looking at — **Global**, one **Workspace**, or one **Persona**. Persona-specific entries are isolated from other personas; by default a persona can also read the shared global and workspace memory.

Memory is on by default, and the `/memory` page in the sidebar is its permanent home either way — with memory off it is the turn-on guide, with memory on it is the management console. You can search entries, filter by type, edit, pin, and delete them, and every change can be undone one operation at a time — including a delete, which is why the confirmation says so rather than claiming anything is permanent. When memory approval is set to `review`, proposed changes wait in an Inbox tab for you to accept or discard instead of taking effect on their own.

Agents write memory with `MemoryWrite` and read it with `MemorySearch` and `MemoryRead`. See [Memory](/en/guides/memory) for the full page, the review inbox, and how to turn memory off.

![The memory page in the persona scope, listing entries across the global, workspace, and persona bodies, with an entry open and its change history.](/shots/long-work/long-work-memory-scopes.en.png)

## Next steps

- [Memory](/en/guides/memory) — the three scopes, the review inbox, and undoable history
- [Using goals](/en/guides/goals) — writing and managing goals
- [Task board](/en/guides/sessions#task-board) — persistent requirement cards per workspace
- [The daily driver](/en/features/daily) — the window you use while all of this runs
