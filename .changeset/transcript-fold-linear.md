---
"@kiki/cli": patch
---

Opening long conversations is dramatically faster: transcript rebuild now uses indexed lookups and a mutable replay draft instead of scanning and copying the whole timeline for every event, cutting the cost from quadratic to near-linear (45k turns: ~149 s → under 1 s in benchmarks).
