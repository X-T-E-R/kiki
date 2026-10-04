---
"@kiki/cli": minor
---

Separate preset subagent permissions, role recommendations, and the switch for creating children. Profiles now use `allowed_subagents`, `deny_subagents`, `preferred_subagents`, and `can_spawn_subagents`; explicit Markdown definitions remain independent of preset name lists, and saved bindings keep their identity and model on restore.
