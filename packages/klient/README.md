# @kiki/klient

Contract-driven client SDK for the agent-core-v2 engine. One facade, three
transports — you pick the transport **once** at creation; everything after
that is byte-identical:

```ts
import { bootstrap, ISessionIndex, logSeed, resolveLoggingConfig } from '@kiki/agent-core-v2';
import { createKlient } from '@kiki/klient/memory';

const { app } = bootstrap({
  homeDir,
  clientIdentity: { productName: 'example-client', version: '1.0.0', platform: process.platform },
}, [...logSeed(resolveLoggingConfig({ homeDir, env: process.env }))]);
const klient = createKlient({ scope: app });
try {
  await app.accessor.get(ISessionIndex).prepare();
  const session = await klient.global.sessions.create({ workDir: process.cwd() });
  const agent = klient.session(session.id).agent('main');
  const output = agent.events.on('assistant.delta', (e) => process.stdout.write(e.delta));
  try {
    await output.ready;
    const receipt = await agent.prompt(
      { input: [{ type: 'text', text: 'Say OK.' }] },
      { waitFor: 'terminal' },
    );
    console.log(receipt.state);
  } finally {
    output.dispose();
    await klient.session(session.id).close();
  }
} finally {
  await klient.close();
  app.dispose();
}
```

## Architecture

```
facade (klient.global.*, klient.session(id).*, session.agent(id).*, *.events.*)
   ↓ single-object params, zod-validated
contract (procedure schemas, shared by all transports)
   ↓
KlientChannel { call, stream, listen }   ← the only transport SPI
   ↓
http │ ipc │ memory
```

- **Facade** — aggregated methods, no engine service tokens, no
  `onDid*`/`onWill*` event names. There is no escape hatch to raw services:
  the facade is the public contract.
  - `klient.global.*` — `sessions.*` (incl. `create`), `workspaces.*`,
    `config.*`, `providers.*`, `models.*`, `catalog.*`, `auth.*`, `flags.*`,
    `plugins.*`, `hostFs.*`, `files.*`, `env()`.
  - `klient.session(id).*` — `get/setTitle/update/status/close/archive/
    restore/fork/createChild`, `approvals.*`, `questions.*`,
    `interactions.*`, `agents()`.
  - `session.agent(id).*` — `prompt/steer/cancel/runShellCommand/
    cancelShellCommand/getModel/setModel/setPermission/getUsage/getContext/
    getPlan*/getTasks*/stopTask/getTaskOutput`.
- **Contract** — every method has a zod input tuple + output schema, validated
  on the client before send / after receive (default on; `validate: false` to
  disable). Validation is sub-µs for typical payloads — cheaper than the JSON
  serialization the wire already pays.
- **Events** — `klient.events.on(...)` for the global bus
  (`config.changed`, `kosong.models.changed`, `session.archived`, …),
  `session(id).events.on('metadata.changed' | 'interactions.changed' |
  'interactions.resolved')`, and `agent(id).events.on('turn.started' |
  'assistant.delta' | 'tool.call.started' | 'prompt.completed' | …)`.
  `events.on` returns a disposable with a `ready` promise for initial source
  attachment. Await it before triggering work whose output you need to capture.
  Delivery remains best-effort, not replay; later disconnects and invalid payloads
  report through `events.onError`. Underlying subscriptions are shared and ref-counted.
  `agent.prompt(input, { waitFor: 'terminal', signal })` waits for that submitted
  prompt's own terminal receipt, including blocked or failed launches, without a
  default request deadline. Abort stops only this wait; use `agent.cancel()` to
  cancel execution. Without `waitFor`, prompt still returns its launch result.
  `session.resume()` preserves archive status; `session.restore()` unarchives.
  For reconstructible state, use `events.observe({ events, read }, listener)`:
  provide a facade read and every event source that can change its result.
  It reads after all sources attach, refreshes after reconnection even without
  a new event, and discards reads invalidated by later events or disconnection.
  A read failure reports through `onError` and stops that observation; create
  a new observation to retry. Dispose the returned handle when leaving the view.
  Use a matching current host: older hosts that acknowledge a subscription
  before attaching it cannot provide this guarantee. This is not a replacement
  for ordered transcript recovery.

`session.status()` reads one authoritative session activity snapshot. Pending
approvals or questions take precedence over running work; failed calls reject
rather than reporting the session as idle.

## Ordered session views

The HTTP transport additionally provides `klient.session(id).view`: `snapshot()`,
`transcript.page({ agentId, beforeTurn?, afterTurn?, pageSize? })`,
`transcript.catchUp({ agentId, since, grade? })`, and `subscribe(input, onSignal)`.
This capability requires the current kap-server host and is not implemented by
memory or IPC; those transports reject view calls rather than substituting
ordinary events.

Read a snapshot, then subscribe with its `{ seq: as_of_seq, epoch }` as
`sessionCursor` and the desired `transcriptGrades`. Keep that durable checkpoint
separate from each agent's transcript cursor. The subscription shares the HTTP
transport's existing authenticated WebSocket, reattaches with the latest
checkpoints, and delivers replay and transcript seeds before `ready`. Advance
checkpoints only after applying the corresponding signals, using
`updateSessionCursor` and `updateTranscriptCursor` on the subscription.

