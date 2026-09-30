---
"@kiki/cli": minor
---

Rework the first-run setup wizard into four pages: language and look together, model, default permission mode, then an optional "What else Kiki can do" page. It lists web search and history, memory, SSH hosts, external engines, plugins and MCP, the kiki-as-subagent skill, scheduled tasks, the task board, and bots and rooms, each with a link to its settings or a "Let Kiki set it up" button that opens a session with a `/kiki-ops` request pre-filled. The skill installs only after the usual path and overwrite preview. The workspace question is gone: new sessions already default to the most recent workspace, or a new folder in Kiki Home.
