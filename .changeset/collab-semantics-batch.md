---
"@moonshot-ai/kimi-code": patch
---

Restore subagent model inheritance on resume/retry: a subagent spawned with an inherited binding now follows a mid-session `/model` switch on the parent, while an explicitly bound subagent stays on its spawn-time model. Named collaboration agents also keep their delegation and fork provenance when re-materialized after a server restart.
