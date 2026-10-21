---
"@kiki/cli": patch
---

AgentSend reaches an external child when delegation is left at the harness default. An explicit `allow_kiki_subagents: false` rejects that message instead of leaving it queued. A steering response the engine does not accept leaves the saved message queued.
