---
"@kiki/cli": patch
---

Fix plugin panel calls that could hang forever; they now stop after 60 seconds or when the panel disconnects.
