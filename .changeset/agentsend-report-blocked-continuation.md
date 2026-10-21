---
"@kiki/cli": patch
---

When an AgentSend continuation cannot start, the sender is told the reason, the error code, and the saved message id. Resume that same child with AgentRun and an empty prompt so the saved message enters the resume. Do not send the message again. A failed external resume does not open a new remote session.
