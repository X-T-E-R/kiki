---
"@kiki/cli": patch
---

Keep persona conversations clean in the message view: failed background media tasks stay inside their own turn's activity instead of piling up under the latest reply, each spawned subagent shows as one row with its task, status and a link to open it, and failure lines keep their "view process" action readable.
