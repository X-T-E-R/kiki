# Context rebuild

A live conversation keeps the Recipe, prompts, skills, AGENTS instructions, enabled plugin tools, MCP catalog, and context injections it started with. Rebuilding re-reads those sources into the same agent. It does not start a new conversation, replay tool calls, or enable every installed plugin.

The switch is off by default and belongs to one agent. Turning it on does not rebuild immediately, and it does not change child agents. Each agent keeps its own switch.

## When it runs

Manual refresh runs only for the main agent, and only while that agent is idle.

With the switch on, the same rebuild also runs once after a compaction result is durable, before the next model request, and once after that agent's saved session is restored, before a recovered prompt is sent. A cancelled or failed compaction does not rebuild. A model request that is already in progress is not swapped.

The switch does not scan source directories on ordinary messages or steps.

## What stays

The session, agent, history, draft, todos, selected model, effort, and permission mode stay. Explicit tool denies and the current tool admission stay unless a finished source stage itself changes that admission. External calls and tools are not replayed.

## External executors

A non-native executor can refresh the host profile, prompt fields, skills, instructions, and MCP catalog. It does not restart the running executor session, push plugin session-start reminders, or apply native context injections. Those three boundaries are reported as not refreshed.

## Failure

A failed rebuild leaves the previous binding in place and records the error. There is no background retry. A later compaction, recovery, or manual refresh can try again.

If an earlier stage finishes and a later stage throws, the report is partial. Finished sources are what the next request reads. Unfinished sources keep the previous binding. A partial report is not a full success.

The prompt drawer shows the last time, which sources updated or stayed unchanged, which did not finish, and the unsupported boundaries. The next request uses that report. The full system prompt is not part of the notice.
