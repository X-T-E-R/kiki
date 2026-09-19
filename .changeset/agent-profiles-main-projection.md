---
"@kiki/cli": patch
---

Fix plain `/api/agents` responses reporting `main: false` for the default agent profile while the effective projection and engine both treat it as main.
