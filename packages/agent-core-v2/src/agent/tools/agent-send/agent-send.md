Queue a message in a direct child agent's mailbox without starting or interrupting its turn.

The child picks the message up at the beginning of its next step. This is not an interrupt and does not launch a new turn: if the child is idle, the message waits in the mailbox until that child runs again.

Who you can address:

- Any **direct** child of the current agent — including unnamed children from `AgentRun`. Grandchildren are not reachable; send from their parent instead. Historical swarm children that remain in the session can still be addressed by agent id.
- Identify the child by the stable `name` you passed to `AgentRun`, or by its agent id. Anonymous `AgentRun` children and retained historical swarm children have no name; use the agent id.
- Names are unique within the session and come only from the `name` parameter of `AgentRun`. Do not invent names. If you do not know a valid name or agent id, call `AgentList` first.

Guidelines:

- `target` accepts either a child name or an agent id. If more than one direct child matches, or none do, the tool fails; call `AgentList` and retry with an unambiguous value.
- `message` must be non-empty. Write it as a note the child will read later — it will not see this conversation.
- A full mailbox means the child has too many unread queued messages. Wait until it consumes some, then retry.
