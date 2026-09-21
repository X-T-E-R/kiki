Notify your parent agent with a short message. Fire-and-forget: the message is queued in the parent agent's mailbox and this tool returns immediately without waiting for the parent to read it.

If the parent is running on the native executor, the message is delivered at the next safe step boundary. If the parent is idle, the mailbox message starts a new run. A parent running on an external executor cannot accept mailbox messages mid-turn, so the message waits until its next run.

Guidelines:

- Only available to subagents; the main agent has no parent and cannot call this tool.
- `message` must be non-empty. State the fact or question self-containedly — the parent does not see this conversation, only your message text.
- Use this for concise status reports, blockers, or questions directed at the parent. Do not poll: send one message per genuinely new fact.
- Delivery is guaranteed while the parent agent exists in this session; a finished parent receives queued messages when it resumes.
