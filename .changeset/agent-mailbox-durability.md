---
"@kiki/cli": minor
---

Queued agent-to-agent messages (AgentSend/AgentNotify) survive restarts, and messages whose target agent no longer exists or whose session was deleted are dropped and recorded as mailbox activity.
