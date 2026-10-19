---
"@kiki/cli": patch
---

Opening the same small unchanged cold session again reuses the history already read, and a larger history is read again instead of being kept.
