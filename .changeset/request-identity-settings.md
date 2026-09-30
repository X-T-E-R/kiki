---
"@kiki/cli": minor
---

Settings gains a Request identity section: pick which client each request presents itself as (Codex CLI, Claude Code, Grok Build, Kimi Code, or none), see the exact User-Agent, headers and body fields it sends, duplicate a built-in identity to edit those values directly, see which providers and models use each identity, and inspect what the latest requests actually sent. Client versions follow the npm registry, the installed CLI or an https manifest; a check only stages a new version, which you apply, pin, roll back or reset explicitly.
