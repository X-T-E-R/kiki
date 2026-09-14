---
"@kiki/cli": patch
---

Session index maintenance no longer re-reads session wire files every minute: reconciliation is incremental over file fingerprints, and point reads during index rebuilds stay scoped to the known workspace instead of scanning every session.
