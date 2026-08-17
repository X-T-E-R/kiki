---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/agent-core": patch
---

Resolve unambiguous bare model names to their configured `provider/model` entries across default, secondary, CLI, and agent-profile model references, while requiring full model ids when a bare name is ambiguous.
