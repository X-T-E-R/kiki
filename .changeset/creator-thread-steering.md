---
"@kiki/cli": patch
---

When the thread steering source is unset, later messages from the thread that created a thread now inherit that thread's user steering settings, not only the first instruction. Messages from other threads stay off unless configured.
