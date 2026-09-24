---
"@kiki/cli": patch
---

Clear stalled resumed subagents from the agent rail when their scope is disposed or their refresh lease expires, even if no other session events arrive. Keep agent-rail updates when multiple children resume in quick succession.
