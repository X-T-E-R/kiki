---
"@kiki/gui": patch
"@kiki/session-core": patch
---

Redo the first-run onboarding wizard: three focused steps where every Next saves the current step, Test connection probes the unsaved form values through kap-server's `POST /providers:probe` (falling back to a browser-direct fetch on older servers), and auto becomes the default permission mode for new GUI installs.
