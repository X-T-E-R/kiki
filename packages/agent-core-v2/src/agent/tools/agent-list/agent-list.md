List the subagents this agent started, with their current status.

Use this tool to discover which child agents exist and how to address
them. It returns every direct child of the current agent — including
children started with `Agent` or `AgentSwarm` — and never lists
grandchildren. After a context compaction, or whenever you are unsure
which children are still around, call this tool instead of guessing an
id or name.

Each entry carries:

- `agent_id` — the generated id. Pass it to `Agent` `resume`, `AgentSend`,
  or `AgentSwarm` `resume_agent_ids`.
- `name` — present only when the child was started with the `name`
  parameter of the `Agent` tool. Use that name in place of `agent_id`
  when addressing the same child.
- `profile` — the child's agent type.
- `status` — `running` while a background task is in progress;
  `completed`, `interrupted`, or `errored` once that task has settled;
  `untracked` when no background task is tracking the child (the usual
  case for `AgentSwarm` children and for foreground `Agent` calls);
  `unknown` when a task id is recorded but cannot be resolved.
- `swarm_item` — present when the child was launched as an `AgentSwarm`
  item.

Guidelines:

- Prefer the default `include_finished=false`, which lists running
  children and children that are idle because no background task is
  tracking them. Pass `include_finished=true` only when you need
  children whose latest background task has already finished or failed.
- At most 50 entries are returned, running children first. If more
  children matched, `omitted` is the count that did not fit.
- This tool only lists children; it does not start, stop, or message
  them.
- This tool is read-only and does not change any state, so it is always
  safe to call, including in plan mode.
