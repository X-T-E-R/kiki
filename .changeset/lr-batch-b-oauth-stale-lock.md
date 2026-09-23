---
"@kiki/oauth": patch
---

The OAuth cross-process refresh lock raises `proper-lockfile`'s stale window from 5s to 60s, longer than the 30s HTTP refresh timeout, so a slow or paused holder can no longer be stolen mid-flight and have a 401 tombstone overwrite a peer's freshly rotated token (W1B-08).
