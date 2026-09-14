---
"@kiki/cli": minor
---

Prompt fields: system prompt sections, tool descriptions and guidance, and delegation notices are now registry-backed fields that can be overridden per key from config.toml, agent profile frontmatter, or external TOML files, with global, per-model, per-profile, and per-profile-per-model scopes. The legacy `[prompt] shared` and `[prompt] tools` keys and the delegation notice file-path settings were removed; move them to `[prompt.overrides].fields` as `system.shared`, `tool.<name>.guidance`, and `delegation.sub.notice` / `delegation.independent.notice`.
