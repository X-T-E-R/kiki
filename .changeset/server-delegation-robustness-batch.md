---
"@kiki/kap-server": patch
"@kiki/agent-core-v2": patch
"@kiki/protocol": patch
"@kiki/klient": patch
"@kiki/cli": patch
---

Harden the external-delegation and server integration path: add an application-level WebSocket heartbeat (server_hello advertises `heartbeat_ms` and pings clients), classify external delegation failures into a stable taxonomy instead of blanket redaction, surface MCP tool input validation as `invalid_input` with a `task_name` rule hint, fail open on misconfigured external-delegation authorities instead of refusing to boot, make the meta `thread_communication` capability optional for older servers, restore the 30s IPC default call timeout while widening `threads.wait`, and report specific `KIKI_MCP_*` configuration errors.
