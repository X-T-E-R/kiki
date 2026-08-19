---
"@kiki/gui": patch
---

Close the message loop in the transcript: hover row actions let you copy, edit (resend), regenerate, or fork from any settled message via the new `messages/{mid}:edit|regenerate` routes and the `:fork` truncation pair, with optimistic-concurrency cursors (40936/40937 surfaced), history-rewrite resync on `event.session.history_rewritten`/`resync_required(history_rewritten)`, and orphaned subagent cards dimmed instead of dropped. Long user messages collapse behind a fade with a show-more toggle, and a floor navigation rail on the transcript edge jumps between user-message floors with the active floor highlighted.
