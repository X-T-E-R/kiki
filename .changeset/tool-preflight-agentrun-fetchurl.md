---
"@kiki/cli": patch
---

Allow `AgentRun` calls with external workspace directories to start without triggering parent-context directory-instruction write rejections, and default omitted `action` to `"run"` for `FetchURL` `source` calls.
