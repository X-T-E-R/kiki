Launch a subagent to handle a task. The subagent runs as a same-process loop instance with its own context and wire file. Delegating also keeps the bulk of intermediate file contents out of your own context — you get a conclusion back instead of a pile of dumps.

Writing the prompt:
- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.
- Lookups (read this file, run that test): put the exact path or command in the prompt. The subagent should not have to search for things you already know.
- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.
- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.

Usage notes:
- `description` is a required short task description (3-5 words) for UI display.
- When the task continues earlier work a subagent already did, pass that child's `name` or agent id as `resume` instead of spawning a fresh instance — the continued agent keeps its prior context.
- Pass `name` when you expect to come back to the same child: a stable name is easier to carry across turns than a generated id, and `AgentList` and `AgentSend` accept it too.
- For a new role, `profile_file` loads an explicit Agent Markdown file from an absolute or workspace-relative path. It is a role definition, not a shared prompt template, and is mutually exclusive with `profile`, `route`, and `resume`.
- When using `resume`, omit `profile`, `profile_file`, and `route`. Omit `effort` to keep the saved effort, or pass it to apply on the next idle run. Changing `model_alias` to a different canonical model requires `allow_model_change: true`; a request resolving to the same canonical model is a no-op. Caller, role, route, and executor restrictions still apply. An external executor that cannot change a resumed thread binding returns an error instead of recreating the thread or executor.
- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.
- If a subagent times out, continue the same agent instead of starting over.

When NOT to use AgentRun: skip delegation for trivial work you can do directly — reading a file whose path you already know, searching a small known set of files, or any task that takes only a step or two. Delegation has a context-handoff cost; it pays off only when the task is substantial enough to outweigh it.

Once a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.

Subagents can use `AgentNotify` when their saved binding permits it, but only if the parent must change its actions before the final result arrives; do not send startup confirmations, routine progress, completion notices, or final-result copies.
