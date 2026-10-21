---
"@kiki/cli": patch
---

When an AgentSend continuation cannot start, the sender is told the reason, the error code, and the saved message id. Retrying that call reuses the message. A failed external resume does not open a new remote session.
