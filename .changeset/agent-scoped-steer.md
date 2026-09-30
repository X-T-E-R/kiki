---
"@kiki/cli": minor
---

Steer and abort a prompt queued on a native child agent through `POST /api/sessions/{id}/prompts/{prompt}:steer?agent_id=<agent>` (and `:abort`); other prompt actions stay main-only.
