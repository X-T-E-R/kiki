Notify your parent agent with one short, self-contained message. This is a one-way send: it does not guarantee a reply, and successful delivery does not mean the parent has read or approved the message.

Use AgentNotify only when the parent needs to change its actions before your final result arrives: a major premise became invalid, work conflicts across tasks, or a critical decision cannot be made independently and the parent can still act in time.

Do not use AgentNotify for startup confirmation, routine progress, itemized findings, estimated completion time, completion notices, or a copy of the final result.

If all work is blocked or your run is about to end, put the information in your final response instead of notifying. Never poll or busy-wait for a reply.

Guidelines:

- Only available to subagents when the saved child binding, global configuration, and active tool policy all permit it.
- `message` must be non-empty and understandable without access to your conversation.
- Send at most once for each genuinely new fact or decision that meets the criteria above.
