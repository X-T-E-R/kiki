Use this tool proactively when you're about to start a non-trivial implementation task.
Getting user sign-off on your approach via ExitPlanMode before writing code prevents wasted effort.

Use it when ANY of these conditions apply:

1. New Feature Implementation - e.g. "Add a caching layer to the API"
2. Multiple Valid Approaches - e.g. "Optimize database queries" (indexing vs rewrite vs caching)
3. Code Modifications - e.g. "Refactor auth module to support OAuth"
4. Architectural Decisions - e.g. "Add WebSocket support"
5. Multi-File Changes - involves more than 2-3 files
6. Unclear Requirements - need exploration to understand scope
7. User Preferences Matter - if user input would materially change the implementation approach, use EnterPlanMode to structure the decision

Permission mode notes:
- EnterPlanMode enters plan mode automatically without an approval prompt in all permission modes.
- In yolo and manual modes, ExitPlanMode still presents the plan to the user for approval.
- In auto permission mode, do not use AskUserQuestion; make the best decision from available context.
- In auto permission mode, ExitPlanMode exits plan mode without asking the user.
- Use EnterPlanMode only when planning itself adds value.

When NOT to use:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- User gave very specific, detailed instructions
- Pure research/exploration tasks

Once you are in plan mode, a reminder walks you through the workflow (explore → design → write the plan file → `ExitPlanMode`). You may create new native research children with `AgentRun`, including `profile="explore"`. Their capabilities are capped at builtin Read, ReadMediaFile, Glob, Grep, WebSearch, and FetchURL, intersected with existing tool policies. They do not inherit user tools, run executable prompt prefixes, use external executors, or gain Bash, Skill, MCP, or further delegation. The ceiling persists after plan exit and on resume. In plan mode, AgentRun with a nonempty resume and AgentSend remain blocked. The parent's Bash still follows its normal permission rules; existing background tasks are not automatically stopped. This is not a system sandbox.
