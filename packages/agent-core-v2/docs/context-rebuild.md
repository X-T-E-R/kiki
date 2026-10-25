# Context rebuild

A live conversation keeps the Recipe, prompts, skills, AGENTS instructions, enabled plugin tools, MCP catalog, and context injections it started with. Rebuilding re-reads those sources into the same agent. It does not start a new conversation, replay tool calls, or enable every installed plugin.

The switch is off by default and belongs to one agent. Turning it on does not rebuild immediately, and it does not change child agents. Each agent keeps its own switch.

## When it runs

Manual refresh runs only for the main agent, and only while that agent is idle.

With the switch on, the same rebuild runs once at these completed boundaries, before the next model request:

- A fresh start finishes. That is a committed relay compaction. The report says “After a fresh start”.
- A summary finishes. That is a committed summarize compaction. The report says “After a summary”.
- A model switch finishes in fresh mode and replaces the context window. The report says “After a fresh context window”. The model chosen by that switch stays.
- A model switch finishes in compact mode and replaces the context window with its summary. The report says “After a compacted context window”. The model chosen by that switch stays.
- Context is cleared while the agent is idle and no compaction is running. The report says “After clearing the context”. An empty clear does nothing. A clear during a running turn or a compaction does not rebuild, so a model request already in progress is not swapped.
- The agent’s saved session is restored, before a recovered prompt is sent. The report says “After session recovery”. Replaying an older switch or clear during that restore does not rebuild a second time.

A cancelled or failed compaction does not rebuild. A model switch that fails or keeps the current context (`direct`) does not rebuild. Resetting the context strategy only changes what the next compaction will do. Undo, an ordinary message, and each step do not rebuild. Switching execution engine is not one of these boundaries, and a rebuild does not change the selected model or engine.

The switch does not scan source directories on ordinary messages or steps. A committed compaction whose strategy was not recorded still rebuilds and reports “After compaction”.

## What stays

The session, agent, history, draft, todos, selected model, effort, and permission mode stay. Explicit tool denies and the current tool admission stay unless a finished source stage itself changes that admission. External calls and tools are not replayed.

## External executors

A non-native executor can refresh the host profile, prompt fields, skills, instructions, and MCP catalog. It does not restart the running executor session, push plugin session-start reminders, or apply native context injections. Those three boundaries are reported as not refreshed.

## Failure

A failed rebuild leaves the previous binding in place and records the error. There is no background retry. A later fresh start, summary, context-replacing model switch, context clear, session recovery, or manual refresh can try again. A committed compaction or model switch stays committed when the rebuild fails.

If an earlier stage finishes and a later stage throws, the report is partial. Finished sources are what the next request reads. Unfinished sources keep the previous binding. A partial report is not a full success. A difference that cannot be read is left off the report; it is not recorded as every source unchanged. The selected model, effort, and explicit tool denies stay, and a compaction that already committed stays committed.

The prompt drawer shows one switch. A running rebuild and a finished rebuild use a short status or a small icon on that row. A failure shows the error on one line, with retry. The source-by-source result, including the boundary that ran and anything not refreshed, stays inside that prompt diagnostic and opens on demand. The full system prompt is not part of the notice.
