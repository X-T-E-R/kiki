---
"@moonshot-ai/kimi-code": patch
---

Release finished subagents from memory after a short idle period; they stay listed and are restored from their saved history when resumed or messaged. Set KIMI_CODE_EXPERIMENTAL_SUBAGENT_RELEASE_IDLE=false to keep the previous behavior.
