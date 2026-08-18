---
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kap-server": minor
"@kiki/gui": minor
---

Add per-provider `request_attribution` (`codex` / `kimi` / `kiki` / `none`) and `request_originator` settings choosing which session/agent lineage and originator headers are sent with every request; unconfigured providers fall back to their family default. Pick them in the provider editor's Request attribution dropdown and Originator field.
