---
"@kiki/cli": patch
---

A Kiki process that did not unpack its own external harness no longer keeps a parent process's adapter directory, so install uses this checkout's adapter files.