`resyncRequired` invalidates the session checkpoint. A transcript catch-up with
`complete: false` or a changed epoch requires a new baseline, not ordinary-event
replay. Paged responses preserve `coverage`, cursor, and authoritative
`tool_call_count`; an absent count means unknown, not zero. Close the subscription
when leaving the view. `restart()` reconnects the shared socket and therefore
also invalidates ordinary-event observations and in-flight streams.

Malformed view signals produce a payload-free `protocolError` diagnostic instead
of being silently discarded. The first invalid signal is recoverable; another
invalid signal before a valid transcript reset is terminal, including across
resubscription on the same view facade. Consumers must stop automatic recovery
on a terminal error and expose an explicit retry action.

### Session commands

`session(id).commands` exposes named read, submit, edit, regenerate, fork, abort,
replace, steer, approve, answer, dismiss, and cancelTask methods. GUI and daemon
TUI session controllers use the same session-core adapter for these methods.
This capability currently projects the existing `/api/v1/sessions` HTTP routes;
it does not create another session store or retire all legacy endpoints. Memory
and IPC reject these HTTP-only commands rather than silently emulating them.
Inputs and outputs reuse the protocol schemas. Submission waits without the
generic HTTP deadline; other commands use the normal request deadline.

## Agent panel and task board

`global.agentPanel.read(query, options?)` reads the whitelisted draft or live
agent capability projection. KAP seeds the host service with the same business
function used by the existing agent capability route; this does not expose raw
services, credentials, or dynamic system prompts. Unknown metric values remain
`null`. Other hosts must supply `IAgentPanelService` from the host entry point.

`global.board.read(input)` and `global.board.write(input)` use the normal
contract dispatcher and the host's `ITaskBoardService` on HTTP, IPC, and memory.
Board input bounds mirror the engine contract. Card references retain their
original workspace, storage root, storage identity, and revision; changing the
storage configuration does not rewrite these references.

The KAP host bundles the pinned local Own Work candidate from
`vendor/own-work-0.1.1-kiki-05c3e1ae.tgz`; registry Own Work 0.1.1 does not provide
the required API and is not an equivalent replacement. `taskBoardHost.ts`
validates registered workspaces, holds real workspace leases around native
operations, and requires workspace trust for writes. Current configured and
derived roots are authorized independently of client card addresses. Successful
operations retain a small atomic per-workspace root/canonical-path binding under
`task-board-authorizations`, so original fixed-root card references remain usable
after configuration changes and restart. Changed symlink targets are rejected.
Previews do not initialize storage or persist authorization; an unsaved preview
selection does not authorize creation. Hosts may override `ITaskBoardService`
through `ServerStartOptions.seeds`. Native persistence is covered by the isolated
real-HTTP taskBoardHost integration test, separately from mock transport tests.

GUI owners can pass `klient.global.board` directly as `TaskBoardContainer.client`
or use `read({action:'preview', workspaceId, configuration})` for settings.
Supply an explicitly authorized workspace list; do not infer authorization from
a card's storage root.

## Transports

| entry | options | events |
|---|---|---|
| `@kiki/klient/http` | `{ endpoint, token, fetch?, WebSocket? }` | authenticated `/api/klient/events` WebSocket |
| `@kiki/klient/ipc` | `{ socketPath, token? }` | same socket |
| `@kiki/klient/memory` | `{ scope }` (a bootstrapped engine app scope) | direct emitter/bus subscription |

All three transports use the same dispatcher contract and JSON frame codec.
The memory transport JSON-round-trips values in process, kap-server hosts the
HTTP projection, and the IPC host ships as `serveKlientIpc({ scope, socketPath })`.

The same conformance suite runs against all three transports in this package's
tests (`test/helpers/conformance.ts` — one test file per transport).

`global.mcp.completeAuth(input, { signal })` cancels only that caller's wait when
the signal aborts; it does not cancel the shared authorization flow. Use
`global.mcp.cancelAuth({ flowId })` to cancel the flow itself. Memory passes the
signal in-process; current IPC and HTTP hosts propagate cancellation to the
engine wait, including when the connection closes. Signals are call metadata,
not serialized procedure arguments.

This package also hosts the e2e suites (the retired `server-e2e` package was
folded in here):

- `test/e2e/legacy/` + `test/e2e/harness/` — the legacy `/api/v1` live suites
  and their client harness (skip unless `KIKI_SERVER_URL` is set; the v1
  surface has no in-memory equivalent, so these stay live-server-only).

The docker e2e runner (`pnpm docker:e2e`) runs this whole vitest suite inside
a container against a container-local server. See `AGENTS.md` for the testing
rules.

## Scope

The facade covers the global (app), session, and agent surfaces shown above,
including file save/get/delete with bytes encoded across the JSON boundary.
It deliberately leaves out onWill/hook-style interception (engine hooks are
in-process `OrderedHookSlot`s and not wire-exposable) and the PTY terminal
surface, which remains on the legacy REST + WebSocket API.

## Smoke check

```sh
pnpm -C packages/klient smoke
```

`examples/smoke.ts` boots an in-process engine (memory transport) and asserts
the `global` facade end-to-end — no server needed. `examples/basic.ts` is a
shorter narrated tour; `examples/context-usage.ts` traces context-size
readings through a real prompt (requires `KIKI_EXAMPLE_MODEL` +
`KIKI_EXAMPLE_API_KEY`).
