# Prompt injections into model requests

Kiki sends the model far more than the user's text: a rendered system prompt, a tool schema list, and a stream of messages the user never wrote. This page inventories every one of those non-user channels as it exists in the running code, so an owner can reason about them without re-deriving the call graph.

> Scope: this is a fact inventory, not a design. It records what is injected, where, under which condition, at what rate, and how each channel affects the request prefix. It says nothing about whether any channel should exist.

Snapshot: branch `kiki` at `4b088855ad`. Every `file:line` reference is from that commit. Wire frequencies come from the main-agent wire of one real session (see [Measured frequencies](#measured-frequencies)).

## Current cadence after the redesign

The inventory below remains the historical snapshot named above, including its old line numbers and wire measurements. This section describes the current implementation; do not use the historical rates as current-runtime claims. The implementation adapts the accepted injection-cadence design with Kiki-local structural gates, without a separate classification-model dependency.

| Channel | Current delivery contract | Owning implementation and proof |
| --- | --- | --- |
| T0/T1 progress | List and notes have independent successful-write ages, work watermarks, reminder budgets and cooldowns: 6-human-turn age, 8-turn cooldown doubling after each reminder, at most two reminders per unchanged owner state; notes require uncovered work; 24-successful-step long-task exception. A notes write cannot acknowledge Todo or memory responsibility. | `continuityState.ts`, `todoListReminder.ts`; `test/session/todo/todoListReminder.test.ts`, `memoryCadence.test.ts` |
| E1 rules / E2 references | Authenticated original human input only; cue seeds feed finite structural gates, with generic behavior candidates requiring explicit future, prohibition, default execution, or change actions; replace/revoke bypass progress throttling; generic earlier-rule references cannot be suppressed by unrelated notes; E2 has a three-human-turn cooldown for identified concurrency or artifact topics, not for unclassified references. Only an appended disclosure consumes the input opportunity. | `directiveCues.ts`, `todoListReminder.ts`; same tests |
| M1/M2/M3 memory maintenance | Main agent only, with enabled non-ephemeral memory, approval not off, and a registered policy-active `MemoryWrite`. M1 reuses original-human classification independently of notes coverage; M2 checks identified unhandled M1 guidance before window renewal, independently of TodoList. Default-on M3 requires active non-polling work and either 12 new human turns plus 24 successful work steps, or 64 steps plus about 32k new work tokens; at most one M3 per window. Setting `continuity_cadence.memory_maintenance = false` disables M3 only. No useful change means no write. | `memoryCadence.ts`, `continuityState.ts`, `sessionTodoService.ts`; `test/session/todo/memoryCadence.test.ts`, `sessionTodo.test.ts` |
| Memory write evidence | The builtin produces structured ID, revision, status, action and operation ID from the real store result. Replay associates a call with its disclosed source revision, not an arbitrary JSON success string. Pending proposals are recorded but not active guidance; unrelated writes do not acknowledge an older input. | `memoryTools.ts`, `toolContract.ts`, `loopEventFold.ts`; `test/agent/tools/memory/memoryTools.test.ts`, `memoryCadence.test.ts` |
| AGENTS coverage and path discovery | Current full rule text is delivered once per effective host/path/scope/version coverage, from a valid snapshot chain, independent full disclosure, or complete nontruncated successful Read pages. Discovery walks only ancestors from the admitted target to its project/session boundary, including nested `.kiki` rules; arbitrary From text and partial reads are not proof. Before the first file-access-declared write, missing rules cause a recoverable tool veto after permission checks; the next safe boundary discloses full text, then retry can execute without another approval. | `instructionCoverage.ts`, `agentsMdReminderService.ts`, `context.ts`, `toolExecutorService.ts`; `test/agent/agentsMdReminder/` |
| AgentRun directory changes | The baseline is the actual preferred-first, up-to-eight profile directory advertised in a real `AgentRun` request schema, or an already appended change disclosure. Initial loading is silent. Changes mean caller availability/signature changes; now unavailable does not claim a file was deleted. | `agentTool.ts`, `agentProfileAnnouncementsService.ts`, `llmRequesterService.ts`; `test/agent/tools/agentProfileAnnouncements.test.ts`, `llmRequesterService.test.ts` |
| First snapshot size | The directory sample is one level with up to 20 entries and an explicit Glob exploration pointer. Skill trigger descriptions remain complete; repeated source paths move to Skill activation rather than each catalog row. AGENTS and plugin rule bodies remain complete. `runtime_snapshot.disclosure.sectionBytes` records UTF-8 bytes for each delivered section; byte targets are diagnostics, not truncation gates. | `context.ts`, `registry.ts`, `dynamicPrompt.ts`; `context.test.ts`, `apply-profile.test.ts`, `test/app/skillCatalog/registry.test.ts` |
| Compaction handoff | Durable notes are not rewritten by compaction. Summary directive candidates and original human-source pointers remain pending until explicit TodoList `review_handoff`; ordinary section writes advance content revision only. Legacy `coveredMessageId` is not proof of review. Unreviewed summaries/candidates survive successive renewals; fresh eligibility uses the independent reviewed boundary/epoch. Over-budget candidates remain complete with a visible notice, not a truncated write. P1 asks for reconciliation rather than notebook reconstruction. | `sessionTodoService.ts`, `todoNotes.ts`, `relayPackage.ts`, `fullCompactionService.ts`; `test/session/todo/sessionTodo.test.ts`, `test/agent/fullCompaction/relayContract.test.ts`, `fullCompaction.test.ts` |
| AgentRun receipts | No appended Standing directives block | `agentTool.ts`; `test/session/dispatch/parity.test.ts` |
| Dynamic prompt context | New sessions send a full durable versioned `runtime_snapshot`, then only changed sections with explicit unchanged-revision and removal semantics; directory trees are sampled at session start or cwd change (new additional roots are sampled when added); workspace and plugin instructions retain their scope, memory is reference data; legacy sessions freeze environment fields and migrate at a live natural-compaction splice | `dynamicPrompt.ts`, `profileService.ts`; `test/agent/profile/apply-profile.test.ts`, `context.test.ts` |
| Plan / goal / permission | State-change and coverage disclosures, no periodic full echo; goal budget enforcement and permission enforcement remain runtime concerns | `planModeInjection.ts`, `goalInjection.ts`, `permissionModeInjection.ts`; corresponding injection tests |
| Capability directories | String provider changes coalesce at the safe step-head sampling boundary into one `capability_delta`; skills use runtime snapshot deltas in the new layout and capability deltas only in legacy layouts; body-only skill edits do not announce catalog changes; schema-role messages remain separate | `contextInjectorService.ts`, `capabilityDelta.ts`; context-injector and tool-select tests |

The user configuration lives in the bilingual [loop-control reference](../en/configuration/config-files.md#loop-control); generated config, wire and state manifests remain the machine-readable contract. `todo.continuity_decision` durably records emitted decisions only, with human/work ordinals and revision coordinates, not user text; suppressed decisions remain available to the evaluator's callback without growing the wire. The human clock is replayable and does not count forwarded receipts or expand skill templates into human rule candidates. Deduplication retains the latest 256 input, work-step, delivered-input, and history-topic identities; older retries beyond that horizon are not deduplicated. Polling-call identities live only within the current step.

Limits: the structural gate is deliberately finite, not general natural-language understanding. Successful `TaskOutput` calls are currently conservatively excluded with other polling calls. Capability coalescing applies to registered providers, not direct plugin-reminder appends. There is not yet a general coverage/world ledger for every injection class or external harness, nor a complete undo/fork semantic-delivery ledger. Restored system text without full metadata has a best-effort legacy environment extraction; no paid-model memory or cache-cost claim follows from renderer stability tests.

## How an injection reaches the model

Four distinct channels carry non-user content into a request; each channel has a different effect on prompt caching.

| Channel | Where it sits | Cache effect |
| --- | --- | --- |
| System prompt | The single `system` string of the request | Any change rewrites the whole cached prefix |
| Tools array | The request's `tools` payload | Any change rewrites the cached tool block (and the prefix after it) |
| Context messages | The `messages` array | Append-only when a message is added at the tail; rewriting only on compaction or splice |
| Tool-result note | Merged into an existing tool message's content | Rewrites the tail from that tool result onward |

Message-level injections are appended through one of two context-memory paths:

- `IAgentContextMemoryService.append` (`packages/agent-core-v2/src/agent/contextMemory/contextMemoryService.ts:73`) — plain append.
- `appendObservable` (`…/contextMemoryService.ts:82`) — append plus a delivery receipt; used for anything that should be shown to the client as a discrete item.

String-returning injections are wrapped by `IAgentSystemReminderService.appendSystemReminder` (`packages/agent-core-v2/src/agent/systemReminder/systemReminderService.ts:18`) into their own `role: 'user'` message:

```text
<system-reminder>
<content>
</system-reminder>
```

`wrapSystemReminder` builds that envelope (`…/agent/systemReminder/systemReminder.ts:5-9`); `systemReminderContent` unwraps a message back to its payload (`…/systemReminder.ts:12`). The default system prompt tells the model these are authoritative directives, in contrast to `<system>` blocks (`packages/agent-profiles/src/system.md:41-43`).

Most string injections are registered as *context-injection providers*: `IAgentContextInjectorService.register(name, provider)` (`packages/agent-core-v2/src/agent/contextInjector/contextInjector.ts:42`). The service runs every provider before each step (`…/contextInjector/contextInjectorService.ts:91-101`) and passes two signals:

- `isNewTurn` — true on the first step of a turn, and also right before/after a compaction splice (`…/contextInjectorService.ts:95-101`).
- `injectedPositions` / `lastInjectedAt` / `lastDisclosure` / `lastInjection` — where and what the same provider injected before (`…/contextInjectorService.ts:128-146`), which is how providers implement their own dedupe.

Provider results land as: a string → `<system-reminder>` user message (`…/contextInjectorService.ts:162-166`); `{ message }` → a message with that role and optional `tools` (`…/contextInjectorService.ts:167-183`); content parts → a `role: 'user'` message (`…/contextInjectorService.ts:184-190`). Every injected message carries `origin: { kind: 'injection', variant: <provider name>, disclosure }` (`…/contextInjectorService.ts:156-160`); the `variant` is the stable identifier used throughout this page and in the wire log.

The context projector keeps injected messages as **separate** messages: only messages whose `origin.kind === 'user'` merge into one user message (`packages/agent-core-v2/src/agent/contextProjector/projection.ts:409-411`, merge loop at `…/projection.ts:217-232`). So an injection is never appended to the user's own message text — this version has no user-message-suffix injection. The one prefix-style injection is skill activation content, prepended into the same user message (`packages/agent-core-v2/src/agent/skill/skillService.ts:162`).

## Class table

Position legend: **system** = inside the system-prompt string; **tools** = the request tools payload; **message** = its own message in the list (role noted); **reminder** = its own `<system-reminder>` user message; **user-prefix** = prepended into a user message's content; **tool-result** = merged into a tool result message.

| # | Class (variant) | Position | Trigger | Rate limit / dedupe | Configurable | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Default system prompt template | system | Always; profile bind | Static per build | `SYSTEM.md`, `prompt_overrides` | `packages/agent-profiles/test/systemFile.test.ts`, `profileShared.test.ts` |
| 2 | `system.*` prompt-field overrides | system | Always; replaces sections of #1 | Static per config | `[prompt.overrides]`, `[models.<alias>.prompt_overrides]`, agent frontmatter, `model_profiles[].prompt_overrides` | `packages/agent-core-v2/test/app/promptField/promptFieldRegistry.test.ts` |
| 3 | `system.shared` appended text | system | Always when set | Static per config | `prompt_overrides.fields['system.shared']` | `packages/agent-core-v2/test/app/promptField/promptFieldRegistry.test.ts` |
| 4 | Workspace/environment block (`${now}`, `${cwd}`, `${cwd_listing}`, `${os}`, `${shell}`, `${additional_dirs_section}`) | system | Session start; re-render on profile refresh | Re-rendered on profile binding | Host-provided; additional dirs from workspace | `packages/agent-core-v2/test/agent/profile/context.test.ts` |
| 5 | `AGENTS.md` content (`${agents_md}`) | system | Session start; on file change | Rebuild on profile refresh | Files on disk | `packages/agent-profiles/test/agentFileDiscovery.test.ts` |
| 6 | `<memory>` block (`${memory}`) | system | Always when memory enabled | Static per snapshot; invalidated on memory write | `[memory]` config | `packages/agent-core-v2/test/app/memory/memory.test.ts` |
| 7 | Skills section (`${skills_section}`) | system | When `Skill` tool active | Static per catalog revision | Skill files | `packages/agent-core-v2/test/agent/skill/prompt.test.ts` |
| 8 | Plugin instructions (`${plugin_sections}`) | system | When plugins contribute | Static per plugin set | Plugin files | `packages/agent-core-v2/test/app/plugin/contributions.test.ts` |
| 9 | Persona block + room prompt | system | Persona / room session | Static per session | Persona files, room config | `packages/agent-core-v2/test/agent/profile/personaPrompt.test.ts`, `packages/agent-core-v2/test/app/room/room.test.ts` |
| 10 | Model-profile prompt overlay | system | When the alias matches a `model_profiles[]` prompt | Static per model | Agent file `model_profiles` | `packages/agent-profiles/test/modelProfileOverlay.test.ts` |
| 11 | Cognition anchor | system (replaces) | First turn of a session when `anchor` is configured | Once for `anchorScope: session` | `[models.<alias>.cognition].anchor` | `packages/agent-core-v2/test/agent/profile/cognition-binding.test.ts` |
| 12 | Delegation notice / subagent notice | system (prefix or `${delegation_context}`) | Non-main agents only | Static per binding | `agents.delegation`, `delegation.sub.notice`, `delegation.independent.notice` | `packages/agent-core-v2/test/agent/profile/delegationContext.test.ts` |
| 13 | External-harness executor prompt | system | Non-native executor | Static per profile | Agent file `executor_prompt` | `packages/agent-profiles/test/executorPrompt.test.ts` |
| 14 | Static tool descriptions and schemas | tools | Always | Frozen per turn | `tool.<name>.description`, `tool.<name>.guidance` | `packages/agent-core-v2/test/app/promptField/promptFieldRegistry.test.ts` |
| 15 | `loadable-tools` announcement | reminder | New turn when the loadable set changed | Folds all prior announcements in history | Tool-select config | `packages/agent-core-v2/test/agent/toolSelect/toolSelectService.test.ts`, `packages/agent-core-v2/test/agent/toolSelect/dynamicTools.test.ts` |
| 16 | `dynamic_tool_schema` message | message (`system` + `tools`; `<system>` for Anthropic/Google) | After `SelectTools` loads tools | One message per drain | — | `packages/agent-core-v2/test/agent/toolSelect/toolSelect.e2e.test.ts` |
| 17 | `todo_list_reminder` T0 | reminder | ≥10 assistant messages since the last TodoList write and the progress spacing elapsed | 1 per evaluation; ≤3 candidates per evaluation | `[loop_control].directive_cues`, TodoList tool policy | `packages/agent-core-v2/test/session/todo/todoListReminder.test.ts` |
| 18 | `todo_list_reminder` T1 (notes stale) | reminder | ≥10 assistant messages, new work ≥ `max(8k, 10% of threshold)` tokens, spacing elapsed | Same as #17 | same | same |
| 19 | `todo_list_reminder` T2 (window renewing) | reminder | ≥85% of the auto-compact threshold, once per context-window epoch | Once per epoch | same | same |
| 20 | `todo_list_reminder` P1 (rebuild after window) | reminder | New epoch with missing/stale notes | Once per epoch | same | same |
| 21 | `todo_list_reminder` E1 (directive cue) | reminder | Latest user-ish input matches the instruction cue word list | Once per user turn | `[loop_control].directive_cues.instructions` | same |
| 22 | `todo_list_reminder` E2 (history cue) | reminder | Input matches the history cue word list, epoch > 0 | Once per user turn | `[loop_control].directive_cues.history` | same |
| 23 | `agents_md` reminder | reminder | A tool touched a directory with an unloaded `AGENTS.md` | Once per path until compaction/clear/undo | Files on disk | `packages/agent-core-v2/test/agent/agentsMdReminder/agentsMdReminder.test.ts` |
| 24 | `interruption` reminder | reminder | Turn cancelled with reason `user_cancelled` | Suppressed when the last message is already this reminder | — | `packages/agent-core-v2/test/agent/loop/loop.test.ts` |
| 25 | `message_delivery` reminder | reminder | Turn in `message` delivery mode ended without `SendMessage` | Once per turn | Delivery mode | `packages/agent-core-v2/test/agent/prompt/submit.test.ts` |
| 26 | `date_change` reminder | reminder | Local date differs from the disclosed/seed date | Once per date change | — | `packages/agent-core-v2/test/features/dateChange/dateChangeInjection.test.ts` |
| 27 | `plan_mode` reminder (full/sparse/reentry/exit) | reminder | Plan mode active, entering, or exited | ≤1 per step; sparse after 2 assistant turns, full refresh at 5 | Plan mode state | `packages/agent-core-v2/test/features/plan/plan.test.ts` |
| 28 | `permission_mode` reminder (auto/review enter/exit) | reminder | Permission mode changed, or first injection in a non-manual mode | Only on change (plus one enter reminder) | Permission mode | `packages/agent-core-v2/test/agent/permissionMode/permissionMode.test.ts` |
| 29 | `goal` reminder (active/blocked/paused) | reminder | New turn while a goal exists | Every new turn | Goal state | `packages/agent-core-v2/test/agent/goal/goalOps.test.ts` |
| 30 | `goal_cancelled`, `goal_budget_stop`, `goal_fork_cleared` | reminder | Goal cancelled by user / hard budget reached / fork has no goal | Budget stop once per turn | Goal state | `packages/agent-core-v2/test/agent/goal/goalOps.test.ts` |
| 31 | `capabilities_rebuilt` | reminder | Capability snapshot changed on a user turn (memory, threads) | Once per user turn | `kiki_context` capability set | `packages/agent-core-v2/test/agent/toolSelect/toolSelect.e2e.test.ts` |
| 32 | `profile_capabilities_changed` | reminder | Skill/subagent catalog changed while idle | ≥1s apart; once per kind per turn gap | Profile catalog | `packages/agent-core-v2/test/agent/toolSelect/toolSelect.e2e.test.ts` |
| 33 | `agent_profile_changes` | reminder | Visible agent profiles changed | Only on new turn while dirty | Agent files | `packages/agent-core-v2/test/agent/tools/agentProfileAnnouncements.test.ts` |
| 34 | `plugin_change` / `plugin_session_start` | reminder | Plugin installed/enabled/removed; plugin session-start text changed | Change-driven; supersedes the earlier reminder | Plugins | `packages/agent-core-v2/test/agent/plugin/agentPlugin.test.ts`, `packages/agent-core-v2/test/app/skillCatalog/plugin-session-start.test.ts` |
| 35 | `background_task_status` | reminder | Compaction splice while background tasks run | Once per splice | — | `packages/agent-core-v2/test/agent/task/taskService.test.ts` |
| 36 | `image_compression` caption | reminder | User message contained a compression caption | One per caption | `[media]` config | `packages/agent-core-v2/test/agent/prompt/promptService.test.ts` |
| 37 | `model_steering` | message (raw `user`, not wrapped) | Enabled turn/compaction, materialized human-input, or agent-local N-step trigger with bound steering text | Coinciding triggers share one copy; each copy restarts the interval (default off) | `[models.<alias>.cognition]` steering path and three trigger fields | `packages/agent-core-v2/test/features/modelSteering/modelSteering.test.ts` |
| 38 | `init` | reminder | Session-init subagent finished writing `AGENTS.md` | Once per init run | Init invocation | `packages/agent-core-v2/test/features/sessionInit/sessionInit.test.ts` |
| 39 | `btw` (side question) | reminder | `/btw` fork created | Once per fork | — | `packages/agent-core-v2/test/features/btw/btw.test.ts` |
| 40 | `room_joined` / `room_left` | reminder | Thread added to / removed from a room | Once per membership change | Room membership | `packages/agent-core-v2/test/app/room/room.test.ts` |
| 41 | Task completion `<notification>` | message (`user`) | Background task reached a terminal state | Once per (task, status) | Task lifetime | `packages/agent-core-v2/test/agent/task/taskService.test.ts` |
| 42 | `agent_message` (subagent → parent) | message (`user`) | Subagent sent a message | Delivery-driven | — | `packages/agent-core-v2/test/session/agentCollaboration/messagingService.test.ts` |
| 43 | `peer_thread` message | message (`user`) | Another thread sent a message | Delivery-driven | Thread config | `packages/agent-core-v2/test/app/threadCommunication/threadCommunicationService.test.ts` |
| 44 | Room message catch-up `<room-messages>` | message (`user`) | Member woken by a room message | One per wake | Room config | `packages/agent-core-v2/test/app/room/room.test.ts` |
| 45 | `<cron-fire>` / cron missed | message (`user`) | Cron due / missed while offline | Schedule-driven | Cron config | `packages/agent-core-v2/test/session/cron/cron-tools.test.ts` |
| 46 | Goal continuation, subagent prompt, retry | message (`user`) | Autonomous re-invocation | Engine-driven | — | `packages/agent-core-v2/test/agent/goal/goalOps.test.ts` |
| 47 | Shell command input/output | message (`user`) | User ran `!command` | One per command | — | `packages/agent-core-v2/test/agent/shellCommand/shellCommand.test.ts` |
| 48 | Steered input merged into a running turn | message (`user`) | User steers / client sends while busy | Mergeable; joins the active turn | — | `packages/agent-core-v2/test/agent/prompt/submit.test.ts` |
| 49 | Compaction summary + elision note | message (`user`) replacing history | Auto/manual compaction | Once per compaction | Auto-compact thresholds | `packages/agent-core-v2/test/agent/fullCompaction/fullCompaction.test.ts` |
| 50 | Relay handoff (`## Standing directives`, `## User input since notes`, …) | message (`user`) | Relay-strategy compaction | Once per compaction | Compaction strategy | `packages/agent-core-v2/test/agent/fullCompaction/relayContract.test.ts` |
| 51 | Compaction instruction to the summarizer | request-local (`compaction` requests) | Summarize-strategy compaction | Once per compaction | — | `packages/agent-core-v2/test/agent/fullCompaction/fullCompaction.test.ts` |
| 52 | `<system>` tool-result note | tool-result | Read footer, SSH host, tool error/empty, media | One per tool result | — | `packages/agent-core-v2/test/os/backends/node-local/tools/read.test.ts`, `packages/agent-core-v2/test/agent/contextProjector/projector-tool-exchanges.test.ts` |
| 53 | `Standing directives in effect` echo | tool-result | `AgentRun` result while directives exist | ≤3 per context-window epoch; 300 chars | TodoList notes / memory | `packages/agent-core-v2/test/session/dispatch/parity.test.ts` |
| 54 | `main_profile_notice` | tool-result | `AgentRun` launched a main-agent profile as a subagent | Once per profile name | Agent files | `packages/agent-core-v2/test/session/dispatch/parity.test.ts` |
| 55 | Kiki context hints to a harness | message (`user`) + harness hook output | `SessionStart` / `UserPromptSubmit` / `PreInvocation` / hook events | Hash-deduped per seat | `kiki_context: [hooks]` | `packages/kap-server/test/harnessHooks.test.ts` |
| 56 | Hook results (`hook_result`, `stop_hook`) | message (`assistant` or `user`) | External hook `UserPromptSubmit` / `Stop` | Per hook event | Hooks config | `packages/agent-core-v2/test/features/externalHooks/integration.test.ts` |
| 57 | Skill / plugin-command activation (`skill_activation`, `plugin_command`) | user-prefix / own message | User slash command or model-selected skill | Once per activation | Skill and plugin files | `packages/agent-core-v2/test/agent/skill/activateSkill.test.ts` |

## 1. System prompt

### 1.1 Default system prompt template

The default main-agent prompt is the template `packages/agent-profiles/src/system.md`, compiled into the package as raw text (`packages/agent-profiles/src/systemPromptFields.ts:1`). It defines the identity paragraph, language policy, intent/tool-use rules, reply quality, workflow, coding, delegation, research, artifact, context-management, environment, project and "Ultimate Reminders" sections, plus placeholders.

Overridable placeholders: `${role_additional}` (`packages/agent-profiles/src/system.md:7`), `${reply_style_guide}` (`:31`), `${os}` and `${shell}` (`:132`), `${now}` (`:138`), `${cwd_listing}` (`:151`), `${additional_dirs_section}` (`:153`), `${agents_md}` (`:163`), and `${memory}${skills_section}${plugin_sections}` (`:165`) — all line numbers in `packages/agent-profiles/src/system.md`.

- Position: `system`.
- Trigger: always; rendered on profile bind and on every profile refresh.
- Rate limit: none; the text is static for a given build and config.
- Template: whole file.
- Cache: any change rewrites the whole cached prefix.
- Config: replace the whole profile with `<Kiki home>/SYSTEM.md` (frontmatter required, `name` forced to `agent`, `override` always true) — `packages/agent-profiles/src/systemFile.ts:17`, `:57-105`.
- Tests: `packages/agent-profiles/test/systemFile.test.ts`, `packages/agent-profiles/test/profileShared.test.ts`.

### 1.2 Prompt-field overrides for system sections

`system.md` is cut into named fields — `system.identity`, `system.language`, `system.intent_tool_use`, `system.reply_style`, `system.reply_quality`, `system.judgment_workflow`, `system.coding`, `system.delegation_brief_hygiene`, `system.research`, `system.public_artifacts`, `system.context`, `system.environment`, `system.project`, `system.ultimate_reminders`, `system.shared` (`packages/agent-profiles/src/systemPromptFields.ts:3-26`, section boundaries `:28-42`, required placeholders `:44-49`). `applySystemPromptFields` substitutes configured values into the template before rendering (`…/systemPromptFields.ts:81-89`).

- Position: `system` (section replacement) and, for `system.shared`, an appended block.
- Trigger: whenever the corresponding field is configured.
- Rate limit: none.
- Template: the field defaults are extracted from `system.md` (`…/systemPromptFields.ts:50-79`); `system.shared` defaults to empty.
- Cache: rewrites the cached prefix.
- Config: four surfaces, low to high precedence — global `[prompt.overrides]` in `config.toml`, `[models."<alias>".prompt_overrides]`, agent / `SYSTEM.md` frontmatter `prompt_overrides`, and `model_profiles[].prompt_overrides`. Override documents may be inline `fields` or relative TOML `files` under the Kiki home (`packages/agent-core-v2/src/app/promptField/promptOverrideFile.ts:22`, validation `packages/agent-profiles/src/promptOverrides.ts:73-92`). Schemas: `packages/agent-profiles/src/promptConfig.ts:14-18`, `packages/agent-profiles/src/promptOverrides.ts:9-12`.
- Tool fields use the same mechanism (see 14).
- Tests: `packages/agent-profiles/test/promptOverrides.test.ts`, `packages/agent-core-v2/test/app/promptField/promptFieldRegistry.test.ts`.

### 1.3 Workspace, environment, instructions, memory, skills, plugins

`systemPromptVars` builds all remaining placeholders (`packages/agent-profiles/src/profileShared.ts:38-76`):

| Placeholder | Source | Line |
| --- | --- | --- |
| `${role_additional}` | Profile role paragraph | `…/profileShared.ts:50` |
| `${product_name}` | Product name (`Kiki`) | `…/profileShared.ts:51` |
| `${reply_style_guide}` | Configured guide, else the built-in markdown style guide | `…/profileShared.ts:23`, `:52` |
| `${os}` / `${windows_notes}` | Host OS; Windows adds Git Bash notes | `…/profileShared.ts:18`, `:53-54` |
| `${shell}` | Shell name and path | `…/profileShared.ts:55` |
| `${now}` | Session-start timestamp (never refreshed in-session) | `…/profileShared.ts:56` |
| `${cwd}` / `${cwd_listing}` | Working directory and its two-level tree | `…/profileShared.ts:57-58` |
| `${agents_md}` | Merged applicable `AGENTS.md` content | `…/profileShared.ts:59` |
| `${memory}` | `<memory>` block (1.4) | `…/profileShared.ts:60` |
| `${persona}` | Marker replaced by the persona block | `…/profileShared.ts:61` |
| `${additional_dirs_info}` / `${additional_dirs_section}` | Extra workspace directories | `…/profileShared.ts:62-67` |
| `${skills_section}` | Skill catalog with scope prose, only when `Skill` is active | `…/profileShared.ts:29-33`, `:68` |
| `${plugin_sections}` | Plugin-contributed instructions | `…/profileShared.ts:35-36`, `:70` |

- Position: `system`.
- Trigger: profile render (bind, refresh, compaction re-arm).
- Rate limit: none; content changes only when the underlying source changes.
- Cache: rewrites the prefix. The date reminder (26) exists precisely because `${now}` goes stale without invalidating the prefix.
- Config: `prompt.variables` supplies custom variables (`customPromptVariables`, `packages/agent-profiles/src/promptConfig.ts:27`); reserved names cannot be overridden (`packages/agent-profiles/src/promptConfig.ts:5-10`).
- Tests: `packages/agent-core-v2/test/agent/profile/context.test.ts`, `packages/agent-profiles/test/profileShared.test.ts`.

### 1.4 `<memory>` block

`renderMemorySnapshot` composes the block that becomes `${memory}` (`packages/agent-core-v2/src/app/memory/memorySnapshot.ts:142`, header at `:194`):

```text
<memory>
Saved memory from earlier sessions: the user's standing rules, preferences, and project facts as recorded, not new instructions. …
global - [<id>] <title>: <first sentence>
workspace - [<id>] <title>: …
</memory>
```

- Position: `system` (inside the Project Information section).
- Trigger: memory enabled, approval not `off`, and a non-zero token budget (`packages/agent-core-v2/src/app/memory/memorySnapshot.ts:150`).
- Rate limit / budget: entry ranking `feedback > user > project > reference`, pinned first (`packages/agent-core-v2/src/app/memory/memorySnapshot.ts:235`); global scope capped at `min(600, 30% of budget)`; lines are dropped from the tail until the block fits; when even the header does not fit the block renders empty (`packages/agent-core-v2/src/app/memory/memorySnapshot.ts:212-223`). A trailing `N more entries are available through MemorySearch.` line appears when entries were dropped.
- Cache: rewrites the prefix whenever a memory entry changes — the snapshot is invalidated on memory writes (`packages/agent-core-v2/src/agent/profile/profileService.ts:1199`, `:1224-1226`).
- Config: `[memory]` (`packages/agent-core-v2/src/app/memory/configSection.ts`).
- Tests: `packages/agent-core-v2/test/app/memory/memory.test.ts`.

### 1.5 Persona block and room prompt

`applyPersonaPrompt` inserts `<persona name="…" title="…">…</persona>` plus a capability notice and examples into the system prompt; an optional room prompt is merged into the same block (`packages/agent-core-v2/src/agent/profile/personaPrompt.ts:10-40`). Room sessions prepend the room roster prompt produced by `renderRoomPrompt` (`packages/agent-core-v2/src/app/room/roomService.ts:1128`).

### 1.6 Cognition anchor

When the bound model alias declares `[models.<alias>.cognition].anchor`, the anchor file replaces the entire system prompt for the anchored window (`packages/agent-core-v2/src/agent/cognition/cognitionAnchorService.ts:34-53`). Defaults: `anchorSteps = 1`, `anchorScope = 'session'` (thus only turn 0). Because it replaces the prompt rather than appending, it changes the cached prefix for that turn.

### 1.7 Model-profile prompt overlay

`applyMatchedModelProfilePrompt` prepends/appends/wraps a prompt declared by a matching `model_profiles[]` entry (`packages/agent-core-v2/src/agent/profile/profileService.ts:1491`; renderer `packages/agent-profiles/src/modelProfileOverlay.ts:77`).

### 1.8 Delegation notice

`injectDelegationContext` places the delegation snippet either at `${delegation_context}` or as a prefix of the rendered prompt (`packages/agent-core-v2/src/agent/profile/delegationContext.ts:31-40`). The subagent snippet is `packages/agent-profiles/src/delegation-sub-notice.md` (default `delegation.sub.notice`, first line of `packages/agent-profiles/src/profileShared.ts:1`); the independent-agent snippet is `packages/agent-core-v2/src/agent/profile/delegation-independent-notice.md`. Main agents get no snippet (`packages/agent-core-v2/src/agent/profile/delegationContext.ts:48`). Config: `agents.delegation.sub` / `agents.delegation.independent`, plus the `delegation.*.notice` prompt fields.

## 2. Tools

### 2.1 Static tool descriptions and guidance

Every request carries the active tool schemas. Descriptions come from per-tool markdown resources registered as prompt fields `tool.<name>.description` / `tool.<name>.guidance` for 28 built-in tools (`packages/agent-core-v2/src/app/promptField/builtinPromptFields.ts:18-47`, field registration `:96-124`). `applyToolPromptFields` substitutes a configured description (preserving a documented prefix when the tool prepends dynamic text) and appends `User-configured guidance:` when guidance is set (`…/builtinPromptFields.ts:133-155`).

- Position: `tools`.
- Trigger: every request; the tool list is frozen for the duration of a turn (`packages/agent-core-v2/src/agent/llmRequester/llmRequesterService.ts:905-923`).
- Cache: any change rewrites the cached tools block and everything after it. `appendSharedPromptField` appends `system.shared` to the system prompt (`…/builtinPromptFields.ts:157-165`).
- Config: same four prompt-field surfaces as 1.2.
- Tests: `packages/agent-core-v2/test/app/promptField/promptFieldRegistry.test.ts`.

### 2.2 Loadable-tool announcement (`loadable-tools`)

When tool selection is enabled, each new turn compares the loadable tool set (and changed schemas) against everything previously announced in the conversation history and emits one announcement (`packages/agent-core-v2/src/agent/toolSelect/toolSelectService.ts:206-235`), rendered by `renderLoadableToolsAnnouncement` (`packages/agent-core-v2/src/agent/toolSelect/dynamicTools.ts:92-110`):

```text
<tools_added>
<name> — <first description sentence, ≤100 chars>
</tools_added>

<tools_removed>
<name>
</tools_removed>

Use the SelectTools tool with exact names to load full tool definitions before calling them. …
```

- Position: `reminder` (own `<system-reminder>`-wrapped user message, via the `loadable-tools` provider — `packages/agent-core-v2/src/agent/toolSelect/toolSelectAnnouncementsService.ts:19`).
- Trigger: `isNewTurn` and a non-empty added/removed delta.
- Rate limit / dedupe: `foldAnnouncedToolNames` folds the whole history, so the same tool is announced once; `<tools_removed>` entries cancel earlier `<tools_added>` entries (`packages/agent-core-v2/src/agent/toolSelect/dynamicTools.ts:61-91`). Schemas that changed after being announced are re-announced once.
- Cache: append-only message; but loading tools adds them to the request `tools` payload, which does change the cached tool block for later steps.
- Tests: `packages/agent-core-v2/test/agent/toolSelect/dynamicTools.test.ts`, `packages/agent-core-v2/test/agent/toolSelect/toolSelectService.test.ts`.

### 2.3 Dynamic tool schema message (`dynamic_tool_schema`)

After `SelectTools` loads tools, the pending schemas are emitted as a message with `role: 'system'` and a `tools` array (`packages/agent-core-v2/src/agent/toolSelect/toolSelectSchemasService.ts:19-23`; drain logic `packages/agent-core-v2/src/agent/toolSelect/toolSelectService.ts:185-197`).

- Position: `message` with `role: 'system'` and a `tools` payload. Anthropic and Google GenAI do not accept a mid-conversation system message, so the provider layer rewrites it into a user message containing `<system>…</system>` (`packages/agent-core-v2/src/kosong/provider/bases/anthropic/anthropic.ts:431-439`, `…/google-genai/google-genai.ts:341-350`). For OpenAI-compatible non-Kimi protocols, `projectDynamicToolSchemas` inlines the schemas as `<dynamic_tool_schemas>…</dynamic_tool_schemas>` (`packages/agent-core-v2/src/agent/llmRequester/dynamicToolProjection.ts:4-27`).
- Trigger: `drainPendingToolSchemas()` returns a non-empty set.
- Cache: inserts tool definitions mid-conversation; the surrounding prefix is unchanged, but the tools payload position changes.
- Tests: `packages/agent-core-v2/test/agent/toolSelect/toolSelect.e2e.test.ts`, `packages/agent-core-v2/test/agent/contextProjector/projector-tool-exchanges.test.ts`.

## 3. Message-stream injections (`<system-reminder>`)

### 3.1 TodoList reminders — the largest family (`todo_list_reminder`)

`TodoListReminderTracker.evaluate` (`packages/agent-core-v2/src/session/todo/todoListReminder.ts:57-113`) builds up to three candidate reminders per evaluation, in this priority order, and joins them with blank lines followed by the footer `Ignore if not relevant. Do not mention this reminder to the user.` (`…/todoListReminder.ts:37`, `:112`). It is registered for every agent (`packages/agent-core-v2/src/session/todo/sessionTodoService.ts:180`).

| Trigger | Condition (code) | Text |
| --- | --- | --- |
| `T2` | notes enabled, tokens ≥ 85% of the auto-compact threshold, not yet reminded for this window epoch | `` The context window will be renewed soon (about N tokens left). Bring TodoList notes up to date: goal …, directives, decisions, rejected options, evidence, and the exact next step. …`` |
| `P1` | new window epoch and notes missing/stale or the handoff has uncaptured user input | `A new window started. Rebuild TodoList notes from the handoff before continuing: goal, directives (including User input since notes), next.` |
| `E1` | the newest user-ish input matches the instruction cue list, or the input is the text the user just steered | `The user's latest input may set, change, or revoke a standing instruction. If it applies beyond this step, add it to TodoList notes.directives (quote + t<turn>) and replace any older value it changes. … Otherwise ignore.` |
| `E2` | epoch > 0 and the input matches the history cue list | `The user refers to earlier conversation. Check Standing directives and User input since notes in the latest handoff first; if absent, HistorySearch this session.` |
| `T1` | ≥10 assistant messages since notes and ≥ `max(8k, 10% of threshold)` new tokens and spacing elapsed | `Working notes were last updated at <step> and ~N tokens of new work followed. Update TodoList notes when convenient …` |
| `T0` | ≥10 assistant messages since the last TodoList write and spacing elapsed | `TodoList has not been updated recently. If it still helps, update it; clear or rewrite it if stale. …` plus the current list |

Exact strings: `packages/agent-core-v2/src/session/todo/todoListReminder.ts:91-98`.

- Position: `reminder` (own user message; the disclosure records `kind`, `triggers`, `epoch`, `userTurn` — `…/todoListReminder.ts:108-109`).
- Rate limits: at most 3 candidates per evaluation; the progress spacing is `min(40, 10 × 2^⌊unansweredProgress/2⌋)` assistant messages since the last reminder (`…/todoListReminder.ts:72`); `T2` is once per epoch (state `todo_reminder` + `nearEpoch`); `E1`/`E2` are once per user-turn key; `T0`/`T1` require `turnsSinceLastWrite >= 10`. "Turns" here means **assistant messages**, not user turns — that is why `T0` fires on nearly every user turn in long agentic sessions (see [Measured frequencies](#measured-frequencies)).
- Trigger inputs: reminders evaluate only when the `TodoList` tool is active for that agent (`packages/agent-core-v2/src/session/todo/sessionTodoService.ts:216`).
- Cue word lists (`packages/agent-core-v2/src/session/todo/directiveCues.ts:6-13`), overridable via `[loop_control].directive_cues` (`packages/agent-core-v2/src/agent/loop/configSection.ts:23`, wired at `packages/agent-core-v2/src/session/todo/sessionTodoService.ts:218`):
  - `instructions`: `以后 不要 别 一律 每次 记住 直接 默认 必须 禁止 改成 纠正 应该 始终 务必 优先 遵守 下次 统一 再也 只能 最多 上限 不超过 并发 放开 放宽 收紧 撤销 取消 恢复 改回 临时 定了 拍板 always never don't do not from now on remember default must instead prefer directly pin every time make sure stop correction use only avoid keep using next time at most limit no more than revert revoke relax lift temporary decided`
  - `history`: `之前 早先 上次 我说过 刚才说 前面说 以前说 as I said earlier again last time previously already told`
  - Matching is a case-insensitive substring test (`matchesDirectiveCue`, `packages/agent-core-v2/src/session/todo/directiveCues.ts:14-17`), so a cue can match inside an unrelated word.
- Cache: append-only; invalidates nothing before it.
- Tests: `packages/agent-core-v2/test/session/todo/todoListReminder.test.ts`, `packages/agent-core-v2/test/session/todo/sessionTodo.test.ts`.

### 3.2 `agents_md` reminder

`AgentAgentsMdReminderService.flushStepHead` queues every `AGENTS.md` path discovered by the previous step's tool calls, keeps the ones that exist, are non-empty, and have not been injected or read (`packages/agent-core-v2/src/agent/agentsMdReminder/agentsMdReminderService.ts:110-136`), then injects:

```text
The following AGENTS.md file(s) apply to paths accessed by your recent tool call, but were not included in your system prompt:
- <path>
Read them before making changes in those directories.
```

(`…/agentsMdReminderService.ts:328-334`; variant `agents_md` at `:143`)

- Position: `reminder`.
- Trigger: a Bash/Read-like tool touched a directory covered by an `AGENTS.md` that is not already in the system prompt; paths already injected are seeded from the rendered prompt (`…/agentsMdReminderService.ts:81-85`, `:109-115`).
- Dedupe: per path; the `reminded` set clears on compaction, context clear, and undo (`:99-101`).
- Cache: append-only.
- Tests: `packages/agent-core-v2/test/agent/agentsMdReminder/agentsMdReminder.test.ts`.

### 3.3 `interruption` reminder

After a turn ends with reason `cancelled` and `interruptReason: 'user_cancelled'`, `AgentInterruptionReminderService` appends (`packages/agent-core-v2/src/agent/interruptionReminder/interruptionReminderService.ts:15-19`, `:35-45`):

`The previous turn was interrupted by the user before completion; any partial output shown above is incomplete. The user's next message continues the conversation.`

- Position: `reminder`; variant `interruption` (`…/interruptionReminderOps.ts:7`).
- Dedupe: skipped when the last comparable message is already this reminder.
- Cache: append-only.

### 3.4 `message_delivery` reminder

When the session runs in `message` delivery mode and a turn triggered by the user, a peer thread, or a targeted room message finishes without a `SendMessage` call, the reminder below is injected and a continuation step is enqueued (`packages/agent-core-v2/src/agent/delivery/deliveryReminderService.ts:18`, `:67-77`):

`You have not sent a message this turn. Ordinary output is not visible to the user. If a reply is needed, call SendMessage; otherwise finish without sending.`

- Rate limit: once per turn (`state.reminded`); only for the main agent (`:43`).
- Cache: append-only.

### 3.5 `date_change` reminder

Injected when the local date differs from the disclosed baseline or the seeded date (`packages/agent-core-v2/src/features/dateChange/dateChangeService.ts:44-77`):

`The date has changed. Today's date is now <YYYY-MM-DD>. The date and time stated in your system prompt are stale; rely on this reminder for the current date. DO NOT mention this to the user explicitly.`

- Position: `reminder`; disclosure `{kind:'date', renderGeneration, localDate, timeZone}`.
- Dedupe: one per baseline date; a baseline is seeded on the first evaluation, and the reminder is suppressed when the profile was re-rendered from a different working directory (`:49-55`), so the cached prefix is not rewritten just to refresh a date.
- Tests: `packages/agent-core-v2/test/features/dateChange/dateChangeInjection.test.ts`.

### 3.6 `plan_mode` reminders

`PlanModeInjection` (`packages/agent-core-v2/src/features/plan/injection/planModeInjection.ts:33-53`) picks a template per state:

| Situation | Template |
| --- | --- |
| Plan mode exits | `plan-mode-exit-reminder.md` |
| Re-enters an existing plan | `plan-mode-reentry-reminder.md`, else `plan-mode-inline-reentry-reminder.md` |
| Enters with an empty plan | `plan-mode-full-reminder.md`, else `plan-mode-inline-full-reminder.md` |
| Still active, ≥5 assistant turns since the last injection, or a user message appeared | `plan-mode-full-reminder.md` family |
| Still active, ≥2 assistant turns since the last injection | `plan-mode-sparse-reminder.md` family |
| Otherwise | nothing |

All templates live in `packages/agent-core-v2/src/features/plan/injection/`; the plan-file path is appended as `Plan file: <path>` (`…/planModeInjection.ts:82-85`).

- Position: `reminder`; variant `plan_mode`.
- Rate limits: `PLAN_MODE_DEDUP_MIN_TURNS = 2`, `PLAN_MODE_FULL_REFRESH_TURNS = 5` (`…/planModeInjection.ts:17-18`).
- Cache: append-only.

### 3.7 `permission_mode` reminders

`PermissionModeInjection` (`packages/agent-core-v2/src/agent/permissionMode/injection/permissionModeInjection.ts:43-57`) emits an enter/exit note when the mode changes, and repeats the enter note only if the current mode (`auto` or `review`) has never been disclosed in this context. Templates: `permission-mode-{auto,review}-{enter,exit}-reminder.md` in the same directory.

- Position: `reminder`; variant `permission_mode`.

### 3.8 `goal` and goal-lifecycle reminders

`GoalInjection` runs on every new turn for an agent with an active, blocked, or paused goal (`packages/agent-core-v2/src/agent/goal/injection/goalInjection.ts:24-39`). Templates: `goal-active-reminder.md`, `goal-blocked-reminder.md`, `goal-paused-reminder.md` (`…/goal/injection/`). The active reminder embeds objective, completion criterion, status, progress counters, budgets, and the near-budget guidance (`…/goalInjection.ts:42-45`, `:63-74`). User-supplied text is XML-escaped (`:124-129`), and the completion criterion is wrapped in `<untrusted_completion_criterion>` (`:81-84`).

Separate one-shot reminders in `packages/agent-core-v2/src/agent/goal/goalService.ts`:

| Variant | Text | Trigger | Line |
| --- | --- | --- | --- |
| `goal_cancelled` | `The user cancelled the current goal. Ignore earlier active-goal reminders for that goal. …` | User cancels a goal | `:86-90`, `:704` |
| `goal_budget_stop` | `The goal's hard budget was reached and the goal is now blocked; … Stop immediately. …` | Hard budget reached | `:117-122`, `:898` |
| `goal_fork_cleared` | `This fork does not have a current goal. …` | A fork carries a pending clear notice | `:92-96`, `:1155` |

- Position: `reminder`.
- Cache: append-only.

### 3.9 `capabilities_rebuilt`

On a user-initiated turn, if the capability snapshot reports that memory or thread communication just became available, the profile is refreshed and the reminder `Capability settings changed (memory[, thread communication]). The available tools and system instructions were rebuilt for this user turn.` is appended (`packages/agent-core-v2/src/agent/capabilityRebuild/capabilityRebuildService.ts:45-59`).

- Rate limit: at most once per user turn (`lastTurnId` guard).
- Cache: note that the *reason* for this reminder is a prefix rewrite — it tells the model the system prompt and tools changed mid-session.

### 3.10 `profile_capabilities_changed`

Skills or dispatchable subagents changed while the agent was idle (`packages/agent-core-v2/src/agent/toolSelect/profileCapabilityChangesService.ts:82-126`):

`Available profile capabilities changed (<skills|subagents>). Check the current skill and subagent listings before using them; existing system instructions and tool schemas remain unchanged until context rebuild.`

- Rate limit: at least 1000 ms between deliveries (`MIN_INTERVAL_MS`, `:22`); delivery only while idle; per-kind dedupe cleared on each new turn (`disclosedThisGap`, `:47-55`).
- Cache: append-only by design; the text states the prefix has *not* changed.

### 3.11 `agent_profile_changes`

When the visible agent-profile list changes and the `AgentRun` tool is active, the next new turn emits a delta block (`packages/agent-core-v2/src/agent/tools/agent/agentProfileAnnouncementsService.ts:13-32`, `:61-69`):

```text
<agent_profiles_added>
<profile line>
</agent_profiles_added>
<agent_profiles_updated>
<profile line>
</agent_profiles_updated>
<agent_profiles_removed>
<name>
</agent_profiles_removed>
```

Only the sections with entries are emitted. Position: `reminder`; variant `agent_profile_changes`.

### 3.12 `plugin_change` and `plugin_session_start`

- `plugin_change` — `Plugin "<id>" was <installed|rolled back|enabled|disabled|removed|updated>. Plugin tools refresh in live sessions; prompt contributions may remain until /new or /reload.` emitted on every plugin mutation when tool selection is disabled (`packages/agent-core-v2/src/agent/plugin/agentPluginService.ts:46-51`, `:104-113`).
- `plugin_session_start` — reconciled on each injection from the plugin session-start skills (`…/agentPluginService.ts:88-92`, `:151-178`). When the desired text changes it is re-emitted with the suffix `This supersedes any earlier plugin_session_start reminder in this session.`; when nothing is active it emits `There are currently no active plugin session starts. …` once (`:49-52`). Main agent only (`:82`).

### 3.13 `background_task_status`

After a compaction splice, if background tasks are still running, the next step injects `These background tasks are still running after compaction. Do not start duplicates. Completion arrives via automatic notification.` followed by the task list (`packages/agent-core-v2/src/agent/task/taskService.ts:197-201`, `:355-362`, `:388-397`).

- Rate limit: flag-driven, cleared on emit.

### 3.14 `image_compression` captions

Captions found inside a user message (`<system>Image compressed to fit model limits: …</system>`) are extracted from the user's own content and re-injected as separate reminders (`packages/agent-core-v2/src/agent/prompt/promptService.ts:1578-1590`, `:1593-1599`; caption format `packages/agent-core-v2/src/agent/media/image-compress.ts:594-599`). This keeps the user's message text clean while preserving the notice `ownerPromptId`-linked to that prompt (`packages/agent-core-v2/src/agent/prompt/promptStepRequests.ts:26-34`).

### 3.15 `model_steering`

`AgentModelSteeringService` appends frozen steering as a **plain `user` message, not wrapped in `<system-reminder>`**. Transport role is not provenance or authority. `modelSteeringSources.ts` maps actual `PromptOrigin` producers to user or the nine `steering_sources` groups; user covers explicit human, plugin command and user-slash skill input. Unconfigured non-user and unknown sources are off for every trigger.

A `merged` origin retains every original child; sources are expanded recursively rather than collapsed to user. External-client thread delivery has `external_thread` provenance, and model-created threads use the `thread_create` system trigger. This exact trigger remains an undo anchor and retained compaction input, is readable in the timeline's peer lane, and projects as `thread_created` through ThreadRead; it does not claim a peer sender or human provenance. Other system triggers retain their existing visibility. Text presentation annotations are independent of this identity.

REST `PromptItem.origin` carries the original opaque origin through prompt receipts and queue updates; transcript projection retains it as `UserBlock.sourceOrigin` and classifies the payload by provenance rather than user transport role or body markup. A legacy receipt with no origin retains the established user default, or the row's previously recorded origin. Canonical transcript queue admission remains limited to its existing user/cron contract.

The selected common/main/independent cognition object freezes native source bodies and Recipe leaf contributions in `binding.steeringSources`. `inherit` reads the binding's final user slot and cadence; `custom` reads its own frozen body/cadence, with missing text remaining empty. Binding changes and cold recovery reset provider-local counters without replacing saved inputs. The provider counts distinct model step heads only for active enabled sources; tool results and idle reconciliation do not advance counters. Materialized input replaces the active source set, turn seeds set it at new turns, and retries retain the previous input's provenance. Turn, input and interval triggers are ORed per source, identical emitted texts deduplicate, and compaction rearming never bypasses an off source.

The loop materializes the whole step batch before injector hooks, preserving input order and leaving streaming requests unchanged. `promptService.steer` evaluates prompt-submit hooks once per original selected record; successful hook output is collected into `SteerStepRequest` and appended only at materialization. Blocked feedback runs at the owned step boundary. Hook matching separates real `source` (user/task/mailbox) from `delivery: 'steering'`: human Send now still matches user guidance, while steered mailbox input stays mailbox. Cancellation or rejection before materialization cannot trigger steering. Owners and evidence: `features/modelSteering/{modelSteeringService,modelSteeringSources}.ts`, `agent/cognition/steeringBinding.ts`, and `agent/prompt/{promptService,promptStepRequests}.ts`; request, source-off, mixed-source and cadence assertions live in `test/features/modelSteering/modelSteering.test.ts`, hook collector assertions in `test/features/externalHooks/rules.test.ts`, and frozen Recipe/native recovery in `test/agent/profile/cognition-binding.test.ts` (paths relative to `packages/agent-core-v2/`).

### 3.16 `init`

After the session-init subagent finishes writing `AGENTS.md`, `initCompletionReminder(agentsMd)` is appended (`packages/agent-core-v2/src/features/sessionInit/sessionInitService.ts:97-112`; template `packages/agent-core-v2/src/features/sessionInit/profile/init.ts`). The same call seeds the `agents_md` reminder's known paths (`:103-105`).

### 3.17 `btw`

A `/btw` side-question fork receives `SIDE_QUESTION_SYSTEM_REMINDER` as its first message and has all tool execution vetoed (`packages/agent-core-v2/src/features/btw/btwService.ts:16-23`).

### 3.18 `room_joined` / `room_left`

Room membership changes inject a note into the member thread's main agent (`packages/agent-core-v2/src/app/room/roomService.ts:379`, `:386`, `:391-397`). Variants: `room_joined`, `room_left`.

## 4. Non-user turns and forwarded messages

These are not `<system-reminder>` notes: they are ordinary user-role messages that the model sees *as* user input, even though the user did not type them. They invoke turns of their own.

### 4.1 Task completion notification (`<notification>`)

Terminal background tasks are delivered as XML (`packages/agent-core-v2/src/agent/task/taskService.ts:1645-1665`; renderer `packages/agent-core-v2/src/agent/task/notificationXml.ts:3-38`):

```text
<notification id="…" category="…" type="…" source_kind="…" source_id="…" agent_id="…">
Title: …
Severity: …
<body>
<children: output preview, recovery guidance, remaining subagent status>
</notification>
```

- Origin: `{kind:'task', taskId, status, notificationId}` (`packages/agent-core-v2/src/agent/task/taskService.ts:1619`).
- Dedupe: once per `(taskId, status)` key, checked against in-memory sets and against the existing context (`:1604-1612`, `:1730-1736`). Preview bytes are budgeted across the batch (`NOTIFICATION_BATCH_PREVIEW_BYTES`, `:1580-1584`).
- Cache: appended mid-stream and delivered between turns; append-only.
- Tests: `packages/agent-core-v2/test/agent/task/taskService.test.ts`.

### 4.2 `agent_message` (subagent → parent)

Messages sent by another agent are wrapped by `visibleAgentMessage` (`packages/agent-core-v2/src/session/agentCollaboration/messagingService.ts:492-503`):

```text
Message from agent "<source task name>" (<source agent id>):

<content>
```

An external sender renders as `Message from external agent "…" (…)`, and a send attributed to the user keeps no envelope and carries `origin: {kind:'user'}` (`…/messagingService.ts:475-490`). The wrapped text is appended as an observable user message (`…/messagingService.ts:486`) or delivered through the mailbox step request (`…/messagingService.ts:292`), with origin `{kind:'agent_message', messageId, senderAgentId, senderTaskName}` (`packages/agent-core-v2/src/agent/contextMemory/types.ts:105-110`).

### 4.3 `peer_thread` message

Thread-to-thread sends are wrapped (`packages/agent-core-v2/src/app/threadCommunication/threadCommunicationService.ts:824-826`):

```text
Message from thread <label>:

<content>
```

Origin `{kind:'peer_thread', source, messageId, acceptedAt}` (`packages/agent-core-v2/src/agent/contextMemory/types.ts:98-103`). Delivery may steer into a running turn, start a new turn, or wait in the queue depending on the target thread's state (`packages/agent-core-v2/src/app/threadCommunication/threadCommunicationService.ts:777-860`).

### 4.4 Room message catch-up

A woken room member receives one user message containing the catch-up since its cursor (`packages/agent-core-v2/src/app/room/roomService.ts:1145-1162`):

```text
<room-messages room="<room id>" since="<cursor id>">
[<message id> <author>] <text>
</room-messages>
You were selected for room message <id>. … To speak in the room, use ThreadSend({room: "…", content, mentions?}); mentions use member ids: … A message that mentions no one goes to the room host. …
```

Origin `{kind:'room_message', roomId, messageId, targeted, generation}`.

### 4.5 Cron

`<cron-fire jobId="…" cron="…" recurring="…" coalescedCount="…" stale="…">\n<prompt>…</prompt>\n</cron-fire>` (`packages/agent-core-v2/src/app/cron/format.ts:18-30`; enqueued at `packages/agent-core-v2/src/session/cron/sessionCronServiceImpl.ts:452-472`), and a missed-run message with origin `{kind:'cron_missed', count}` (`packages/agent-core-v2/src/session/cron/sessionCronServiceImpl.ts:403-422`).

### 4.6 Autonomous re-invocations

`system_trigger` origins cover goal continuations (`name: 'goal_continuation'`, `packages/agent-core-v2/src/agent/goal/goalService.ts:100-103`), subagent prompt delivery (`name: 'subagent'`, `packages/agent-core-v2/src/session/subagent/runAgentTurn.ts:15-18`), stop-hook continuations (`name: 'stop_hook'`, `packages/agent-core-v2/src/features/externalHooks/agent/agentExternalHooksService.ts:253`), and retries (`{kind:'retry'}`, `packages/agent-core-v2/src/agent/prompt/promptStepRequests.ts:103-112`).

### 4.7 Shell commands

User-typed `!command` input and its output are appended with origin `{kind:'shell_command', phase}` (`packages/agent-core-v2/src/agent/shellCommand/shellCommandService.ts:206-223`).

### 4.8 Steering

`steer` submits a user message that joins the running turn instead of starting a new one (`packages/agent-core-v2/src/agent/prompt/promptStepRequests.ts:72-101`, mergeable and not turn-scoped). Two consequences matter for the injection inventory:

- The steered text is appended to the live context, so providers that run before the next step (including todo reminders) see it — this is the `steered` flag in `TodoListReminderTracker.steer` (`packages/agent-core-v2/src/session/todo/todoListReminder.ts:53`, `:88`).
- Steering publishes `PromptSteered`, which `SessionTodoService` subscribes to so the E1 directive reminder can fire on exactly that text (`packages/agent-core-v2/src/session/todo/sessionTodoService.ts:187-189`).

### 4.9 Skill and plugin-command activation

A user slash command replaces or prefixes the user's own message with generated content, so it is the one place where injected text shares the user's message rather than following it:

- Skill activation prepends the rendered skill prompt to the user input inside a single `role: 'user'` message (`packages/agent-core-v2/src/agent/skill/skillService.ts:162`; part built by `prepareBundled` at `packages/agent-core-v2/src/agent/skill/skillService.ts:196-236`). Origin `{kind:'skill_activation', activationId, skillName, skillArgs, trigger: 'user-slash'|'model-tool'|'nested-skill', …}` (`packages/agent-core-v2/src/agent/contextMemory/types.ts:19-29`), and the user-message origin records the activations (`…/types.ts:8-11`).
- Plugin command activation enqueues the expanded command body as its own user message with origin `{kind:'plugin_command', activationId, pluginId, commandName, commandArgs, trigger:'user-slash'}` (`packages/agent-core-v2/src/agent/pluginCommand/pluginCommandService.ts:50-72`).

## 5. Compaction

### 5.1 Summary message and elision note

Compaction replaces the head of the history with one user message built from `compaction-summary-prefix.md` (`packages/agent-core-v2/src/agent/contextMemory/compaction-summary-prefix.md:1`; assembly `packages/agent-core-v2/src/agent/contextMemory/compactionHandoff.ts:129`), origin `{kind:'compaction_summary'}` (`packages/agent-core-v2/src/agent/contextMemory/compactionHandoff.ts:137`). When user messages between the kept head and tail are dropped, an elision note is inserted (`packages/agent-core-v2/src/agent/contextMemory/compactionHandoff.ts:141-152`):

`Some of this conversation's user messages were omitted here during compaction: the messages above this note are the oldest user input, the messages below are the most recent, and roughly <N> tokens in between were dropped. The omitted content is covered by the compaction summary at the end of the conversation.`

Rewriting history changes every cached prefix after the cut point — this is the only injection family that is not append-only.

### 5.2 Relay handoff block

With the relay strategy (no summarizing model), `renderRelay` assembles the replacement message from `packages/agent-core-v2/src/agent/fullCompaction/relayPackage.ts`:

| Section | Renderer | Notes |
| --- | --- | --- |
| Preamble | `packages/agent-core-v2/src/agent/fullCompaction/relayPackage.ts:189` | "assembled without a summarizing model … Verify completed claims" |
| `## Window` | `:190` | agent id, epoch, removed-history boundary and pointer coordinates |
| `## Working notes` | `:191` | `renderTodoNotes` |
| `## Standing directives` + `## User input since notes` + closing rule | `:120-129` | directives from TodoList notes (or `(none recorded in notes)`), optional live memory entries/references, then up to 5/user-budgeted excerpts of real user inputs with `HistoryRead`/`HistorySearch` pointers (budget 3000 tokens, excerpts 600 chars, `:96-118`), ending with `Treat Standing directives and User input since notes as in force unless the user later revoked them; …` |
| `## Linked board cards` | `:131-135` | up to 5 cards |
| `## Notes metadata`, `## TODO List`, `## Last conclusion`, `## Evidence since notes`, `## Pending receipts`, `## History` | `:194-199` | see file for exact shapes |

"Real user input" for this block excludes injections and includes `user`, `peer_thread`, and `agent_message` origins only (`packages/agent-core-v2/src/agent/fullCompaction/relayPackage.ts:87-94`).

### 5.3 Compaction instruction

The summarizer request carries its own system/user instruction (`packages/agent-core-v2/src/agent/fullCompaction/compaction-instruction.md`), including `In the handoff, include a \`## Standing directives\` section …` (`:72-79`) and `${custom_instruction_block}` (`:84`). Rendered at `packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts:745`. These requests are logged as `llm.request` with `kind: "compaction"`.

## 6. Tool-result level

### 6.1 `<system>` notes on tool results

Tool results carry a `note` that the projector merges into the tool message content (`packages/agent-core-v2/src/agent/contextProjector/projection.ts:338-352`):

| Producer | Text | Line |
| --- | --- | --- |
| Read footer | `<system><line/page/truncation status></system>` | `packages/agent-core-v2/src/agent/tools/os/read/readTool.ts:540` |
| SSH host | `<system>host: <id></system>` appended to the note | `packages/agent-core-v2/src/agent/tools/os/sshToolTarget.ts:49` |
| Media read | `<system><media note></system>` | `packages/agent-core-v2/src/agent/tools/read-media-file/readMediaFileTool.ts:142` |
| Failed / empty tool output | `<system>ERROR: Tool execution failed.</system>`, `<system>Tool output is empty.</system>`, or the combined form | `packages/agent-core-v2/src/agent/contextMemory/toolResultRender.ts:3-6` |

### 6.2 `AgentRun` result decorations

- `Standing directives in effect: <directives>` — appended to the `AgentRun` tool result when TodoList notes carry directives, or when session memory has `feedback` entries (`<id> <title>` joined by `; `). Capped at 300 characters, at most 3 echoes per context-window epoch, reset when the epoch changes (`packages/agent-core-v2/src/agent/tools/agent/agentTool.ts:287-306`). Tests: `packages/agent-core-v2/test/session/dispatch/parity.test.ts:1256-1282`.
- `main_profile_notice: "<profile>" is a main-agent profile running as a subagent here. …` — once per profile name (`packages/agent-core-v2/src/agent/tools/agent/agent.ts:112-114`, `packages/agent-core-v2/src/agent/tools/agent/agentTool.ts:348-356`).

These are the only injections that land in the *tool result* the parent model reads.

## 7. External harnesses

### 7.1 Harness hooks

For `claude*`, `codex*`, `antigravity*`, and `grok*` executors, Kiki installs a context hook that posts to `/api/klient/delegation/context/hook` and writes the response back as `hookSpecificOutput.additionalContext` (or `injectSteps` for Antigravity) (`packages/kap-server/src/mcp/harnessHooks.ts:28-45`, `:54-107`). Hook events: `SessionStart`, `UserPromptSubmit`, `PreCompact` for Claude/Codex; `PreInvocation` for Antigravity; a `Stop` callback for Grok (`:67-68`, `:58-61`).

The host side (`packages/kap-server/src/procedures/contextHost.ts:25-72`) builds the payload from Kiki state and prefixes each block:

- `[Kiki memory]` — the same `<memory>` text used in the system prompt.
- `[Kiki injection:<variant>]` — every injection appended since the last assistant message, up to 16 blocks and 8 KB (`packages/agent-core-v2/src/agent/execution/externalPromptHints.ts:12-38`).
- `[Kiki goal_state]`, `[Kiki todo_state]` — goal snapshot (≤1536 bytes) and working notes/todo list (8 KB shared budget) (`packages/agent-core-v2/src/agent/execution/externalPromptHints.ts:56-88`).
- `[Kiki handoff]` — on `PreCompact`/`PostCompact`: `Preserve the current goal, working notes, constraints, decisions, and next action in the compaction handoff. …` (`packages/kap-server/src/procedures/contextHost.ts:56-58`).

Dedupe is by content hash per seat, cleared on compaction recovery; the text is also appended to the Kiki context memory with origin `{kind:'hook_result', event: 'kiki:<harness>:<event>'}` so the two sides stay consistent (`packages/kap-server/src/procedures/contextHost.ts:60-71`). Gated by the profile's `kiki_context` list containing `hooks` (`packages/kap-server/src/procedures/contextHost.ts:40`).

### 7.2 External executor prompt

Profiles whose `executor` is not `native` render their prompt through `renderExternalPrompt`, honoring `executor_prompt` `delivery` (`append` | `replace` | `preamble`) and `include` (`agents_md`, `memory_snapshot`, `skill_catalog`, `workspace_info`, `system.*`, `delegation.*`) (`packages/agent-profiles/src/executorPrompt.ts:3-34`, `packages/agent-core-v2/src/agent/profile/externalPrompt.ts:17`).

### 7.3 External hook results

`features/externalHooks` appends `hook_result` messages for `UserPromptSubmit` results (blocking results as assistant messages, appended results as user messages) (`packages/agent-core-v2/src/features/externalHooks/agent/agentExternalHooksService.ts:355-386`) and `stop_hook` user messages that force a continuation (`:245-262`).

## Measured frequencies

Source: `~/.kiki/sessions/wd_easyagent_8e4e4acd13e0/session_5f8f0029-fbb8-4844-a4d9-b982734611c8/agents/main/wire.jsonl` — the main-agent wire of one long-lived control session, 198,775,385 bytes, 30,628 JSONL records, 2026-09-27T16:25Z → 2026-09-30T18:27Z. Scan script: `.tmp/injection-stats.mjs` (worktree scratch, not committed).

### What the wire records

| Record | Meaning |
| --- | --- |
| `turn.prompt` | A turn's input plus its `origin` — this is where forwarded messages are distinguishable from typed ones |
| `context.append_message` | Every message appended to agent context, including injections, with `message.origin` |
| `llm.request` | Per-request metadata: `systemPrompt` (full text), `systemPromptHash`, `toolsHash`, `messageCount` — but **no message array** |

An injection is identified by `origin.kind === 'injection'` and classified by `origin.variant`. Note that `llm.request` records only the system prompt, so message-level injections can only be counted from `context.append_message`.

### Real user turns vs forwarded messages

`turn.prompt` origin distribution over the whole session (631 turns):

| Origin | Count | Note |
| --- | --- | --- |
| `user` | 215 | Actually typed by the user |
| `task` (completed 224, failed 14, timed_out 2, killed 2) | 242 | Background-task notifications (§4.1) |
| `agent_message` | 169 | Subagent → parent messages (§4.2) |
| `peer_thread` | 5 | Thread-to-thread messages (§4.3) |

So 66% of the turns in this session were not user-initiated. A per-turn injection rate computed over *all* turns would understate the load on user turns by roughly 3×.

### Injection counts, last 200 real user turns

Window: the 200 most recent `turn.prompt` records whose origin is `user` (turn ids 27–630). Total injections in the window: **293, i.e. 1.47 per real user turn**; 122 of the 200 turns had at least one injection.

| Variant | In window | Per real user turn | Whole session |
| --- | --- | --- | --- |
| `todo_list_reminder` T0 (TodoList not updated) | 182 | 0.91 | 194 |
| `todo_list_reminder` T1 (working notes stale) | 42 | 0.21 | 42 |
| `background_task_status` | 13 | 0.07 | 13 |
| `agent_profile_changes` | 12 | 0.06 | 12 |
| `loadable-tools` | 9 | 0.04 | 9 |
| `todo_list_reminder` T2 (window renewing) | 9 | 0.04 | 9 |
| `image_compression` | 7 | 0.04 | 8 |
| `todo_list_reminder` E1 (directive cue) | 6 | 0.03 | 6 |
| `dynamic_tool_schema` | 5 | 0.03 | 5 |
| `plugin_session_start` | 4 | 0.02 | 4 |
| `date_change` | 3 | 0.01 | 3 |
| `todo_list_reminder` E2 (history cue) | 1 | 0.01 | 1 |

Classes registered in code that produced **no** records in this session: `P1`, `interruption`, `message_delivery`, `plan_mode`, `permission_mode`, `goal*`, `capabilities_rebuilt`, `profile_capabilities_changed`, `plugin_change`, `agents_md`, `model_steering`, `init`, `btw`, `room_joined`, `room_left`. Several are simply not exercised in a native-executor session without `/goal`, plan mode, rooms, or external harnesses; the TodoList family is the only one that fires on ordinary work.

One further origin reaches the message stream without an `injection` variant: `skill_activation` (4 records, §4.9). `plugin_command` produced no records in this session.

Two thirds of the injection load is the single T0 reminder. Because `TodoListReminderTracker` counts *assistant messages* rather than user turns, a session with long agentic turns fires T0 whenever ≥10 assistant messages have passed since the last TodoList write and the reminder spacing has elapsed — which is nearly every user turn.

### System-prompt level

| Measurement | Value |
| --- | --- |
| `llm.request` records | 3,056 (`loop` 3,036, `compaction` 20) |
| Distinct `systemPromptHash` | 38 over 3,056 requests |
| Requests whose system prompt contained `<memory>` | 1,519 (50%) |
| Requests whose system prompt contained the Skills section | 1,881 (62%) |
| Requests containing the `AGENTS.md` block | 1,881 (62%) |
| Requests containing plugin instructions or additional-directory sections | 0 |

The 38 distinct system prompts mean the cached prefix was rewritten at least 37 times. Among the causes visible in the wire are the memory snapshot changing, capability rebuilds, and compaction (which re-anchors the prompt).

### E1 (directive-cue) reminder audit

Only 6 E1 reminders fired in the whole session, all between 2026-09-30T18:06Z and 18:20Z (turns 621–627). Their text is *not* the template at code HEAD — the runtime that produced them used the older wording `The user's latest input may set a standing instruction. … If it should hold in future sessions too, MemoryWrite type=feedback. Otherwise ignore.` versus HEAD's `… may set, change, or revoke a standing instruction. … replace any older value it changes. If it should hold in future sessions too, MemoryWrite type=feedback now; if it changes a saved entry, update, supersede, or archive that entry instead of adding one. …` (`packages/agent-core-v2/src/session/todo/todoListReminder.ts:94`). The counts above therefore describe the runtime in use at the time, not the current build.

Each trigger, with the input it was evaluated against and the cue that plausibly matched (cue list at HEAD, `packages/agent-core-v2/src/session/todo/directiveCues.ts:7-10`):

| # | Time (UTC) | Triggering input (60 chars) | Reminder | Matched cue | Genuine standing instruction? |
| --- | --- | --- | --- | --- | --- |
| 1 | 18:06:04 | 继续，刚刚windows充其量，可能需要resume；然后试玩副本你看看是不是可以合并以后让我一起试玩 | E1 | `以后` (inside `合并以后`, "after merging") | No — temporal conjunction, not a directive |
| 2 | 18:10:14 | 时间线里面subagent的subagent，如果是之前就已经完成的默认会被折叠，不然会冒出来一大堆 | E1 + E2 | `默认` / `之前` | No — describes desired UI folding behavior; a product change request, not a rule for the agent |
| 3 | 18:11:43 | Message from agent "mailbox_timeout" (agent-420): 现场只读取证已排除当前死 PID lock … 不要清理这些文件。 | E1 | `不要` | No — not user input at all; a subagent report with an incident-scoped prohibition |
| 4 | 18:13:11 | …本机的claude你帮我配置一下，凭证用kiki的axon message，模型统一用minimax m3.1 flash，我来试试效果 | E1 | `统一` | Yes — a concrete configuration decision that outlives the step |
| 5 | 18:18:32 | …话说我们要不把我们的注入行为到底有哪些、我们希望的注入时机给放到文档里面吧，这个可能需要explore/worker来做 | E1 | `应该` (in `应该怎么设计`) | No — a question/discussion about a future task |
| 6 | 18:20:18 | Message from agent "mailbox_timeout" (agent-420): 隔离 store 副本+伪造死PID … 不能把HEAD回填现象直接当线上根因。 | E1 | `直接` | No — a subagent report; the cue appears in ordinary prose |

Summary of this audit: 1 of 6 triggers corresponded to a real instruction (17%); 2 of 6 fired on forwarded subagent messages rather than user input; 3 of 6 matched a cue inside an unrelated word or a rhetorical question. All six came from a 14-minute window, so the sample is small — the numbers characterize this session, not the mechanism.
