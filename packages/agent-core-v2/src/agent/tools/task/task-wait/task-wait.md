Wait for background tasks to finish without ending the current turn.

Use this when you explicitly need a background task's result in the same turn (a subagent, a background bash command, or a background AskUserQuestion). The call suspends inside the current turn until the task finishes or the timeout elapses, then returns the outcome. While waiting, no LLM requests are made.

For an interactive main agent (root) whose background subagents have automatic completion notification, continue independent work or end the current turn normally when none remains. Completion starts a follow-up turn when root is idle; no user prompt is needed. Do not keep root's turn open just to await a dependency with TaskWait, TaskOutput or AgentList polling, sleep, or timed loops. Ending the turn leaves the task running and the session open; it does not mean the overall task is complete.

A subagent must handle its own outstanding dependencies before returning its final result to its parent: that result is its completion receipt. The interactive root's turn-ending strategy does not authorize an early subagent receipt.

Guidelines:

- Reserve TaskWait for a genuine same-turn synchronization requirement. If automatic notification is unavailable, choose whether to wait based on the task's actual needs; a dependency alone does not require an interactive root to stay in the same turn.
- `timeout` is required, in seconds, from 1 to 600. Choose it for the explicit synchronous wait, not as a recurring wake-up interval.
- A timeout is not an error: the result lists the tasks that are still running. Reassess the same-turn requirement rather than automatically repeating the call.
- Without `task_id`, the wait ends as soon as any background task that was running at call time finishes. Tasks started during the wait are not covered by it; their completion arrives via the usual automatic notification.
- With `task_id`, the wait ends when that task finishes. An unknown `task_id` is an error; a task that has already finished returns immediately.
- When no background tasks are running, TaskWait returns immediately without waiting.
- When the wait ends because a task finished, the result also lists other tasks that finished during the wait window, so failures surface with context.
- Waiting has no side effects on the waited tasks: TaskWait never stops a task, and interrupting the wait (for example, a user interruption) leaves every task running.
- A finished task's result is delivered exactly once: tasks reported by TaskWait do not also produce an automatic completion notification.
- You can only wait for background tasks started by this agent; task IDs belonging to other agents are unknown here.
