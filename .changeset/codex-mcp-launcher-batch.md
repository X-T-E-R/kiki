---
"@moonshot-ai/kap-server": patch
---

Harden the Codex MCP launcher: report drifted workspace binding fields individually with recovery guidance, reclaim the workspace KAP it started when the MCP process exits, add `-ListWorkspaces` / `-StopWorkspace <key>` / `-StopAllKap` management modes, and name the occupying PID and process when a workspace port is held by an unrecorded process.
