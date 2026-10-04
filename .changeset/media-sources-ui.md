---
"@kiki/gui": minor
"@kiki/session-core": patch
---

Add a Media sources view under Capabilities → Plugins: one searchable list of every installed image, video and speech provider with its live status, a settings form per source that can use either the package's own key or a connection you already have, per-modality defaults, and the current session's recent media jobs with their files. A job whose submission could not be confirmed is reported as still possibly charging, and a stopped job says that only the local wait ended.
