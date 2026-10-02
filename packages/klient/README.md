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

Cold views are read-only: `snapshot()` reads indexed metadata and the durable
session watermark without acquiring a runtime lease or replaying an engine.
Transcript reads project only the requested agents; a `turn` wildcard does not
scan every cold agent's wire. When focusing a child, set `main: 'off'` to avoid
reading the main conversation. Cold transcript cursors have a `cold:` epoch and
catch-up returns `complete: false`. Resuming the session upgrades attached cold
views to the live broadcaster and emits `resyncRequired`; read a new shell and
baseline before relying on live checkpoints. Closing or replacing a view cancels
its cold reads. External-process appends are read on refresh or reconnect, not
watched by a cold subscription.

Call `await session.resume()` before runtime commands such as submit,
edit/regenerate, approvals/questions, steer, or task cancellation; do not call it
just to browse. A `false` result means the session is missing, and a rejected
resume must prevent the subsequent command. The GUI/TUI's shared SessionTransport
performs this admission. Direct `session.commands` calls retain their existing
route behavior; in particular, a cold approval/question lookup does not resume.
Already-live sessions and global background activity remain independent of cold
view subscriptions.

Read a snapshot, then subscribe with its `{ seq: as_of_seq, epoch }` as
`sessionCursor` and the desired `transcriptGrades`. Keep that durable checkpoint
separate from each agent's transcript cursor. The subscription shares the HTTP
transport's existing authenticated WebSocket, reattaches with the latest
checkpoints, and delivers replay and transcript seeds before `ready`. Advance
checkpoints only after applying the corresponding signals, using
`updateSessionCursor` and `updateTranscriptCursor` on the subscription. A cursor
covers only the detail grade already applied: omit an agent's `transcriptSince`
when requesting a higher grade. `setTranscriptGrades` removes upgraded cursors,
including those affected by a wildcard upgrade. Wait for the requested baseline
before treating a summary as a complete timeline or issuing detail catch-up.
A new server target requesting `block` or `delta` receives a reset even with a
current cursor; journal-only recovery requires an already-seeded target at a
sufficient grade. Explicit `block`/`delta` targets are seeded before sibling
summaries; `ready` still waits for all admitted agents.

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

## GUI entry contracts

These HTTP-only capabilities use `klient.rest` and the authenticated `/api` REST envelope. They do not promise memory/IPC parity.

### Shortcut preferences

`rest.shortcuts.read(platform)`, `write(platform, preferences)`, and `reset(platform, target?)` map to `GET/PUT /api/gui/shortcuts?platform=…` and `POST /api/gui/shortcuts/reset?platform=…`. The platform is the client's `windows`, `macos`, or `linux`, never inferred from the server host. Writes replace `{ version: 1, overrides: { windows?, macos?, linux? } }`; each platform maps action IDs to at most four `{ key, modifier, shift, alt }` chords. Missing actions use shipped defaults; `[]` disables an action. Reset target `{ platform?, action? }` narrows the reset; `{}` resets everything. Responses contain `{ preferences, bindings, conflicts }`. Invalid input, overlapping chords, reserved keys, and partial resets that introduce a conflict return `40001` without writing; conflict details are in `details.conflicts`. Corrupt saved preferences fail visibly; full reset repairs them. Writes persist under `shortcuts.v1` in the current server home's `gui.toml` via its existing store.

The framework-free catalog and helpers are exported from `@kiki/session-core/settings/shortcuts` (canonical definitions in `@kiki/protocol`). `SHORTCUT_CATALOG` includes remappable actions and fixed interaction keys; `SHORTCUT_DEFINITIONS` contains only remappable actions. `mod` means Ctrl **or** Meta on every platform, preserving existing GUI semantics; display labels differ on macOS. The GUI owner must replace the hard-coded handlers and shortcut overlay with `resolveShortcutBindings`/`matchesShortcut`, retaining route, desktop-only, editable-target, overlay, IME and priority guards. This backend does not attach listeners or change current key behavior. Send/newline remain managed by the existing `sendShortcut`/`composerEnterAction`; layered Escape, text triggers, navigation inside controls, and the native show/hide key are not remapping actions. Reserved-key checks protect those fixed lanes and a small platform-specific OS set; they are not a guarantee that a browser can intercept every chord.

### Models.dev directory and quota

