---
"@kiki/agent-core-v2": patch
---

History search, read, and list resolve a known session from the session index when `workspace_id` is omitted, and still ask for approval outside the current workspace. Recovery no longer reads the current session's turn or repeats a session the index does not know.
