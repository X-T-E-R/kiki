# transcript Agent Guide

The isomorphic transcript rendering data layer — agent-granular L1 store, idempotent L2 operations, `off/turn/block/delta` L3 subscription granularity, framework-free L4 view registry, and turn-cursor pagination. Pure TypeScript (browser-safe, no engine imports) and the sole owner of all transcript contract types (`src/contract/`); consumed by `packages/kap-server` (engine events → transcript, REST + WS surface; live stores backfill history from the persisted per-agent wire records — main on first attach, any agent on demand, cold sessions rebuild any agent — with 0-based turn ordinals matching the engine's).

## Comment conventions

No comments — no file headers, no section banners, no statement-level narration; the code is the source of truth. The only exception is JSDoc attached to exported symbols (it flows into the generated `.d.ts` and IDE hover). Lint-suppression directives (`oxlint-disable` / `eslint-disable`) are allowed where they suppress an active rule for a deliberate pattern; other tooling directives (`@ts-expect-error`, `@ts-ignore`, …) stay banned — fix the underlying type problem instead. Enforced by `scripts/check-no-comments.mjs` (part of `pnpm lint`).

## Cold rebuild

The cold rebuild replays `wire.jsonl` through `TranscriptWireAdapter` and `TranscriptFactReducer`, the same durable fact path used by live binding. Context, turns, tasks, interactions, todos, goal/plan/swarm meta, markers, and taskrefs converge through the canonical store; interactions left pending at shutdown become `cancelled` when the adapter finishes.

## Plan content

Plan content is a recorded fact too: each ExitPlanMode review submission offloads the document to `agents/<agentId>/plan/<planId>/v<N>.md` and persists a reference-only `plan.revision` record (`{id, version, path, sha256, bytes}`), which projects — live and cold — to a `plan.revision` marker and the `modes.plan` badge (`{reviewPath, version}`).

## Op-batch sequencing contract

Owned here by `TranscriptCursor` and the schemas in `contract/schema.ts`: each session-agent journal has an epoch and a monotonic operation-batch sequence. `transcript.reset` carries `cursor`; `transcript.ops` carries `cursor` and `through_seq`; REST transcript responses carry optional `cursor` plus required `coverage`; catch-up responses carry required `epoch`, `batches`, `through_seq`, and `complete`. Numeric `transcript_since` input remains accepted and normalizes to `{ epoch: undefined, seq }`.

## Wire-level detail

Beyond the timeline, the model carries wire-equivalent detail: steps carry `usage` / `finishReason` / `timing` (LLM latencies) / `retry` / interrupt reason, turns carry `durationMs` / `error` / `usage`, tool frames carry the streamed `inputText` and the latest `progress`, tasks carry subagent `resultSummary` / `error` / `stateReason` / `usage`, `meta.agent` mirrors the agent status slices (model / usage / context / permission / phase), a global `prompts` entity (op `prompt.upsert`) tracks the prompt queue, and `hook.result` lands as a `'hook'` marker. These live-projected fields are NOT backfilled by the cold rebuild (known limitation).
