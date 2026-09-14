---
"@kiki/cli": patch
---

Stop the agent panel from re-scanning every wire file on each concurrent request: panel metrics now share one in-flight scan per session, honor byte/record/time budgets with partial markers, cache for a full 30 s after the scan completes, cancel when the last waiter disconnects, and read only the requested child agent instead of the whole session roster.
