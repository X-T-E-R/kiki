Queue a message in a direct child agent's mailbox. A running native child receives it in its active turn; an idle resumable child starts a new run with the message; other messages remain queued until a run can accept them.

If a child using the native executor is running, the message is steered into the active turn: it is injected at the next step boundary. This tool returns as soon as the message is durably queued — it does not wait for injection, so `status` normally reads `queued` even when delivery lands a moment later. An idle child is resumed in the background through the normal AgentRun path, including external-executor children and persisted children whose idle scope was released. A running external child cannot accept mailbox messages mid-turn, so its message stays queued until its next run. Children that are starting or cancelling are not restarted by this tool, and a child that can no longer be resumed returns an error.

Who you can address:

- Any **direct** child of the current agent — including unnamed children from `AgentRun`. Grandchildren are not reachable; send from their parent instead. Historical swarm children that remain in the session can still be addressed by agent id.
- Identify the child by the stable `name` you passed to `AgentRun`, or by its agent id. Anonymous `AgentRun` children and retained historical swarm children have no name; use the agent id.
- Names are unique within the session and come only from the `name` parameter of `AgentRun`. Do not invent names. If you do not know a valid name or agent id, call `AgentList` first.

Guidelines:

- `target` accepts either a child name or an agent id. If more than one direct child matches, or none do, the tool fails; call `AgentList` and retry with an unambiguous value.
- `message` must be non-empty. Write it as a note the child will read later — it will not see this conversation.
- A full mailbox means the child has too many unread queued messages. Wait until it consumes some, then retry.
