---
"@moonshot-ai/kimi-code": patch
---

Let new subagents select configured model aliases and thinking effort through the declarative subagent model pool. Configure `[secondary_model]` with `default_model`, named `[secondary_model.models]` entries, or `force` to pin subagent defaults; an inherited spawn follows the caller's mid-session `/model` switch while an explicit or pool-pinned binding stays frozen.
