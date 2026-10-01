# External hooks: declarative v2

The `externalHooks` Feature owns both configuration shapes. Arrays retain the legacy shell runner, regex matching, seconds-based timeout, command deduplication, parallel execution, and legacy output consumption. Version 2 is explicitly selected with `schema_version = 2`; it currently supports only `inject` and `observe`. Command, gate, block, and continue rules fail schema validation rather than reaching the legacy runner.

User-facing configuration and examples live in [Hooks](../../../docs/en/customization/hooks.md#declarative-rules-v2) and its [Chinese view](../../../docs/zh/customization/hooks.md#声明式规则v2). These v2 contracts are Kiki-only additions; the legacy runner is inherited and unchanged. This is declarative slice A, not script-automation slice B.

## Ownership and extension seams

```text
externalHooks
├─ App: IHookRulesRegistry
│  ├─ consumes user config and enabled plugin declarations
│  ├─ resolves aliases, text files, budgets, diagnostics and watched paths
│  └─ publishes immutable snapshots; stores no agent/session clock maps
├─ Program generation → Session: ISessionHookWorkspace seed
│  └─ leased runtime filesystem/path/watch + generation-owned workspace trust
├─ Session: IHookRulesSession
│  ├─ loads .kiki/hooks.toml on that runtime, never a guessed local filesystem
│  ├─ combines sources; applies user disables and immediate trust revocation
│  └─ exposes metadata-only onDidObserve
└─ Agent: IAgentHookRules
   ├─ effective binding, event bridges, source-labelled injection providers
   ├─ externalHooks.clock replayable world-time state
   └─ inspect() + hooks-inspect contributed command → hook.result
```

`internal/rules.ts` owns the typed matcher and A action schema. `internal/loadRules.ts` owns source-qualified IDs, bounded file resolution and load diagnostics. Fields combine with AND; values within a field combine with OR. Model selectors compile to model configuration identities, not provider model names. Evaluation sorts by ascending priority and qualified ID. Text-only project rules still require workspace trust. Includes inherit their source namespace and enable/trust ceiling; project/plugin disables cannot target another namespace.

Sources reload on config/model/plugin changes and declared-file watch events. A current event evaluates one snapshot. Missing or invalid declarations are diagnosed before cadence evaluation. File watches are limited to actual declaration/include/text paths, including missing references; session disposal releases them while the retained Program generation keeps runtime resources alive.

## Logical completion and durable receipts

`BeforeStepContext.step` remains the engine's budget clock. `stepId` identifies the raw attempt; `logicalStepId` is stable across retries of the same driver; `attempt` is separate. No hooks cadence takes the raw step modulo N.

At step head, `HookRulesConfigured` establishes semantic revisions and `HookStepPrepared` captures raw/logical identity, model partition, turn, and matched cadence targets with their semantic revision. The existing successful `ContextAppendLoopEvent(step.end)` increments the hook clock in the same durable fact as completion. Error, interrupted, filtered and uncommitted steps do not count. Multiple tools still produce one completion. A target from an obsolete semantic revision cannot increment its replacement.

Per-rule buckets contain completed count, last delivered milestone, and last committed logical/event identity. Agent-scope buckets survive turn boundaries; turn-scope buckets are discarded at the next turn, so their size does not grow with session age. Rule matcher/cadence/action-kind changes create a fresh semantic revision and zero counters. Text/priority/enabled changes preserve counters. Returning to a previously used semantic hash still creates a fresh revision, not resurrection of its old clock.

A due reminder is evaluated only while the native step-head injector chain is active, after ordinary state/capability and steering projections. Idle reconciliation and restore cannot project stale step reminders. Each rule gets an independent `hook_rule/<qualified-id>` provider. Its origin disclosure carries the idempotency key:

`hook_id + semantic_revision + agent_id + model_partition (including turn for turn scope) + milestone`.

The receipt folds from the same `ContextAppendMessage` record that commits the actual injection. Failed append does not consume the milestone, and a crash between append and a separate receipt write cannot occur because there is no separate receipt write. Observation receipts use `HookObserved` without carrying user/model content. The clock is deliberately not `.undoable()`: context clear, compaction, undo and replay only reconstruct world-time state; they do not re-run subscriptions or replay delivered reminders.

## Event support and inspection

`prompt.submit` and `step.before` accept injection or observation. `session.start`, `step.after`, `tool.before`, `tool.after`, `turn.stopping` and `turn.after` accept observation only. Prompt injection is attached to the host message ID and runs only after existing submit hooks accept the operation. Legacy tool gates and stop continuation retain their old path. Native step/tool rules inspect as unsupported on external executors rather than guessing steps from tool counts.

`IAgentHookRules.inspect()` exposes source, inactive/invalid reasons, order, binding, clock, semantic revision, completed count and next due count. `hooks-inspect` is available through the existing contributed-command API (`agentCommandService.run`, also klient `agent.runCommand`) and publishes `hook.result` diagnostics without adding model context. It is not a new GUI settings surface or standalone CLI subcommand.

## Verification and generated integration

Claim-matched contracts live in `test/features/externalHooks/rules.test.ts`, with legacy compatibility in `externalHooksRunner.test.ts` and plugin schema cases in `test/app/plugin/manifest.test.ts`. They exercise real Agent services/dispatcher/injector, source loading, retry/completion, milestones, model partitions, separate subagent identities, multi-tool completion, restore, compaction, undo and append failure. The feature assembly test verifies registration and retraction of all three lifetimes.

The integration owner must regenerate config, wire, state, and API-surface projections in the same final candidate. New durable records are `hook.rules.configured`, `hook.step.prepared`, and `hook.observed`; the new replayable state is `externalHooks.clock`. Business code uses the existing dispatcher/Store path and creates no hook database or delivery queue. No changeset or projection is generated by the slice owner when the coordinating task reserves those artifacts.
