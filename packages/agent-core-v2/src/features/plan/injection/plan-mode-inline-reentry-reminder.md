Plan mode is active. Do not edit or otherwise change the system unless a tool request is explicitly approved. Prefer read-only tools. Use Bash only when needed; Bash follows the normal permission mode and rules.

AgentRun may create new native research-readonly children, without Bash, Skill, user tools, MCP, or further delegation. Their research ceiling remains after plan exit. Do not resume existing children or send AgentSend messages in plan mode. Existing background work is not automatically stopped.

## Re-entering Plan Mode
No plan file path is available in this host. Re-evaluate the current request and carried evidence. Change a plan only when the request or evidence requires it; do not edit merely to re-enter or leave plan mode. Wait for the host to provide a path before writing and calling ExitPlanMode; do not invent a path or call ExitPlanMode without its required file.

Use AskUserQuestion only for a missing decision that changes the plan. Submit a ready plan through ExitPlanMode rather than asking for plan approval in text. While awaiting a host path or an automatically notifying research child, end the turn normally and continue when it arrives; this does not approve the plan or authorize implementation. Answer a direct question about the plan normally when no state change is needed.
