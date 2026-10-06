# transcript Agent Guide

The isomorphic transcript rendering data layer — agent-granular L1 store, idempotent L2 operations, `off/turn/block/delta` L3 subscription granularity, framework-free L4 view registry, and turn-cursor pagination. Pure TypeScript (browser-safe, no engine imports) and the sole owner of all transcript contract types (`src/contract/`); consumed by `packages/kap-server` (engine events → transcript, REST + WS surface; live stores backfill history from the persisted per-agent wire records — main on first attach, any agent on demand, cold sessions rebuild any agent — with 0-based turn ordinals matching the engine's).

## Comment conventions

No comments — no file headers, no section banners, no statement-level narration; the code is the source of truth. The only exception is JSDoc attached to exported symbols (it flows into the generated `.d.ts` and IDE hover). Lint-suppression directives (`oxlint-disable` / `eslint-disable`) are allowed where they suppress an active rule for a deliberate pattern; other tooling directives (`@ts-expect-error`, `@ts-ignore`, …) stay banned — fix the underlying type problem instead. Enforced by `scripts/check-no-comments.mjs` (part of `pnpm lint`).

## Cold rebuild

The cold rebuild replays `wire.jsonl` through `TranscriptWireAdapter` and `TranscriptFactReducer`, the same durable fact path used by live binding. Context, turns, tasks, interactions, todos, goal/plan meta, markers, and taskrefs converge through the canonical store; interactions left pending at shutdown become `cancelled` when the adapter finishes. `profile.bind` and `config.update` track the effective model alias per agent; only alias changes produce a `model.switch` marker with a compact `{from, to}` payload, never the full configuration. Canonical `agent.model_switch` records retain their operation identity and journal semantics; their projected `change` distinguishes alias changes, effort changes, context rebuilds and unchanged resumes. The adapter checkpoint retains the effective alias, effort and operation classifications for appended tails. These markers appear after wire backfill, not through a new live configuration broadcast.

`full_compaction.begin/cancel/complete` and `context.apply_compaction` project through one lifecycle owner in live binding and cold replay. A queued manual intent is separate from an automatic run, and its running/committed states upsert the same marker. Only `context.apply_compaction` confirms success; finishing a cold replay marks unfinished operations interrupted, while live attachment restores their pre-finalization checkpoint state. New cancel records retain an optional failure reason; old cancel records cannot distinguish failure from cancellation. Projection checkpoints written before this lifecycle must be invalidated by the server owner; never rewrite source wire records.

## Plan content

Plan content is a recorded fact too: each ExitPlanMode review submission offloads the document to `agents/<agentId>/plan/<planId>/v<N>.md` and persists a reference-only `plan.revision` record (`{id, version, path, sha256, bytes}`), which projects — live and cold — to a `plan.revision` marker and the `modes.plan` badge (`{reviewPath, version}`).

## Op-batch sequencing contract

Owned here by `TranscriptCursor` and the schemas in `contract/schema.ts`: each session-agent journal has an epoch and a monotonic operation-batch sequence. `transcript.reset` carries `cursor`; `transcript.ops` carries `cursor` and `through_seq`; REST transcript responses carry optional `cursor` plus required `coverage`; catch-up responses carry required `epoch`, `batches`, `through_seq`, and `complete`. Numeric `transcript_since` input remains accepted and normalizes to `{ epoch: undefined, seq }`.

## Wire-level detail

Beyond the timeline, the model carries wire-equivalent detail: steps carry `usage` / `finishReason` / `timing` (LLM latencies) / `retry` / interrupt reason, turns carry `durationMs` / `error` / `usage`, tool frames carry the streamed `inputText` and the latest `progress`, tasks carry subagent `resultSummary` / `error` / `stateReason` / `usage`, `meta.agent` mirrors the agent status slices (model / usage / context / permission / phase), a global `prompts` entity (op `prompt.upsert`) tracks the prompt queue, and `hook.result` lands as a `'hook'` marker. Cold rebuild restores terminal turn states and errors, and replays `turn.step.retrying` onto step headers. Finishing a cold replay cancels unfinished turns and interrupts their steps; any retained retry describes the last failed attempt, not an ongoing retry. Other supplemental live-only fields may still be absent from older wire records.

Scheduled queue prompts retain `content`, `originKind: 'cron_job'` and optional `originDeliveryMode` in the canonical `TranscriptPrompt` contract and schema. Replay and live attach preserve these fields through queue moves and lifecycle updates. Client projection uses that content for previews without synthesizing user-message blocks. `queue` mode and previously admitted records with no mode remain ordinary FIFO items; `idle` and `steer` remain readable pending records outside that send order. Missing modes on existing queue records are never defaulted by projection. Other non-user prompt origins remain hidden.
