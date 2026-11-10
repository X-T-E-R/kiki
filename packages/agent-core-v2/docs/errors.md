# errors

> Error infrastructure for agent-core-v2: base classes, the per-domain code
> contract, the public `ErrorCodes` facade, wire serialization, and the
> conventions domains follow when raising errors.

Base classes and serialization are centralized in `_base/errors`; error **codes**
are **decentralized** — each domain owns an `errors.ts` that contributes its
codes and metadata, and the `src/errors.ts` facade aggregates them into the
unified `ErrorCodes` const.

## Where things live

- `src/_base/errors/errors.ts`: base classes — `Error2`, `ExpectedError`, `ErrorNoTelemetry`, `BugIndicatingError`, `NotImplementedError`, plus the `isError2` guard and `unwrapErrorCause`.
- `src/_base/errors/codes.ts`: the `ErrorDomain` contract, the `ErrorCode` type (aliased to the protocol's `KimiErrorCode`), the runtime registry (`registerErrorDomain` / `errorInfo` / `isErrorCode`), and the domain-independent `CoreErrors` (`internal`, `not_implemented`).
- `src/_base/errors/serialize.ts`: `ErrorPayload`, `isCodedError`, `toErrorPayload`, `fromErrorPayload`, `makeErrorPayload`. Reads retryability from the registry via `errorInfo`. The wire-facing names (`KimiErrorPayload`, `toKimiErrorPayload`) mirror the protocol contract and keep their names even though the in-process class is `Error2`.
- `src/_base/errors/errorMessage.ts`: `toErrorMessage(error, verbose?)` for logs/CLI; `toErrorDisplayMessage(error)` adds a validated exhausted-attempt summary for terminal turn errors and task failure strings without changing the original error.
- `src/_base/errors/unexpectedError.ts`: `onUnexpectedError` / `setUnexpectedErrorHandler` / `safelyCallListener`.
- `src/<domain>/errors.ts`: each domain's `XxxErrors` descriptor (codes + retryable list + per-code info overrides), self-registered on import.
- `src/errors.ts`: the **facade** — imports every domain's `errors.ts` (triggering registration), builds the unified `ErrorCodes` const, and re-exports all error primitives. This is the import throw sites use.

## Conventions (hard rules)

- **Throw a coded error, not a bare string.** `throw new Error2(ErrorCodes.X, …)`. `throw new Error('x')` only for unreachable guards; `BugIndicatingError` when the throw site indicates a caller bug (e.g. reading a service before its `ready`); `NotImplementedError('feature')` for stubs.
- **Every domain codes ALL of its failure modes.** This includes errors raised on tool-execution paths whose message is fed back to the model (tool-input validation is a domain failure mode too) — whether a given scope (App / Workspace / Session / Agent) or the model ever sees an error is decided by event-filtered subscriptions, never by the error's type. The uncoded errors left are: `_base` infrastructure errors (DI, event, lifecycle, text, execEnv — deliberately left as plain guards / classes for now), control-flow sentinels that never leave their domain (`UserCancellationError`, `TaskCancelledError`, `TransientCloudError`, `GrepAbortedError`, `ProcessExitError`, `CompactionTruncatedError`), `CyclicDependencyError` (a documented DI wiring protection), and `PathSecurityError` (tool-path validation with its own `PathSecurityCode` taxonomy). The `ChatProviderError` L0 taxonomy is born-coded: every class extends `Error2` and computes its wire code at construction (`kosong/contract/errors.ts`), so `translateProviderError` is only the abort guard plus the foreign-error fallback.
- **Define codes in the owning domain.** A domain's codes live in `<domain>/errors.ts` next to its interfaces, exported as an `XxxErrors` descriptor — never in `_base/errors`.
- **One `code` per failure mode.** Codes read `domain.reason` (e.g. `tool.unknown_tool`). The set of valid code strings is fixed by the protocol (`KimiErrorCode`); adding a brand-new code means updating the protocol first. Renaming/removing a code is a major (breaks SDK clients).
- **Import from the facade.** Throw sites and cross-domain consumers do `import { ErrorCodes, Error2 } from '#/errors'`. A domain's own `errors.ts` references its own descriptor (`LoopErrors.codes.X`) and imports only from `#/_base/errors` (never from `#/errors`, to avoid cycles).
- **Translate foreign errors at the boundary.** Provider/HTTP, fs, MCP errors are caught at the domain boundary and re-thrown as the domain's coded error. `_base/errors` never imports a business domain.
- **Translation is idempotent.** A translator (`toHostFsError`, `toStorageIoError`, …) returns its input unchanged when it is already the domain's error type, so layered boundaries never double-wrap. The original error always goes to `cause`.
- **`details` is structured and JSON-serializable; `message` is a short human sentence.** Paths, errnos, syscalls, scope/key, line numbers go into `details`; the message must stay readable without them.
- **Cancellation passes through untranslated.** A translation boundary that can see a cancellation-class error (`UserCancellationError` from `_base/utils/abort`) rethrows it as-is. fs/process translation never encounters cancellation, so those translators do not check for it — apply the rule only at boundaries that actually can.
- **Keep the original error for recovery decisions.** Generation recovery calls `isRetryableGenerateError(error)` before unwrapping so wrapper and cause-chain facts remain available. Use `unwrapErrorCause(error)` for raw-shape matching (errno, provider status), retry-policy selectors, and diagnostics, not as a replacement input to the recovery classifier.
- **Branch on `code`, never `instanceof`, across the wire.** Class identity does not survive serialization. In-process, `instanceof Error2` / `isCodedError` are fine.

## Provider diagnostics

`kosong/contract/errors.ts` retains received provider error messages and structured diagnostics without a provider or message allowlist. Normalized identifiers remain separate from sanitized `upstreamDetails`: a field that is not represented by a normalized value stays in the diagnostic data. Distinct header and body request IDs are both retained. Existing credential redaction applies before diagnostic details are serialized.

`toErrorPayload` preserves the original error and cause chain. The shared `@kiki/transcript` error projection supplies readable `error` and expandable `errorDetails` for live events and saved history. Presentation can show the specific upstream reason while retaining an outer transport failure in the details; it must not rewrite the original error used by retry, cancellation or execution classification. Replaying older records can expose only diagnostics that were saved in those records.

## Generation retry and thinking-only recovery

`kosong/contract/errors.ts` owns `isRetryableGenerateError(error)`. Step retry passes the original error through this classifier before applying a matching policy. An uncertain delivery mark alone does not forbid a bounded retry; observed output or tool execution, cancellation, an explicit `retry: false`, an explicit upstream boolean `retryable: false`, and non-retryable provider classifications do. A temporary provider error event with no output remains eligible unless a trusted boundary confirms execution or the provider marks the error as non-retryable. `true`, a missing `retryable` field, and any non-boolean value do not create that prohibition and do not clear a local `retry: false`.

Kiki records `upstreamErrorCode: gateway_stream_terminal_error` when a gateway marks an SSE error as final. Messages carries the code in `error.code`. Native Gemini carries the marker in an `error.details` entry whose `@type`, `domain`, and `reason` are exactly `type.googleapis.com/google.rpc.ErrorInfo`, `sub2api.gateway`, and `GATEWAY_STREAM_TERMINAL_ERROR`. Gemini retains the numeric error status and `RetryInfo` delay; an unmarked stream error or an ordinary HTTP error follows its existing classification. The terminal code stops automatic retries even before output and carries no execution claim.

The version-pinned [Google SDK patch](../../../vendor/google-genai-patches/@google__genai@2.29.1.patch) makes both Node entry points surface the parsed SSE error as `ApiError` before the model response conversion drops it. The SDK still owns SSE framing, auth, and its proxy-aware no-timeout transport. When upgrading `@google/genai`, remove the patch once the unpatched version passes the real SDK loopback cases in `test/kosong/provider/composition.test.ts` and the native retry cases in `test/agent/stepRetry/stepRetry.test.ts`.

Google GenAI automatic continuation remains SDK-owned. The provider exposes only complete, non-empty continuation tokens from checkpoints; a later content chunk without a newer token invalidates that token for outer recovery. The requester carries a usable token through the existing model params into the same provider request with the original contents and config. Without a usable token, turn retry keeps visible text and thinking summaries and deduplicates the replayed prefix against the original snapshot. It does not synthesize a signature, terminal event, assistant prefill, or hidden reasoning from visible thinking. Tool-call deltas are retracted on every retained retry, and only a complete final response can execute tools. Cancellation never carries a token into another attempt.

`noteConfirmedRequestExecution` records `request_delivery: executed`, `execution: executed`, and `retry: false` across the cause chain without setting `request_output: observed`. The Responses WebSocket adapter applies it to a structured error's validated top-level `execution: executed`; both ordinary step retry and retractable interruption retry honor that veto, even before output. The delivery guard marks output as observed only when it actually yields output. Translators preserve the error or its `cause`, so recovery does not erase those facts.

An explicit upstream boolean `retryable: false` is stored as `upstream_retryable: false` and does not write `retry: false`. `sameRequestRetryProhibition` names that fact `upstream`. `hasExplicitRetryVeto` checks the original error and its cause chain before requester retries or a forced HTTP 401 auth refresh. Responses WebSocket errors preserve the same prohibition through SDK conversion, HTTP fallback, and full-history resend decisions. Provider-specific error hooks retain it alongside their classification. StopFailure continuation does not treat `upstream` as a refusal to append a new user message.

Both step retry and retractable interruption retry attach `retry: false`, `retry_exhausted: true`, `retry_attempts`, and `retry_max_attempts` when their eligible attempt budget is consumed. Counts include the first request. That fact is `budget`, not `upstream`. Ordinary non-retryable failures and policy vetoes do not acquire exhaustion facts. Exhausting the budget stops further attempts of the same request; it does not by itself forbid a new user message, and a hook cannot add more attempts of the failed request. Other protocols retract a retry's partial output; Google GenAI retains visible text and thinking summaries and retracts the failed attempt's tool-call deltas. The last failed attempt's output remains in context when the budget is exhausted. A local veto remains `retry: false` without `retry_exhausted`, or a code in the non-retryable provider set, or confirmed execution. Continuation allows at most one new user message per consecutive failure streak, resetting that budget only after a completed non-partial model response with usable content or model tool calls, and still refuses that `local` prohibition, authentication, quota, HTTP 429, safety filtering, cancellation, context overflow, and a gateway generic terminal error. The terminal turn payload and task notification strings use `toErrorDisplayMessage`; `toErrorPayload` retains the original message, code, cause, and structured details.

The Responses WebSocket adapter keeps an SDK `error` listener for each socket's entire lifetime, including idle time and closing. Active errors still reach the request's stream. Idle errors close that socket; an error queued after a completed response closes it after the response commits. A trusted, not-executed history miss remains eligible for its existing full-history resend unless it explicitly sets `retryable: false`.

The loop's thinking-only recovery has a separate one-use budget per turn. A successful response needs `completionAuthority: 'normal'`, non-empty thinking, and no answer, tool call, or partial response. The provider adapters withhold that authority for refusals, grounding, and unobserved terminal states. Grounded thinking without an answer fails explicitly; `readGenerateFailureUsage(error)` preserves its known usage independently of continuation eligibility. The error path instead needs the exact trusted `antigravity_thinking_only` provider event, local `readGenerateFailureFacts(error)`, and thinking actually retained by the loop collector. A machine code alone cannot create history or justify resending the original prompt.

`ThinkingOnlyContinuationStepRequest` appends a real `Continue.` user message after the retained thinking, including its original signature. Its provider request uses `retry: 'never'`; any second empty response or failure, including HTTP 429, ends the turn without projection fallback, infinite retry, or step retry. Google models without assistant-prefill support keep their original-snapshot recovery under the same budget and the same second-request restriction. Tool steps do not replenish that budget. `[loop_control] thinking_only_continuation = false` disables the explicit message, not the existing Google snapshot path.

`[loop_control] zero_output_continuation` defaults to false and is separate from that switch. Only an explicit true, and only a normal completion whose think text, visible text, and tool calls are all empty, reuses the same user message and the same one-use turn budget. An encrypted signature on empty thinking text does not count as thinking content and is kept. Non-empty `redacted` thinking data and structured `reasoningDetails` do. Older history that stored redacted data in `encrypted` stays a signature carrier. A child uses the same condition; with the switch off, its empty completion still fails as `loop.empty_completion`, and a second empty completion still fails after the one continuation. Error, cancellation, missing terminal events, and transport retry paths do not read it.

`test/agent/loop/signedThinkContinuation.test.ts` exercises the real Messages SDK through generate, requester, history, usage and loop completion. `test/agent/loop/googleModelTurnContinuation.test.ts` covers both Google continuation paths and their shared budget, overlapping EOF retries, real SDK loopback token encoding, token invalidation after newer output, truncated opaque fields and tool calls, cancellation, and exactly-once tool execution; `test/agent/stepRetry/stepRetry.test.ts` verifies original-error classification and policy precedence.

## Adding a domain error (recipe)

In `<domain>/errors.ts`:

```ts
import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const ToolErrors = {
  codes: {
    UNKNOWN_TOOL: 'tool.unknown_tool',
    EXECUTION_FAILED: 'tool.execution_failed',
  },
  retryable: ['tool.execution_failed'],
  info: {
    'tool.unknown_tool': {
      title: 'Unknown tool',
      retryable: false,
      public: true,
      action: 'Check the tool name passed by the model.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ToolErrors);
```

Then wire it into the facade in `src/errors.ts`: import `ToolErrors`, add
`...ToolErrors.codes` to the `ErrorCodes` spread, and re-export it. The
`satisfies ErrorDomain` guarantees every code value is a protocol-known
`ErrorCode`, and `registerErrorDomain` makes its metadata available to
serialization.

## Domain tiers in practice

The os / persistence / wire domains show the standard shapes:

- **`os.fs` (`HostFsError`, `os/interface/hostFsErrors.ts`)** — every `IHostFileSystem` backend translates raw errnos at its boundary via the pure `toHostFsError(err, { path, op })`: `ENOENT→os.fs.not_found`, `EISDIR→os.fs.is_directory`, `ENOTDIR→os.fs.not_directory`, `EEXIST→os.fs.already_exists`, `EACCES/EPERM→os.fs.permission_denied`, `ENOTEMPTY→os.fs.not_empty`, everything else `os.fs.unknown`. `details` carries `{ path, op, errno?, syscall? }`. Documented boolean semantics (e.g. `createExclusive` returning `false` on `EEXIST`) stay booleans, not errors.
- **`os.process` (`HostProcessError`, `os/interface/hostProcess.ts`)** — `os.process.spawn_failed` (details `{ command, args?, cwd?, errno? }`) and `os.process.kill_failed`; both carry the raw error as `cause`. Kill keeps its deliberate tolerances: `ESRCH` is a silent no-op, `EPERM` degrades to `child.kill()`.
- **`storage` (`StorageError`, `persistence/interface/storage.ts`)** — `storage.not_found` / `decode_failed` / `corrupted` / `io_failed` / `locked` / `permission_denied` / `disk_full`. ENOENT keeps its established absence semantics (`read → undefined`, `list → []`) and is *not* an error; other I/O failures are mapped by errno at the backend boundary via `toStorageIoError`: `EACCES/EPERM→storage.permission_denied`, `ENOSPC→storage.disk_full`, an unexpected `ENOENT→storage.not_found`, everything else `storage.io_failed` (the only retryable one besides `storage.locked`). Codec parse failures become `storage.decode_failed` with `{ scope, key, format }`; append-log corruption is `AppendLogCorruptedError` (`storage.corrupted`). `storage.locked` is reserved for a store exclusively held by another process — consumers (e.g. `FileSessionIndex`) catch it explicitly and fall back to their non-read-model path with a one-time warning; there is no silent no-op degradation. (The minidb query-store backend is a multi-process `ClusterDb` and no longer throws it: peers share the store, and per-shard lock contention surfaces as a transient `LockError` instead.)
- **`wire` (`WireError`, `wire/errors.ts`)** — `wire.unknown_record`: restore skips records whose durable event type is absent from the folded registry (compatibility) and reports each skip through `onUnexpectedError`; `wire.migration_missing` covers journals that predate the migration chain. The sibling `event`/`state` domains own `event.duplicate_event` (a build-time bug), `state.duplicate_fold`, `state.durability_mismatch`, and `CycleError` (`state.cycle`, details carry the drain depth and a capped event-type sample).

## Serialization & boundary translation

- `toErrorPayload(error)`: any coded error (incl. deserialized shapes) → its code + `retryable` from `errorInfo`; anything else → `internal`.
- `fromErrorPayload(payload)`: rehydrates an `Error2` for in-process `instanceof` / `isCodedError` use at the SDK/RPC boundary.
- `isCodedError(error)`: structural guard (checks `code` against the registry), so it works for both `Error2` instances and plain objects revived from a payload.
- The registry is populated when the facade is imported (the package `index.ts` re-exports it); tests that import a single domain get that domain's codes via its self-registration. `errorInfo` falls back to `{ title: code, retryable, public: true }` for any unregistered code.

## References

- `packages/agent-core-v2/src/_base/errors/` — contract, registry, base classes, serialization.
- `packages/agent-core-v2/src/errors.ts` — the aggregating facade.
- `packages/protocol/src/events.ts` — the canonical `KimiErrorCode` wire union.
