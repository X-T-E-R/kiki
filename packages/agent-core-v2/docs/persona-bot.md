# Persona, Bot, and room ownership

The public usage guide is [Personas, Bots, and rooms](../../../docs/en/customization/personas.md). The source contracts below are authoritative; this page describes integration and recovery boundaries rather than duplicating their field inventories.

## Ownership and contracts

- `@kiki/agent-profiles/personaFile` owns the closed persona file schema and `PersonaSnapshot`. File frontmatter is snake_case; in-process definitions are camelCase. IDs are canonical kebab-case directory names.
- App `IPersonaStore` owns cards, examples, avatars, extensions, and the shared `state.json` lock. `getState`/`updateState` are the only Bot state mutation seam. App `IPersonaCatalog` exposes catalog changes. Do not write state independently from a Bot service.
- Agent profile binding freezes the full persona snapshot and its revision. Explicit model > persona model > profile/route/default; permissions remain profile-owned. Room prompt text follows the persona block. Restore configures the persona memory scope before refreshing the memory snapshot.
- App `IMemoryStore` owns persona and persona-workspace namespaces. Card deletion removes memory before assets and retains the assets on cleanup failure. Duplication intentionally does not copy memory or home-session state.
- Session `ISessionDeliveryService` persists the selected mode in metadata; its effective mode stays fixed for the current turn. Agent `DeliveryReminderService` records subsequent mode changes as durable `SessionDeliveryChanged` events and permits one reminder continuation per eligible turn. A setter used before Agent creation has metadata persistence but no Agent wire event.
- `SendMessage` is a main-agent tool contribution gated by effective `message` delivery; the shipped `agent` profile includes it, while `reply` turns omit it. Profile allowlists remain authoritative: a custom profile with an explicit `tools` list must include `SendMessage`, and delivery mode does not bypass that permission. Agent tool registration refreshes between turns, and the LLM tool table is frozen for each turn, so changing delivery takes effect on the next turn without changing a prefix mid-turn. The original binding snapshot stays frozen; after a shipped profile update, a clean shipped `agent` binding in `message` mode gets only a compatibility `SendMessage` activation, while custom or modified profiles are never widened. The shipped-profile prefix cache may miss once on the first post-update turn.
- App `IBotService` owns home-session single-flight creation and persistent handoff rate receipts. Peer delivery uses the Thread capability and is independent of the ordinary Thread tool enable switch.
- App `IRoomService` owns `room.json` and append-only `log.jsonl` through the generic Stores. `IRoomMessageRouter` must be eagerly materialized: `SendMessage` observes it through `@ref`, which does not instantiate an on-demand service. Room members use dedicated sessions, not Bot home sessions.
- `IThreadCommunicationService.sendRoomMessage` owns mailbox admission, `waitRoomDelivery` waits for actual prompt completion, and `cancelRoomDeliveries` cancels pending—not running—prompt deliveries. Pending completion receipts are never evicted while a turn is running. Room wakes reconstruct a cold member's thread reference from the persisted session index before `sendRoomMessage`; they resume the existing session and never create a replacement thread, so restart recovery preserves context.

The REST schemas in `packages/protocol/src/rest/{persona,bot,room}.ts` and klient contracts mirror these surfaces. Persona lists are arrays. Room membership, mute state, and budget use `update`; room insertion uses `postUserMessage`. Attachment receipts contain `blobref:<agentId>:<sha256>` references and must be fetched through the sender session's media endpoint without rewriting the reference.

## Configuration and persistence

`BotConfig` uses `maxHandoffsPerHour` and `roomBudget` internally. The config codec produces `max_handoffs_per_hour` and `room_budget` on disk; do not put snake_case fields in the internal schema. The default is disabled. Persona selection remains available independently.

A room workspace change rebuilds dedicated member sessions and archives the old ones. Membership/workspace changes reject while a turn or question is active; name/host/mute changes keep frozen system prefixes. Room cancellation marks runtime work before removing persistent documents so a late failed turn cannot append into a deleted or recreated room.

## Verification

Claim-matched coverage lives in:

- `agent-profiles/test/personaFile.test.ts`: schema closure and permission diagnostics.
- `test/app/persona/personaStore.test.ts`: revision conflicts, card interchange, avatars, memory hooks, and deletion safety.
- Agent profile, persona prompt, ThreadCreate, and memory tests: frozen bindings, precedence, and memory isolation.
- `test/agent/prompt/submit.test.ts`: explicit greeting materialization and one real-loop delivery reminder continuation.
- `test/app/room/room.test.ts`: sequential wakes, indexed log/catch-up/idempotency reads, pause/budget/interrupt behavior, persisted question ordering, workspace rebuild, and draining newly queued work.
- Thread communication tests: target identity, cold delivery, persisted room receipts, idempotency, pending cancellation, and long-running completion waits.
- `test/app/persona/personaStore.test.ts`: direct-file watcher refresh, atomic card/avatar/memory compensation, and complete non-avatar CHARX asset round-trips.
- `packages/klient/test/http.conformance.test.ts`: real App bootstrap, room SendMessage routing, downloadable immutable attachments, REST actions, cold persona/delivery projection, and Bot state recovery.

Regenerate config, state, and wire manifests when their source contracts change. Schema freshness checks establish generated consistency; they do not prove the behavioral or UI acceptance criteria.
