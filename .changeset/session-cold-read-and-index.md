---
"@kiki/agent-core-v2": patch
"@kiki/kap-server": patch
"@kiki/gui": patch
---

Serve a published session index immediately and keep an older scan from replacing a newer generation. Cold message reads page without restoring the session, and session list walks stop when the client disconnects.
