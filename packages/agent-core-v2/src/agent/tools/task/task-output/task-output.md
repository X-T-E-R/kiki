Retrieve a snapshot of a running or completed background task.

Use this after `Bash(run_in_background=true)`, `AgentRun(background=true)`, or `AskUserQuestion(background=true)` to check progress, or to read the output of a task that has already completed.

Guidelines:
- Prefer automatic completion notifications. Use TaskOutput for a specific progress check you will act on, or to read completed output when needed.
- This tool is always non-blocking: it returns the current status/output snapshot immediately and never waits for the task to finish.
- For an interactive main agent (root) whose background subagents have automatic completion notification, continue independent work or end the current turn normally when none remains. Completion starts a follow-up turn when root is idle. Do not poll TaskOutput or switch to foreground execution merely because the next step depends on the result. A subagent still handles its own dependencies before returning its final result to its parent.
- For background shell commands or environments without automatic continuation, use this snapshot when the task's actual needs call for it. Use TaskWait for a genuine same-turn synchronization requirement, not repeated TaskOutput calls to keep the turn open.
- This tool returns structured task metadata, a fixed-size output preview, and an output_path for the full log.
- For a terminal task, the metadata also explains why it ended. A shell command that runs to completion reports `status: completed` on a zero exit, or `status: failed` with its non-zero `exit_code` — judge that failure from the `exit_code`, because a plain command failure carries no `stop_reason` and no `terminal_reason`. `terminal_reason` is a categorical label emitted only when the end is not an ordinary exit: `timed_out` when the deadline aborted it, `stopped` when it was explicitly stopped, or `failed` when it errored without producing an exit code; the `stopped` and `failed` cases also carry a human-readable `stop_reason`. A task that finished on its own with a clean exit carries neither `stop_reason` nor `terminal_reason`.
- The full, never-truncated log is always available at output_path; use the `Read` tool with that path to page through it, whether or not the preview was truncated.
- This tool works with the generic background task system and should remain the primary read path for future task types, not just bash.
