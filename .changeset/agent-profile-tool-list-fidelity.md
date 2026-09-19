---
"@kiki/cli": patch
---

Editing an agent profile no longer turns an empty allowed-tools list into an unrestricted profile. The field now keeps "not set", "deny every tool" and "named list" apart, and a field you did not touch is left as it was.
