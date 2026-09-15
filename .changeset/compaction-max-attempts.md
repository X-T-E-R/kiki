---
"@kiki/cli": minor
---

Add `loop_control.compaction_max_attempts` to configure the compaction retry ceiling, and fix the retry counter so alternating failure modes can no longer exceed the ceiling.
