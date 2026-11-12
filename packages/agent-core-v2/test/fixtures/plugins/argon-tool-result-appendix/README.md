# Argon Tool Result Appendix (`argon-tool-result-appendix`)

An unofficial, independently toggleable Kiki plugin that projects eligible text into the final complete tool result for selected native Argon models. The default target models are `axon-message/gemini-4-carbon` and `axon-message/gemini-4-argon`.

## Choose a projection strategy

- **`passthrough`** keeps the original outbound message layout.
- **`tool_result_appendix`** is host-only: it moves verified host-generated automatic reminders immediately following a complete, canonical, globally unique tool batch into a tagged `<tool-result-appendix>` text part of the final complete tool result. Eligible host text includes:
  - `origin.kind === 'injection'` without `ownerPromptId` and with a verified host reminder `variant` (`runtime_snapshot`, `memory_authority`, `agents_md`, `capability_delta`, `loadable-tools`, `capabilities_rebuilt`, `profile_capabilities_changed`, `agent_profile_changes`, `plugin_change`, `plugin_session_start`, `plan_mode`, `goal`, `goal_cancelled`, `goal_budget_stop`, `goal_fork_cleared`, `model_steering`, `background_task_status`, `permission_mode`, `todo_list_reminder`, `date_change`, `interruption`, `message_delivery`, `init`, `btw`, `room_left`, `room_joined`, `compaction_elision`, `hook_rule/*`).
  - `origin.kind === 'skill_activation'` with `trigger: 'model-tool' | 'nested-skill'`.
  - `origin.kind === 'task'` (background task notifications).
  - `origin.kind === 'cron_missed'` (host missed-schedule notices).
- **`tool_result_trailing_text`** folds contiguous plain-text user, peer, agent, skill, and host-reminder messages after a complete tool batch into the final tool result. Host reminders retain `<tool-result-appendix>`; conversational messages use `<tool-result-followup role="user" origin="...">` to identify new input after the tool. Folding stops before media, attachments, resource links, partial messages, tool declarations, or compaction summaries.

Both projection strategies leave canonical `contextMemory`, wire records, transcript display and UI, undo anchors, and compaction inputs untouched. Projection changes only the outbound request; it does not rewrite conversation history.

## Messages that stay separate in host-only mode

With `tool_result_appendix`, real human prompts (`origin.kind === 'user'` or `undefined`), user slash skill/command activations (`trigger: 'user-slash'`), scheduled user prompts (`origin.kind === 'cron_job'`), backgrounded shell outputs (`variant: 'shell_command_backgrounded'`), prompt-attached injections (`ownerPromptId !== undefined`), peer messages (`peer_thread`), compaction summaries (`compaction_summary`), and failure recovery continuations (`system_trigger: 'failure_recovery_hook'` sending `role: 'user'` `"继续"`) remain standalone `role: 'user'` messages.

## Settings

`strategy` defaults to `tool_result_trailing_text`. Set `targetModels` to exact native model aliases, IDs, or names separated by commas, semicolons, or newlines. Only matching models use projection. The default list is `axon-message/gemini-4-carbon, axon-message/gemini-4-argon`.

Projection is evaluated in-process through `x-kiki.requestProjection`. `IPluginUsageService` applies global, workspace, and session scope filtering and exposes content-free, path-free, credential-free counters; prompt contents are not sent over full-prompt IPC.
