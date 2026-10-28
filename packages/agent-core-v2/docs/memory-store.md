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

`forget(scope, targets, operationId)` compares the exact previewed IDs and revisions, publishes durable barriers and removes content from Memory reads, historical views and replay receipts. It rejects subsequent imports for those objects. The barriers do not remove History, external files or independently held backups; their owners must perform those operations. A backup-restore entry point must install current barriers before exposing restored content.

## Integration boundary

The first store unit is available for isolated binding and direct contract tests. Runtime backend selection, packaged worker assets, reversible cutover, import preview actions and the GUI management API are completed by the migration and edge owners before enabling it for existing homes. User documentation in `docs/en/guides/memory.md` and `docs/zh/guides/memory.md` follows that default-on boundary.

The decisive tests are `test/app/memory/sqliteMemory.test.ts`: multi-object rollback, concurrent CAS, immutable revisions, stable pagination, approval rechecks, delete/undo, actual tool consumption, raw import, correction replay and a worker exit after COMMIT but before acknowledgment.
