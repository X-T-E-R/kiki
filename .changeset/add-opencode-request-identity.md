---
"@kiki/cli": minor
---

Add OpenCode to the built-in request identities: `opencode_compatible` preset with the donor's dynamic `x-opencode-session` / `x-opencode-request` headers, static `x-opencode-client=cli`, `opencode/{version}` user agent, and an `opencode_cli` version track (opencode-ai 1.18.21). Endpoint and API key configuration remain the user's responsibility.
