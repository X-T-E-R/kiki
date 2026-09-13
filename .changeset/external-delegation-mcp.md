---
"@kiki/cli": minor
---

Add experimental external delegation over MCP: an authenticated external principal can own durable session work through a narrow MCP stdio server. Enable `KIMI_CODE_EXPERIMENTAL_EXTERNAL_DELEGATION_MCP=1` to use it; the server-side catalog is injected via the `KIKI_MCP_CONFIG_PATH`, `KIKI_MCP_AGENT_PROFILE_HOME`, and `KIKI_MCP_CONFIG_READ_ONLY` variables.