`rest.catalog.list(options?)` → `GET /api/catalog/providers`, `provider(id)` → `GET /api/catalog/providers/{id}`, `importProvider({ catalog_id, id?, api_key?, base_url? }, options?)` → `POST /api/providers:import_catalog`, and `importRegistry({ url, api_key? }, options?)` → `POST /api/providers:import_registry`. List/detail expose `wire_type`, `guessed`, `needs_base_url`, `rejected`, `reject_code`, `reject_reason`, `env_key`, and models. Import is an explicit write: re-import refreshes the target's configuration and aliases; registry re-import may remove providers absent upstream. Imports return `models_imported` and the imported provider(s). Existing default pointers stay unchanged, except a fresh setup may seed a missing default model. Respect rejected entries and collect a base URL when required.

`rest.oauth.usage(provider?, options?)` → `GET /api/oauth/usage?provider=…` returns `{ kind: 'ok', summary, limits, extra_usage }` or `{ kind: 'error', message, status? }`. It is managed-account quota, not local session token usage. Treat `used`/`limit` as provider quota units rather than session token counts; some adapters normalize ratios to a 100-point limit. Render the returned window/reset metadata and handle a zero limit without division. `global.oauth.methods()` also exposes provider sign-in/account/quota summaries. Both use the existing host-managed credential lifecycle.

### Side questions, native tasks and attention

`session(id).btw.start()` returns a side-question agent ID (all transports); REST `POST /api/sessions/{id}:btw` returns `{ agent_id }`. The side agent forks the main context and refuses tool execution. Open its ordinary agent view and submit the question through its prompt API.

Native task baseline reads are `rest.sessions.listTasks(sessionId, { status?, page_size?, offset? })` and `getTask(sessionId, taskId, { with_output?, output_bytes?, agent_id? })`; cancel via `session(id).commands.cancelTask(taskId)`. `session(id).view.snapshot()` carries tasks and task references; its ordered transcript stream publishes `task.upsert`/`taskref.upsert`. Use that recoverable view rather than inventing a second task event lane. List/get/cancel REST paths are `/api/sessions/{id}/tasks`, `/tasks/{task_id}`, and `/tasks/{task_id}:cancel`; already-finished cancellation is `40904`. No global task-list endpoint is promised.

Permissions/questions use the same pending interactions in the session view and `commands.approve`/`answer`. Session work facts (`busy`, `main_turn_active`, `pending_interaction`, `last_turn_reason`) arrive through the existing global `event.session.work_changed`/session view. Framework-free attention classification and rate limiting live in `@kiki/session-core/sessions/awayAttention`; native notification delivery belongs to the host. `rest.notifications` configures outbound notification providers/channels and reads delivery results; it is not an ACP toast inbox.

Standard ACP updates already project into ordinary transcript tool progress, plan/runtime notes, turn failure/completion, and external permission interactions. External harness background-task parity and its capability matrix are owned by the harness integration, not by an invented ACP extension here. The frontend can reuse the native task and attention contracts when that integration supplies the same facts.

### Desktop diagnostics (Tauri)

Invoke `desktop_log_info` for `{ directory, backendLogPath, maxBytes, backups, logLevel, appliesOnNextLaunch }`, and `open_desktop_log_directory` to open the active local space's log directory. `read_desktop_prefs`/`write_desktop_prefs({ prefs: { logLevel } })` persist the level; allowed values are `fatal`, `error`, `warn` (default), `info`, `debug`, `trace`, `silent`. The next desktop-owned backend launch receives it; an attached external daemon is not reconfigured. The current `desktop-backend.log` rotates at 5 MiB with three backups. Browser/remote clients have no local directory-opening equivalent. Add the commands to the GUI host adapter when connecting the controls.

## Conversation list client projection

