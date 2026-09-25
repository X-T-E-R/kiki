---
"@kiki/cli": patch
---

Speed up session switching by bounding journal recovery, skipping compact snapshot message folding, cancelling stale snapshots, and deferring agent panel reads.
