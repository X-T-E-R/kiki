---
"@kiki/agent-core-v2": minor
"@kiki/kap-server": minor
"@kiki/protocol": minor
---

Add server-side message edit/resend, final-response regeneration, and message-boundary session forks with required session cursors. History rewrites are serialized against prompt and undo admission, publish a durable `event.session.history_rewritten` before the replacement turn starts, and issue `resync_required(history_rewritten)` to subscribed clients.

This release intentionally provides process-local linearization rather than crash-atomic history/event transactions. Removed search-index documents are not deleted incrementally yet, so stale suffix hits may remain until the index is rebuilt; removed blobs and attachments are retained.
