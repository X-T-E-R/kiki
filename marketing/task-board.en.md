# Spotlight: the task board — work you can point at

*A feature spotlight for Kiki. These pages are promotional companions to the README; they describe shipped behavior.*

Chat history is where work gets discussed. It's a terrible place for work to *live* — scroll back far enough and every decision dissolves into the transcript. Kiki gives each workspace a **task board**: a kanban panel in the desktop UI where requirements and tasks are tracked as first-class objects, not messages.

![The workspace task board: requirement cards across status columns, each linked to the session working on it.](shots/r04-task-board.en.light.png)

*Example scene rendered by the real Kiki UI.*

## Tasks linked to sessions

Every card on the board can link to the session working on it. The board is not a passive to-do list the agent reads once — it's shared state between you and the fleet. You can see not just *what* is pending, but *who* is on it, and jump straight into that session to steer.

## Why a board at all?

Because multi-agent work multiplies the bookkeeping problem. One agent on one task, you can hold in your head. A main agent with three subagents, a background job, and a cron-scheduled follow-up — that's when "wait, what was it doing again?" starts costing you sessions. The board is the answer: an always-visible, per-workspace inventory of commitments that survives compaction, restarts, and context windows.

Combined with [goal mode](https://x-t-e-r.github.io/kiki/en/) (objectives that persist across turns), cron prompts, and the live agent panel, the board completes the loop: **decide** the work, **watch** the work, **come back** to the work — in three different places, each built for its moment.
