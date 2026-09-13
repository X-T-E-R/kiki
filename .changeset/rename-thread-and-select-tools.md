---
"@kiki/agent-core-v2": minor
"@kiki/cli": minor
---

**Breaking (agent tool names):** the peer-thread tools and the progressive tool-selection tool now follow the repository's PascalCase tool naming.

- `list_threads` is now `ThreadList`, `read_thread` is `ThreadRead`, `send_message_to_thread` is `ThreadSend`, and `wait_threads` is `ThreadWait`.
- `select_tools` is now `SelectTools`. Its experiment flag environment variable is now `KIKI_EXPERIMENTAL_TOOL_SELECT` (was `KIMI_CODE_EXPERIMENTAL_TOOL_SELECT`); the flag id stays `tool-select`.
- Migration: rename the old spellings in every custom agent profile. A `tools`, `disallowedTools`, or tool-policy entry that still names one now fails the profile bind with `profile.tool_pattern_inactive`, and the error reports the pattern that matches no registered tool. The same old spelling under the global `[tools]` config (`enabled` / `disabled`) is reported as a `tool-pattern-no-match` warning and selects nothing.
- The old names are gone rather than aliased, so only the new spellings activate the tools. Sessions recorded before the rename still render: a stored tool-call name is display data and is not matched against the tool registry on resume.
