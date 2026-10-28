---
"@kiki/agent-core-v2": patch
---

Windows background commands whose helper lost its control channel during release now finish instead of staying stuck as unconfirmed cleanup that TaskStop cannot clear.
