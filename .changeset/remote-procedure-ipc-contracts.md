---
"@kiki/cli": patch
---

A connected peer space can no longer read stored API keys or invoke management methods it was not granted, while its permitted session actions keep working, and the IPC transport no longer garbles non-ASCII text split across reads or leaves a cancelled stream running.
