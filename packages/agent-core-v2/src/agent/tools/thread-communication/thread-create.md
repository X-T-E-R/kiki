Create a new independent top-level session thread. Do not use this tool unless the user explicitly asks to create a new thread or session.

- `title` is optional. Without it, the first line of `prompt` (up to 80 characters) becomes the title, or the session uses its default name.
- `cwd` is optional and must be an absolute path to an existing directory. It may be outside the current workspace; without it, the current session's workspace root is used.
- `profile` is optional and must name an enabled main-agent profile. Without it, the default main agent is used.
- `prompt` is optional. When present, it starts the new thread immediately as its first user message. Without it, the thread stays empty until the user sends a message.

Only creates a new thread; it does not change the current thread. Use ThreadSend and ThreadWait to continue interacting with it.
