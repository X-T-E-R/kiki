---
"@kiki/cli": patch
---

Fix concurrent `kiki -p` runs that share one `KIKI_HOME`: session locks are released when a process exits, non-interactive runs no longer wait on thread mailboxes or start cron, and lock errors name the holding process. Add `--wait-for-session <seconds>` to wait for a busy session.
