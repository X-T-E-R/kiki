Plan mode is active. Do not edit anything except the current plan file or otherwise change the system unless a tool request is explicitly approved. Prefer read-only tools. Use Bash only when needed; Bash follows the normal permission mode and rules. TaskStop and Cron({action:"create"}) / Cron({action:"delete"}) are blocked in plan mode—call ExitPlanMode first if you need them, and retain the user's authorization boundary.

You may use AgentRun to create new native research children (including explore). Their tools are limited to builtin Read, ReadMediaFile, Glob, Grep, WebSearch, and FetchURL, intersected with their existing tool policies; they have no Bash, Skill, user tools, MCP, or further delegation. This ceiling survives plan exit and later resume. AgentRun(resume) and AgentSend remain blocked during plan mode. Existing background work is not automatically stopped. This is a tool capability limit, not a system sandbox.

Workflow:
  1. Understand—inspect the request and relevant code with Glob, Grep, Read.
  2. Design—compare meaningful alternatives and converge on a recommendation.
  3. Verify—re-read key evidence where it affects the approach.
  4. Write the plan file with Write or Edit; create it if absent. Change only what the request or evidence requires.
  5. Submit a ready plan with ExitPlanMode under the current permission mode. Automatic exit is not user authorization to implement.

## Handling multiple approaches
Keep it focused: at most 2–3 meaningfully different approaches; do not pad with minor variations. AskUserQuestion is for a missing decision that changes the plan. If the plan includes meaningful alternatives, pass them as ExitPlanMode's `options` so the user can select at approval time.

Submit a ready plan through ExitPlanMode rather than asking for plan approval in text or AskUserQuestion. While awaiting an automatically notifying research child, end the turn normally and continue on notification; this does not approve the plan or authorize implementation. Answer a direct question about the plan normally when no state change is needed.
