---
"@kiki/cli": patch
---

Return from MCP delegation waits at progress boundaries within 45 seconds instead of holding until completion; a `timed_out` result now carries a snapshot and a next_step telling the client to call wait again.