Room summaries are `global.rooms.listItems()` (all transports) or `rest.rooms.listItems()` (HTTP). The wire fields and lifecycle operations are documented in [Room conversation entries](../../docs/en/server/rest-api.md#room-conversation-entries); `RoomListItem` in `@kiki/protocol` is their canonical schema. Session pagination remains unchanged: merge summaries with the loaded session pages, not into their `before_id` cursor.

The GUI's `useConversationList(sessions, order?, workspaces?)` hook returns `{ items, rooms, roomsQuery, seen }`, polls room summaries every 15 seconds, and invalidates `['rooms']` on the public `room.changed` event. Read `roomsQuery.isError` rather than treating a failed room fetch as a successful empty inventory. Its item union has `kind: 'session' | 'room'`, a collision-free `key`, `id`, `title`, `workspace_id`, `created_at`, `updated_at`, `href`, `last_seq`, `unread_count`, `needs_you`, `failed`, `pinned`, `archived`, and `busy`. A room also has `member_count` and its raw `room` summary; a thread retains its raw `session`. Branch on `kind` before calling lifecycle operations; room rows are not session records.

Pass the registered workspace catalog to `useConversationList(sessions, order, workspaces)`, `mergeConversationItems(sessions, rooms, seen, order, workspaces)`, and `buildConversationInbox(sessions, rooms, seen, workspaces)`. Raw `room.workspace` is a root path used for member creation, not a session workspace ID. Shared `roomWorkspaceId` resolves the room's own ID/root against the catalog; Windows drive/UNC roots match without case or separator differences, while POSIX roots remain case-sensitive. Unregistered roots retain their reference and appear in the ungrouped bucket; no member's workspace is inferred. `groupConversationItems` also resolves room roots before workspace filters, so an initially unloaded catalog cannot misclassify the room later.

Framework-free `mergeConversationItems` / `groupConversationItems` in `@kiki/session-core/sessions` share thread ordering, calendar-time grouping, workspace grouping, pinning, and archive filters. `buildConversationInbox` uses the same read store as threads. Room marks use `room:<id>` keys through `markRoomSeen` / `forgetRoomSeen` / `roomUnreadCount` in `@kiki/session-core/settings`. Only a successfully loaded, visible room log is marked read. Mark-all-read clears finished room items but never dismisses blocked room attention. Renaming, pinning, or archiving does not advance room unread activity.

`roomRefLink(id)` produces `/rooms/<id>`; `parseConversationLink` also accepts `/r/<id>` and `kiki://rooms/<id>` / `kiki://r/<id>` text. The GUI redirects the short route while preserving query and fragment. These are in-app link contracts; no new operating-system protocol registration is provided.

## Local executor sessions (HTTP)

`klient.rest.executors` browses local Claude/Codex history and attaches a selected
vendor session to a Kiki session. These are authenticated HTTP-only methods;
local source IDs (`external:claude:…` / `external:codex:…`) are never Kiki session IDs.
Wire schemas and types live in `@kiki/protocol` (`LocalSessionDirectory`,
`LocalSessionDetail`, `ResumeLocalSessionRequest`, `ResumeLocalSessionResponse`).

| Method | REST route |
|---|---|
| `listLocalSessions(executorId, { limit? }, options?)` | `GET /api/executors/{id}/local-sessions` |
| `getLocalSession(executorId, localSessionId, options?)` | `GET /api/executors/{id}/local-sessions/{local_session_id}` |
| `resumeLocalSession(executorId, localSessionId, body, options?)` | `POST /api/executors/{id}/local-sessions/{local_session_id}/resume` |

Listing accepts `limit` 1–200 (default 100). GETs remain read-only and bounded:
`partial`, `warnings`, `truncated`, and `unreadable_files` are not completeness
claims. A summary includes `source_home` and `resume: { supported, reason? }`;
`resume_enabled` on the directory reflects the experimental gate. Reasons include
`working_directory_missing`, `source_identity_mismatch`, `protocol_unsupported`,
and `engine_resume_unsupported` (an ACP engine negotiated neither resume nor load).

Continuation is enabled by default. Set `KIKI_EXPERIMENTAL_LOCAL_SESSION_RESUME=false`
or `[experimental] local_session_resume = false` on the server to disable new attachments. POST requires
`{ source_home }` copied from the selected summary, with optional `profile`,
`model`, and `thinking`. An explicit profile must already use the selected
executor. Without a profile, Kiki adapts the workspace's default profile to that
executor, leaving model and thinking selection to the harness unless requested.
The original transcript working directory is used; no foreign transcript is
copied into Kiki's conversation history.

POST returns `{ session_id, executor_id, created }`. It persists a new Kiki main
agent's external reference and the existing executor binding fingerprint, but
sends no prompt and does not yet establish vendor authentication or negotiate
an engine connection. The first ordinary prompt performs ACP `session/resume`
(or `session/load`) for Claude ACP / Codex ACP, or Codex app-server `thread/resume`.
Engine rejection or lack of runtime resume capability fails closed: imported
sessions never silently turn into fresh sessions or transcript handoffs. Changing
the fingerprint (profile instructions, model, thinking, descriptor, etc.) or
source home also refuses continuation; use a separate ordinary Kiki session for
a different binding.

Repeated or concurrent attachment returns `created: false` and the same Kiki
ID, including after server restart and across Codex ACP/app-server selection.
`executor_id` then names the executor already attached, not necessarily the one
requested. New body choices do not rebind the existing session. Open the returned
Kiki session; deleting it permits a later attachment to create it again.
The vendor transcript remains vendor-owned and may be updated by the engine
when a prompt actually runs.

Errors use the usual envelope: `40925` for disabled/unsupported continuation,
`40401` for a missing local session, `40001` for invalid input, stale source home,
or incompatible binding, and the existing executor/workspace-not-found codes.
Another process holding the deterministic Kiki session lock reports `40933`.
Normal REST cancellation and deadlines apply via `options`.

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
