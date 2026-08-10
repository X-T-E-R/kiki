---
"@moonshot-ai/kimi-code": minor
---

Make per-agent `model_alias` and `thinking_effort` bindings stable without the secondary-model experiment; a missing profile-pinned alias now warns and falls back to the caller's model. Pin them in an agent file's frontmatter to use them.
