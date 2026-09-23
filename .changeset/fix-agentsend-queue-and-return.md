---
"@kiki/cli": patch
---

Make AgentSend return once the message is durably queued instead of blocking the caller until the child acknowledges delivery or finishes its current run.
