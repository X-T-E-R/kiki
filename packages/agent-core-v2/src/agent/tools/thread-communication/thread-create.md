Create a new independent top-level session thread. Do not use this tool unless the user explicitly asks to create a new thread or session.

A thread is a separate session the user owns and works in directly: it does not report back to you, and nothing it does returns as your tool result. To delegate a task whose result you need, use AgentRun instead.

- `title` is optional. Without it, the first line of `prompt` (up to 80 characters) becomes the title, or the session uses its default name.
- `cwd` is optional and must be an absolute path to an existing directory. It may be outside the current workspace; without it, the current session's workspace root is used.
- `profile` is optional and must name an enabled main-agent profile. Without it, the default main agent is used.
- `model_alias` and `effort` optionally bind a configured model and supported thinking effort; omit either to use the profile/default setting, and do not use `inherit` for a main agent.
- `permission_mode` (`manual`, `auto`, `review`, or `yolo`) and `plan_mode` optionally set the new main agent's initial controls before its first prompt.
- `prompt` is optional. When present, it starts the new thread immediately as its first user message. Without it, the thread stays empty until the user sends a message.

If creation fails before the prompt is accepted, the new thread is removed. Only creates a new thread; it does not change the current thread. To keep talking to it, get its full thread reference from ThreadList, then use ThreadSend and ThreadWait; those tools return an error unless thread communication is enabled.
