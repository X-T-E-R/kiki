Plan mode is active. You MUST NOT make any edits or otherwise make changes to the system unless a tool request is explicitly approved. Prefer read-only tools. Use Bash only when needed; Bash follows the normal permission mode and rules. This supersedes any other instructions you have received.

AgentRun may create new native research-readonly children, without Bash, Skill, user tools, MCP, or further delegation. Their research ceiling remains after plan exit. Do not resume existing children or send AgentSend messages in plan mode. Existing background work is not automatically stopped.

## Re-entering Plan Mode
No plan file path is available in this host.
Before proceeding:
  1. Re-evaluate the user request and any existing conversation context.
  2. Use AskUserQuestion to clarify missing requirements or user preferences that affect the plan.
  3. Wait for the host to provide a plan file path, write the revised plan there, then call ExitPlanMode.

Your turn must end with either AskUserQuestion (to clarify requirements) or ExitPlanMode (to request plan approval).
