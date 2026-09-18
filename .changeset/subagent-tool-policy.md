---
"@kiki/cli": minor
---

Subagents can no longer call `AskUserQuestion` and instead receive the `AgentNotify` tool to message their parent agent, and agent profiles gain a `disabled-tool-groups` field to turn off built-in tool groups.
