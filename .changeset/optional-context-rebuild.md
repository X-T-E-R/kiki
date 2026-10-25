---
"@kiki/cli": minor
---

Add optional context rebuilding after a fresh start, a summary, a context-replacing model switch, clearing context, and session recovery. A failure before the profile commits keeps the previous binding. A failure after that commit is partial and the next request uses the profile that committed. An unreadable difference is left off the report.
