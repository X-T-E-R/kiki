Queue a message in a direct child agent's mailbox. A running native child receives it in its active turn; other messages remain queued until the child's next run.

If a child using the native executor is running, the message is steered into the active turn: it is injected at the next step boundary and acknowledged only after delivery. External executor sessions cannot accept mailbox messages mid-turn, so a message to a running external child waits until its next AgentRun or resume. If the child is idle (or a race just ended its turn), the message also waits until that child runs again — an idle child is not woken by this tool.

Who you can address:

- Any **direct** child of the current agent — including unnamed children from `AgentRun`. Grandchildren are not reachable; send from their parent instead. Historical swarm children that remain in the session can still be addressed by agent id.
- Identify the child by the stable `name` you passed to `AgentRun`, or by its agent id. Anonymous `AgentRun` children and retained historical swarm children have no name; use the agent id.
- Names are unique within the session and come only from the `name` parameter of `AgentRun`. Do not invent names. If you do not know a valid name or agent id, call `AgentList` first.

Guidelines:

- `target` accepts either a child name or an agent id. If more than one direct child matches, or none do, the tool fails; call `AgentList` and retry with an unambiguous value.
- `message` must be non-empty. Write it as a note the child will read later — it will not see this conversation.
- A full mailbox means the child has too many unread queued messages. Wait until it consumes some, then retry.
