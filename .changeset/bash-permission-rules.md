---
"@kiki/cli": minor
---

Bash permission rules now match whole commands with `*` and `?` wildcards and check each part of a compound command separately; deny rules win over allow. Non-interactive runs accept `--permission-mode`, deny calls that would need approval, and `kiki permission test` shows which rule matches a command.
