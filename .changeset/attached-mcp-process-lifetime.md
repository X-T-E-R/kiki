---
"@kiki/cli": patch
---

Release attached MCP processes when the caller exits, and start them without loading the full application. Cleanup that throws, rejects, or exceeds its time limit is reported and does not exit successfully.
