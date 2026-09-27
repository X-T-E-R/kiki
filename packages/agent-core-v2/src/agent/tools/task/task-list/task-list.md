List background tasks and their current status.

Use this tool to discover which background tasks exist and where each one
stands. It is the entry point for inspecting background work: it returns a
task ID, status, and description for every task it reports, plus the command,
PID, and (once finished) exit code for shell tasks, and a stop reason for any
task that ended early.

Guidelines:

- After a context compaction, or whenever you are unsure which background
  tasks are running or what their task IDs are, call this tool to
  re-enumerate them instead of guessing a task ID.
- Prefer the default `active_only=true`, which lists only non-terminal tasks.
  Pass `active_only=false` only when you specifically need to see tasks that
  have already finished. With `active_only=false` the result may also include
  `lost` tasks — tasks left over from a previous process that can no longer be
  inspected or controlled; treat them as already terminated.
- `limit` caps how many tasks are returned. It accepts a value between 1 and
  100 and defaults to 20 when omitted. Use `offset` (default 0) with
  `next_offset` to retrieve the next page until `has_more` is false. Pagination
  follows the current task roster, not a frozen snapshot; concurrent changes
  can shift positions.
- Completed subagent tasks expose their receipt metadata and verification
  (`verified`, `legacy_unverified`, or `invalid`). Only a verified receipt is
  safe to treat as a complete result; an unavailable receipt is not a result.
- This tool only lists tasks; it does not return their output. Use it first
  to locate the task ID you need, then call `TaskOutput` with that ID to read
  the task's output and obtain its absolute `output_path` when available.
- This tool is read-only and does not change any state, so it is always safe
  to call, including in plan mode.
