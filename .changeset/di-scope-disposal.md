---
"@kiki/cli": patch
---

Release disposed agent scopes from the dependency graph so repeated subagent lifecycles no longer grow memory, and skip stray non-directory files when scanning the session index instead of degrading it.
