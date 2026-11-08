# Argon Tool Result Appendix (`argon-tool-result-appendix`)

An unofficial, independently toggleable Kiki plugin that configures narrow outbound request projection for explicitly selected native Argon models (such as `axon-message/gemini-4-argon`).

## Behavior

- **Narrow provenance boundary**: Only verified host-generated automatic reminders immediately following a complete, canonical, globally unique tool batch are projected into the final `tool_result` block as an explicitly tagged `<tool-result-appendix>` text part:
  - `origin.kind === 'injection'` without `ownerPromptId` and with a verified host reminder `variant` (`runtime_snapshot`, `memory_authority`, `agents_md`, `capability_delta`, `loadable-tools`, `capabilities_rebuilt`, `profile_capabilities_changed`, `agent_profile_changes`, `plugin_change`, `plugin_session_start`, `plan_mode`, `goal`, `goal_cancelled`, `goal_budget_stop`, `goal_fork_cleared`, `model_steering`, `background_task_status`, `permission_mode`, `todo_list_reminder`, `date_change`, `interruption`, `message_delivery`, `init`, `btw`, `room_left`, `room_joined`, `compaction_elision`, `hook_rule/*`).
  - `origin.kind === 'skill_activation'` with `trigger: 'model-tool' | 'nested-skill'`.
  - `origin.kind === 'task'` (background task notifications).
  - `origin.kind === 'cron_missed'` (host missed-schedule notices).
- **Preserved standalone messages**: Real human prompts (`origin.kind === 'user'` or `undefined`), user slash skill/command activations (`trigger: 'user-slash'`), scheduled user prompts (`origin.kind === 'cron_job'`), backgrounded shell outputs (`variant: 'shell_command_backgrounded'`), prompt-attached injections (`ownerPromptId !== undefined`), peer messages (`peer_thread`), compaction summaries (`compaction_summary`), and failure recovery continuations (`system_trigger: 'failure_recovery_hook'` sending `role: 'user'` `"继续"`) remain standalone `role: 'user'` messages.
- **Canonical history untouched**: `contextMemory`, wire records, transcript display, undo anchors, and compaction inputs are never mutated.
- **Zero full-prompt IPC**: Evaluated in-process via `x-kiki.requestProjection`, plugin settings (`strategy`, `targetModels`), and `IPluginUsageService` scope filtering (global, workspace, session) with content-free, path-free, credential-free counters.
