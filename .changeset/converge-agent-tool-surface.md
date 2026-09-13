---
"@kiki/agent-core-v2": minor
"@kiki/cli": minor
---

**Breaking (v2 tool surface):** converge the agent tools onto `AgentRun` / `AgentSwarm` / `AgentList` / `AgentSend` and the `Task*` family.

- `Agent` is now `AgentRun`. Its parameters are unified with the rest of the family: `subagent_type` → `profile`, `thinking_effort` → `effort`, `run_in_background` → `background`. `resume` and `description` keep their names and meanings.
- `WaitFor` is now `TaskWait`, down to its identifiers: the experiment flag id is `task_wait` and its environment variable is `KIMI_CODE_EXPERIMENTAL_TASK_WAIT`. The old spellings are gone rather than aliased, so an existing `KIMI_CODE_EXPERIMENTAL_WAIT_FOR` setting no longer has any effect.
- `AgentSwarm` keeps its name; `subagent_type` → `profile` and `thinking_effort` → `effort`. It still takes `description` for the swarm as a whole.
- The six-tool named-agent collaboration adapter (`spawn_agent`, `list_agents`, `wait_agent`, `followup_task`, `interrupt_agent`, `send_message`) and its `agent-collaboration` experiment flag are removed from v2. `AgentRun(name=..., background=true)`, `AgentRun(resume=...)`, `AgentList`, `AgentSend`, `TaskWait`, and `TaskStop` cover the same ground without a second parallel entry point. The durable mailbox and the name registry behind them are unchanged.
- `AgentList` and `AgentSend` are auto-approved. Neither grants authority the caller lacks: `AgentRun` is already auto-approved and can drive any direct child, and `AgentList` only reads the caller's own children.

The TUI emits the new names only, and still recognizes `Agent` when replaying a session recorded before the rename. `WaitFor` is not recognized any more.
