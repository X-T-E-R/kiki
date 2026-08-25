---
"@moonshot-ai/agent-core-v2": minor
"kimi-code": minor
---

**Breaking (v2 tool surface):** converge the agent tools onto `AgentRun` / `AgentSwarm` / `AgentList` / `AgentSend` and the `Task*` family.

- `Agent` is now `AgentRun`, and its parameters are unified with the rest of the family: `subagent_type` → `profile`, `thinking_effort` → `effort`, `run_in_background` → `background`, `resume` → `agent`. The `description` parameter is gone — the UI label is derived from `name`, falling back to the opening line of `prompt`.
- `WaitFor` is now `TaskWait`.
- `AgentSwarm` keeps its name; `subagent_type` → `profile` and `thinking_effort` → `effort`. It still takes `description` for the swarm as a whole.
- The six-tool named-agent collaboration adapter (`spawn_agent`, `list_agents`, `wait_agent`, `followup_task`, `interrupt_agent`, `send_message`) and its `agent-collaboration` experiment flag are removed from v2. `AgentRun(name=..., background=true)`, `AgentRun(agent=...)`, `AgentList`, `AgentSend`, `TaskWait`, and `TaskStop` cover the same ground without a second parallel entry point. The durable mailbox and the name registry behind them are unchanged.

The legacy v1 engine keeps all of its old tool names and its `KIMI_CODE_EXPERIMENTAL_AGENT_COLLABORATION` flag. The TUI recognizes both spellings so sessions recorded under the old names still render.
