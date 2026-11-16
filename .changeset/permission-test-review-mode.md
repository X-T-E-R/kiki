---
"@kiki/cli": patch
---

`kiki permission test --permission-mode review` now matches the runtime: review mode approves what auto mode approves, so routine calls dry-run as `approve` instead of "requires approval"; deny and ask rules still win.
