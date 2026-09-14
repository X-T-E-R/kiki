---
"@kiki/cli": patch
---

Profile pickers no longer show a builtin-only list for up to a minute on a cold directory: the server now waits for every profile source before answering, and the GUI briefly retries instead of caching a partial catalog.
