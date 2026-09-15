---
"@kiki/cli": patch
---

Search sync runs under byte and time budgets with per-session failure cooldowns and escalation, and store rebuilds acquire the database lock first instead of wiping a live database out from under another process.
