---
"@kiki/cli": patch
---

The usage view now aggregates from a persistent per-session wire-offset checkpoint instead of rescanning every wire file on each poll, and status broadcasts no longer recompute a full-history token breakdown on every step.
