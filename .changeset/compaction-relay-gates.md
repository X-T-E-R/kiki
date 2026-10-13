---
"@kiki/cli": patch
---

Automatic context compaction keeps the zero-model handoff, including removed images, when the rebuilt context still fits, retries that result when saving it fails, and stops the retry when that save is cancelled.
