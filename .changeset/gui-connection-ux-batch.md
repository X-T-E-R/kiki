---
"@kiki/gui": patch
---

Fix connection and terminal-panel failure handling: fatal WebSocket errors now retry on a bounded backoff and the disconnect banner offers a manual reconnect plus a send-safety warning; browser-reserved shortcuts (Ctrl+N, Ctrl+Tab) register only in the desktop app and Ctrl+Tab no longer steals focus from the composer; hidden-tab frame buffering is bounded and flushed in chunks; a terminal tab is removed only after its server-side close succeeds.
