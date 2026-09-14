---
"@kiki/cli": patch
---

Reject prompt field overrides that reference unknown variables or field ids at config write time instead of persisting them, matching the validation the removed prompt keys had.
