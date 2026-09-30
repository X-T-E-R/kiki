---
"@kiki/cli": patch
---

Send now no longer makes the message vanish while it waits for the running turn: it stays in place, marked as waiting to join, and settles into an ordinary message once the agent reads it after its current step. Subagents get the same Send now, with the same timing. If it cannot join, the text goes back to the composer with the reason.
