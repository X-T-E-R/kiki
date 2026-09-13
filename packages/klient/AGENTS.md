# klient Agent Guide

Package-local rules for `packages/klient`.

## Architecture

The package is layered; keep the layers strict when changing code:

- **Facade** (`src/core/facade/`, `src/core/klient.ts`) — the only public API:
  aggregated `global.*` / `session(id).*` / `session(id).agent(id).*` methods
  and their `events.*` hubs. No engine service tokens, no `onDid*`/`onWill*`
  names, and **no escape hatch to raw services** — do not reintroduce a
  service locator (`core()`/`service()`/`makeProxy`).
- **Contract** (`src/contract/`) — zod input/output schemas for every wire
  method plus event payload schemas. Schemas are hand-mirrored from
  agent-core-v2 types and pinned by the compile-time parity assertions in
  `test/contract-parity.ts`; when the engine types change, tsc fails here
  first. `maybe()`/`noResult()` in `src/contract/helpers.ts` encode the HTTP
  wire's `null`-vs-`undefined` semantics — use them for every
  `X | undefined` / `void` result.
- **Transports** (`src/transports/{http,ipc,memory}`) implement the
  `KlientChannel` SPI (`src/core/channel.ts`). IPC uses NDJSON over a local
  socket; HTTP uses calls plus WebSocket subscriptions. Both share the
  in-process contract dispatcher with memory, which JSON round-trips values.
  Subscription readiness must acknowledge completed source attachment, not
  merely receipt of the request. Per-call cancellation is transport metadata,
  never serialized into procedure arguments. MCP authorization completion
  forwards it to the engine waiter; aborting a waiter must not cancel the
  shared authorization flow. IPC hosts also abort pending calls on disconnect.

`session.status()` maps one engine `ISessionActivityView` snapshot; do not
reconstruct session activity by probing agents or treat transport errors as idle.
Lifecycle facade calls preserve explicit create/fork IDs and historical fork
boundaries. `resume` preserves archive state; `restore` also unarchives. SDK
adapters may shape replay and wire host events, but delegate these operations.
`events.on` returns a disposable with `ready`, acknowledging initial source
attachment. Attach output collectors and await readiness before submitting a
prompt; use `agent.prompt(input, { waitFor: 'terminal' })` for its own authoritative
terminal receipt. Aborting that call stops only the waiter, not the prompt.
`events.on` remains best-effort event delivery after attachment. Use `events.observe` for
reconstructible state: subscribe to every source affecting the supplied read,
wait for attachment, and discard reads invalidated by events or disconnection.
This guarantee requires a host that acknowledges actual attachment; older hosts
that acknowledge receipt cannot provide it. A current read failure reports through
`onError` and stops the observation; callers must create a new observation to retry.
Do not replace transcript's ordered recovery protocol with ordinary events.

`session(id).view` is an HTTP-only ordered read/subscription capability backed
by kap-server's transcript service and durable event journal. It shares the
HTTP event socket but keeps session and per-agent transcript checkpoints
independent. `ready` follows replay and transcript seeding; a restart also
invalidates ordinary subscriptions and streams on the shared socket. Memory
and IPC currently reject view calls; never silently replace them with events.
See the README's Ordered session views section for the recovery contract.

The procedure facade covers services that behave identically on all transports
(the in-process dispatcher mirrors the server's scope resolution, including
`main`-agent materialization via `ensureMainAgent`). onWill/hook-style
interception is not wire-exposable
(engine hooks are in-process `OrderedHookSlot`s). `klient.terminal` is an optional
HTTP-only PTY capability: lifecycle uses the host's existing REST routes, while
attach/input/resize/output share `/api/klient/events` with events and session views.
The shared socket owns reconnect and heartbeat liveness; terminal checkpoints stay
per session/terminal, attach readiness follows replay, and reconnect failures emit
`unavailable`. Memory and IPC explicitly reject terminal operations. GUI owns no
socket implementation. Host exposure/auth gates remain mandatory, and terminal
IDs never grant access outside their session. File upload IS on the facade
(`global.files`): bytes cross the wire base64-encoded and the dispatcher
adapts the engine's `IFileService` streams in both directions.

`klient.rest` groups the remaining typed HTTP-only KAP operations under the
unified `/api` routes. It is not an arbitrary URL escape hatch or a promise of
memory/IPC parity. Authentication, error envelopes, cancellation, and deadlines
stay in the HTTP transport; deadlines cover response-body consumption, not only
headers. Successful binary downloads preserve their bytes even for JSON files;
only endpoints explicitly expecting an envelope inspect a successful JSON body.

## Testing

- One shared conformance suite (`test/helpers/conformance.ts`) runs unchanged
  against every transport — one test file per transport under `test/`. Add
  new **global** facade coverage there, not per-transport.
- `test/e2e/legacy/` + `test/e2e/harness/` — live HTTP suites moved from
  server-e2e. They use the current `/api` routes and skip unless
  `KIKI_SERVER_URL` points at a running server. Preserve their user-behavior
  assertions when retiring routes; the directory name does not authorize old
  version aliases. HTTP-only capabilities stay live-server-only.
- The retired `scenarios/` scripts were rewritten as suites: image-upload
  and terminal coverage lives in `test/e2e/legacy/`.

## Observability (inherited from server-e2e)

- Keep observability inside each e2e case; every live case prints structured,
  case-scoped details (requests, envelopes, WS handshakes, terminal frames,
  error envelopes) through the shared logger in `test/e2e/legacy/log.ts`,
  not ad hoc `console.log`.
- Logs must stay visible for passing Vitest cases — write through stdout.
- When adding or changing an e2e case, update its observability at the same
  time; do not add a scenario solely to print data an existing case should
  already expose.

## Command reference

- `pnpm --filter @kiki/klient test` — all Vitest suites (unit +
  conformance + e2e; live cases skip without their env).
- `KIKI_SERVER_URL=http://127.0.0.1:58627 pnpm --filter @kiki/klient test`
  — include the live legacy cases against a running server.
- `pnpm --filter @kiki/klient docker:e2e` — docker e2e; the run
  derives its runner name/namespace from the current workspace to avoid
  cross-workspace conflicts.
- `pnpm --filter @kiki/klient typecheck` / `pnpm smoke` (in-process
  smoke over the memory transport; see `examples/smoke.ts`).
- `pnpm --filter @kiki/klient smoke:boundary` — ModelRequester boundary
  probe: pings every model configured in the real `~/.kiki/config.toml`
  through the in-process engine, then drives deterministic failure modes
  against a local stub to show which errors the ChatProvider layer wraps and
  which the requester owns (see `examples/model-requester-boundary.ts`).
- `pnpm --filter @kiki/klient smoke:select-tools` — SelectTools
  (progressive tool disclosure) probe for kimi-type providers: stub-verifies
  the kimi-only wire encoding of dynamic tool declarations, then runs a live
  two-step select→use flow per real kimi model (see
  `examples/kimi-select-tools.ts`).
