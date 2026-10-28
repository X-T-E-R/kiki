# Canonical Memory store

Use `ISqliteMemoryStore` for an isolated SQLite-backed Memory consumer. It implements `IMemoryStore`, so the existing Memory tools can consume it without changing their scope, review or off-policy checks. The default `IMemoryStore` remains the legacy file store until a backend authority is published by the migration owner.

## Persistence and transactions

`IMemoryPersistence` lives in `src/persistence/interface/memoryPersistence.ts`; the local backend is `src/persistence/backends/sqliteMemory/`. The database is `<home>/store/memory-sqlite-v1/memory.sqlite`, outside the disposable cache. Its worker uses WAL and FULL synchronous commits. App disposal drains accepted operations and closes the worker.

`read(scopes, generation?)` returns a committed view. A generation freezes object membership and revisions across later writes; forget barriers always apply to older views too. Callers must resolve their permitted scopes on every call. The Store does this through `IMemoryScopes`; the persistence interface is an internal, already-authorized boundary.

`commit` atomically compares the expected generation and each object revision, then saves immutable revisions, current heads, evidence sources, independent human adjudications, pending entries, the journal and an operation receipt. A failed comparison leaves every target unchanged. A scope does not establish which conflicting fact is true.

Pass a stable `MemoryMutation.operationId` for retriable writes. The Memory tool uses session, turn and tool-call identity. After an unknown worker outcome, reopen and read `receipt(operationId, request)` before deciding whether to retry. Reusing an operation ID for different content fails. A worker failure does not trigger an automatic write replay.

Legacy revisions remain exact lookup tokens; new revisions start with `mem2:`. `getRevision(scope, id, revision)` reads a historical revision. Normal `get` returns the current object. User approval rechecks the proposal, target and any `covered_by` dependency in the same committed view. Delete creates a tombstone; undo creates new revisions and refuses to overwrite later edits.

## Read-only shadow import

`IMemoryShadowImport` in `src/app/memory/memoryShadowImport.ts` reads the permitted scope's `entries`, `inbox` and `journal.jsonl`. It writes only the independent SQLite store. `run(scope, after?)` imports at most 128 source files and 16 MiB per call; resume with `nextKey`. `complete` reports traversal completion, and `issues` reports invalid, changed or oversized sources. Keep those sources and resolve the findings before cutover.

The importer preserves raw payloads, legacy IDs, revisions, operation IDs, proposal targets and deleted preimages. Repeating it retains unchanged payloads. Native corrections are not overwritten by a later legacy payload. An absent source file is not yet a deletion instruction: inventory reconciliation and the authority switch belong to the migration transaction.

## Source ingestion and irreversible forget

`ingest({ mutation, unit })` is the host ingestion boundary. The host supplies the stable source-unit ID, original payload, locator and provenance classification; model-generated text must not assign its own trust. Only owner/agent sources are eligible. Session-derived sources require `sessionKind: 'interactive'`; untrusted, system and background sources are rejected before storage. A unit identifies one independently correctable fact, not an entire session. A changed original payload requires a new source revision identity.

Re-extracting an admitted unit resolves its current corrected, pending or archived object rather than creating another object. Supersede transfers predecessor source lineage atomically; delete blocks re-extraction until undo restores the object. `provenance(scope, id)` returns the original sources, independent adjudications and related object IDs.

Shadow imports register a stable fact identity from scope, writer/session/turn, sorted basis references and exact body, excluding the memory ID and title. Re-importing that fact under another ID reports `source_lineage_preserved` instead of restoring its old claim. Missing source coordinates leave an explicit source identity unavailable; the importer still enforces object-ID barriers. Lorebook imports use their writer coordinates, title and complete content as the source unit; a repeated admitted item does not create a new object, and a forgotten item is skipped.

Call `previewForget(scope, ids)` before confirmation. It expands the complete source lineage and returns exact IDs, revisions and current entries, including recoverably deleted tombstones (`entry: null`). Show the complete set to the user. `forget(scope, targets, operationId)` rejects changed revisions or an incomplete lineage, then atomically publishes persistent object/source barriers and removes Memory content, historical views and replay receipt bodies. The same exact source cannot return under a new memory ID, while a distinct fact from the same session remains eligible. This action cannot be undone.

The barriers do not remove History, external files or independently held backups; their owners must perform those operations. A backup-restore entry point must install current barriers before exposing restored content. SQLite schema 2 adds source links and barriers and backfills stable identities for schema-1 imported objects whose original revisions remain available.

The source lifecycle adapts OpenClaw's trusted-candidate, provenance reservation, predecessor-lineage and forget units. Source revision, modifications and the MIT license are recorded in `src/app/memory/NOTICE` and `OPENCLAW-LICENSE`.

## Recall and request working sets

`ISqliteMemoryStore.snapshot(scopes)` reads all permitted objects at one committed generation. `checkpoint()` reads only persistent generation metadata, without loading object bodies. The safe-step consumer reuses its working set until the request, generation, persona or a validity deadline changes. The file Store keeps its existing projection behavior.

`memoryRecall.ts` adapts OpenClaw's lexical/vector union, weighted component scores, exact-identity tier, MMR diversity and keyword-only fallback. Kiki supplies scoped object IDs and authoritative revisions; stale semantic candidates are discarded. Local BM25 uses the existing ASCII/CJK tokenizer over the bounded current object set instead of adding OpenClaw's file-path FTS schema. Its title contribution is a bounded weight, not an exact-title million-point bonus. Scope and update time do not decide truth. No Memory semantic provider is configured or called by this unit; the pure ranking input accepts already-authorized semantic candidates without creating an upload path.

MemorySearch and MemoryRead share `memoryContext.ts`'s complete result builder. Search attempts whole units within 24,000 UTF-16 units and 6,000 estimated tokens, including framing and metadata. A result that does not fit remains an explicit `complete: false` reference with an exact read target. If reference metadata alone exceeds the budget, the tool returns a smaller-`page_size` recovery rather than an oversized page. List remains a reference inventory.

The agent working set uses the same complete content and attribution, with the configured character budget and an additional 1,000-estimated-token ceiling. Relevant units precede unrelated pinned entries; expired and pending entries do not enter the automatic working set. OpenClaw's title-trigger scoring is adapted to Kiki's ASCII/CJK terms without its fixed top-three window or truncated final body.

`AgentMemorySnapshot.refreshIfDirty(request?)` obtains the latest actual user/child-assignment text from context when no request is supplied, including the `runAgentTurn` subagent origin and parent messages. Current task goals, directives, next actions and explicit `[m_id]` references supplement continuation requests. It ignores injected, tool and compaction-summary text. Configuration changes remove disabled worksets at the next safe step. Native safe steps publish through the existing profile runtime snapshot. Binding the SQLite Store adopts that dynamic layout once; later working-set updates leave the stable system prefix unchanged. `memoryProjection.ts` removes superseded host-owned memory sections from outgoing requests while preserving the canonical conversation and other runtime sections. Compaction drops derived injections and the next step rebuilds current revisions.

External execution passes the outbound request text explicitly and carries the same read-only working-set payload only when its binding selects `kiki_context: ["memory"]` or `executor_prompt.include: ["memory_snapshot"]`. Explicit off choices remain effective. The actual ACP request boundary is `AgentExecutionService.run` immediately before `session.run`; native captures use `TestAgentContext.llmCalls` after the safe-step injector.

## Integration boundary

The Store and request working-set units are available for isolated binding. Runtime backend authority, packaged worker assets, reversible cutover, import preview actions and the GUI management API must be completed before enabling SQLite for existing homes. The MemorySearch complete-response contract applies to both Stores; user views in `docs/en/` and `docs/zh/` describe it.

`test/app/memory/sqliteMemory.test.ts` covers transactions, source lifecycle, recall fusion, complete-response budgets and cross-Store safe-step refresh. `test/agent/tools/memory/memoryConsumption.test.ts` captures actual native main/child requests, correction/forget replacements and relay recovery. `test/agent/executor/externalExecutor.test.ts` captures explicitly admitted and opted-out ACP request payloads.
