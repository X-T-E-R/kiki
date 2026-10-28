import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MemoryWorker } from '#/persistence/backends/sqliteMemory/host';
import { configureMemoryWorkerRuntime } from '#/persistence/backends/sqliteMemory/protocol';
import { join } from 'node:path';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IMemoryScopes, type MemoryScope } from '#/app/memory/memoryScopes';
import { IMemoryStore, MemoryStore, type MemoryEntry } from '#/app/memory/memoryStore';
import { ISqliteMemoryStore, SqliteMemoryStore } from '#/app/memory/sqliteMemoryStore';
import { IMemoryShadowImport, MemoryShadowImport } from '#/app/memory/memoryShadowImport';
import { IMemoryPersistence, type MemoryCommit } from '#/persistence/interface/memoryPersistence';
import { SqliteMemoryPersistence } from '#/persistence/backends/sqliteMemory/sqliteMemoryPersistence';
import { MemoryDatabase } from '#/persistence/backends/sqliteMemory/database';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentMemorySnapshot, AgentMemorySnapshot } from '#/app/memory/memorySnapshot';
import { rankMemoryRecall, selectMemoryRecall } from '#/app/memory/memoryRecall';
import { renderMemoryWorkingSet, memoryRequestText, memoryTextFits } from '#/app/memory/memoryContext';
import { memoryHandoffMessages, projectCurrentMemory, withoutMemoryWorkset } from '#/app/memory/memoryProjection';
import { buildFreshPackage } from '#/agent/modelSwitch/freshPackage';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IConfigService } from '#/app/config/config';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { IMemoryReadTool, IMemoryWriteTool, IMemorySearchTool, MemoryReadTool, MemoryWriteTool, MemorySearchTool } from '#/agent/tools/memory/memoryTools';

const global: MemoryScope = { kind: 'global' };
const workspace = { kind: 'workspace', workspaceId: 'wd_example_0123456789ab' } as const;
const source = { writer: 'user' as const };
const pathFor = (scope: MemoryScope): string => scope.kind === 'global' ? 'memory/global' : scope.kind === 'workspace' ? `memory/workspaces/${scope.workspaceId}` : scope.kind === 'persona' ? `memory/global/personas/${scope.personaId}` : `memory/workspaces/${scope.workspaceId}/personas/${scope.personaId}`;
let home: string;
let ix: TestInstantiationService;
let store: ISqliteMemoryStore;
let persistence: IMemoryPersistence;
let storage: FileStorageService;
let approval: 'auto' | 'review' | 'off';
function bind(): void {
  ix = new TestInstantiationService();
  storage = new FileStorageService(home);
  ix.stub(IBootstrapService, { storeDir: join(home, 'store') });
  ix.stub(IMemoryScopes, { resolve: async (scope) => pathFor(scope), listWorkspaceIds: async () => [workspace.workspaceId] });
  ix.stub(IFileSystemStorageService, storage);
  ix.set(IMemoryPersistence, new SyncDescriptor(SqliteMemoryPersistence));
  ix.set(ISqliteMemoryStore, new SyncDescriptor(SqliteMemoryStore));
  ix.set(IMemoryShadowImport, new SyncDescriptor(MemoryShadowImport));
  persistence = ix.get(IMemoryPersistence);
  store = ix.get(ISqliteMemoryStore);
  ix.stub(IMemoryStore, store);
  ix.stub(ISessionContext, { workspaceId: workspace.workspaceId, sessionId: 'example-session' });
  ix.stub(IAgentMemorySnapshot, { getPersona: () => undefined });
  ix.stub(IConfigService, { get: <T>() => ({ enabled: true, approval }) as T });
  ix.stub(ICapabilitySnapshotService, { toolAvailable: (tool) => tool !== 'MemoryWrite' || approval !== 'off' });
  ix.set(IMemoryWriteTool, new SyncDescriptor(MemoryWriteTool));
  ix.set(IMemoryReadTool, new SyncDescriptor(MemoryReadTool));
}
async function close(): Promise<void> { await persistence.close(); await storage.close(); await ix.dispose(); }
const save = (title: string, body = 'Keep the numeric limit 17 and the exception; never publish private data.') => store.put({ action: 'create', scope: global, type: 'feedback', title, body, reason: 'Human instruction', source });
const update = (entry: MemoryEntry, body: string) => store.put({ action: 'update', scope: global, id: entry.id, expectedRevision: entry.revision, type: entry.type, title: entry.title, body, reason: 'Human correction', source });
beforeEach(async () => { await mkdir(join(process.cwd(), '.tmp'), { recursive: true }); home = await mkdtemp(join(process.cwd(), '.tmp', 'sqlite-memory-')); approval = 'auto'; bind(); });
afterEach(async () => { await close(); await rm(home, { force: true, recursive: true }); });

describe('canonical Memory transactions', () => {
  it('keeps the authority outside cache and recovers receipts and immutable revisions after reopening', async () => {
    const input = { action: 'create' as const, scope: global, type: 'feedback' as const, title: 'Long lived', body: 'Never discard the exception.', reason: 'Human instruction', source, operationId: 'example-operation' };
    const saved = await store.put(input);
    const changed = await update(saved.entry, 'Only this corrected choice applies; retain the 17-unit exception.');
    await close();
    await rm(join(home, 'cache'), { force: true, recursive: true });
    bind();
    expect(await store.put(input)).toEqual(saved);
    expect(await store.get(global, saved.entry.id)).toEqual(changed.entry);
    expect(await store.getRevision(global, saved.entry.id, saved.entry.revision)).toEqual(saved.entry);
    await expect(store.put({ ...input, body: 'Different request' })).rejects.toThrow('another request');
  });

  it('rolls every object back when a later CAS fails and commits a supersede once', async () => {
    const first = await save('First');
    const second = await save('Second');
    const view = await persistence.read(['memory/global']);
    const edit = { ...first.entry, revision: 'mem2:example-revision', body: 'Changed' };
    const bad: MemoryCommit = { operationId: 'bad-batch', request: 'bad-batch', expectedGeneration: view.generation, edits: [
      { scope: 'memory/global', id: first.entry.id, expectedRevision: first.entry.revision, entry: edit, revision: edit.revision },
      { scope: 'memory/global', id: second.entry.id, expectedRevision: 'stale', entry: null, revision: 'mem2:example-tombstone' },
    ], result: {} };
    await expect(persistence.commit(bad)).rejects.toThrow('revision conflict');
    expect(await persistence.receipt('bad-batch')).toBeUndefined();
    expect(await store.get(global, first.entry.id)).toEqual(first.entry);
    const superseded = await store.put({ action: 'supersede', scope: global, id: first.entry.id, expectedRevision: first.entry.revision, type: 'feedback', title: 'Replacement', body: 'Complete replacement; preserve exception 17.', source, reason: 'Replacement', operationId: 'supersede-once' });
    expect((await persistence.read(['memory/global'])).generation).toBe(view.generation + 1);
    expect((await store.get(global, first.entry.id))?.superseded_by).toBe(superseded.entry.id);
    const restored = await store.undo(global, superseded.operationId);
    expect(restored).toBeUndefined();
    expect((await store.get(global, first.entry.id))?.status).toBe('active');
    expect(await store.get(global, superseded.entry.id)).toBeUndefined();
  });

  it('lets one concurrent CAS win without losing the other committed objects', async () => {
    const saved = await save('Concurrent');
    const results = await Promise.allSettled([update(saved.entry, 'Choice B.'), update(saved.entry, 'Choice C.')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(['Choice B.', 'Choice C.']).toContain((await store.get(global, saved.entry.id))?.body);
  });

  it('rejects undo over a later edit and makes delete recoverable with a fresh revision', async () => {
    const saved = await save('Undo');
    const changed = await update(saved.entry, 'New choice with its exception.');
    await expect(store.undo(global, saved.operationId)).rejects.toThrow('later Memory edit');
    const deleted = await store.delete(global, saved.entry.id, changed.entry.revision);
    expect(await store.get(global, saved.entry.id)).toBeUndefined();
    const restored = await store.undo(global, deleted);
    expect(restored?.body).toBe(changed.entry.body);
    expect(restored?.revision).not.toBe(changed.entry.revision);
    await expect(update(changed.entry, 'Stale update')).rejects.toThrow('revision conflict');
  });

  it('rechecks a pending target and its covering dependency at user approval', async () => {
    const target = await save('Proposal target');
    const retained = await save('Retained');
    const proposal = await store.put({ action: 'archive', scope: global, id: target.entry.id, expectedRevision: target.entry.revision, source: { writer: 'agent' }, reason: 'Covered', pending: true, covered_by: { id: retained.entry.id, expected_revision: retained.entry.revision } });
    expect((await store.get(global, target.entry.id))?.status).toBe('active');
    await update(retained.entry, 'Covering conditions changed.');
    await expect(store.put({ action: 'update', scope: global, id: proposal.entry.id, expectedRevision: proposal.entry.revision, source, reason: 'Approve' })).rejects.toThrow('changed or is not active');
    expect((await store.get(global, proposal.entry.id))?.status).toBe('pending');
    expect((await store.get(global, target.entry.id))?.status).toBe('active');
  });

  it('pins committed pages during writes and rechecks visible scopes', async () => {
    const a = await save('A');
    const b = await save('B');
    const first = await store.query([global], { mode: 'list', page_size: 1 });
    expect(first.items[0]?.id).toBe(a.entry.id);
    await update(b.entry, 'New value after the page watermark.');
    await save('AA');
    const second = await store.query([global], { cursor: first.next_cursor! });
    expect(second.items.map((item) => item.id)).toEqual([b.entry.id]);
    expect(second.items[0]?.body).toBe(b.entry.body);
    await expect(store.query([workspace], { cursor: first.next_cursor! })).rejects.toThrow('visible scopes changed');
  });

  it('serves initial queries through concurrent writes and refreshes from a separate Store worker', async () => {
    const saved = await save('Cross-store refresh');
    const other = new TestInstantiationService();
    other.stub(IBootstrapService, { storeDir: join(home, 'store') });
    other.stub(IMemoryScopes, { resolve: async (scope) => pathFor(scope) });
    other.set(IMemoryPersistence, new SyncDescriptor(SqliteMemoryPersistence));
    other.set(ISqliteMemoryStore, new SyncDescriptor(SqliteMemoryStore));
    const peer = other.get(ISqliteMemoryStore);
    try {
      const [page, changed] = await Promise.all([store.query([global], { mode: 'list' }), peer.put({ action: 'update', scope: global, id: saved.entry.id, expectedRevision: saved.entry.revision, type: 'feedback', title: saved.entry.title, body: 'Peer correction; preserve exception 17.', source, reason: 'Peer correction' })]);
      expect(page.coverage.complete).toBe(true);
      expect(page.items).toHaveLength(1);
      expect([saved.entry.body, changed.entry.body]).toContain(page.items[0]?.body);
      expect((await store.get(global, saved.entry.id))?.revision).toBe(changed.entry.revision);
      expect((await store.query([global], { mode: 'list' })).items[0]?.body).toBe(changed.entry.body);
    } finally { await other.get(IMemoryPersistence).close(); await other.dispose(); }
  });

  it('does not skip surviving results when earlier pages or later candidates are forgotten', async () => {
    const a = await save('A');
    const b = await save('B');
    const c = await save('C');
    const d = await save('D');
    const page = await store.query([global], { mode: 'list', page_size: 1 });
    await store.forget(global, [a, b, c].map((saved) => ({ id: saved.entry.id, expectedRevision: saved.entry.revision })), 'forget-between-pages');
    const remaining = await store.query([global], { cursor: page.next_cursor! });
    expect(remaining.items.map((entry) => entry.id)).toEqual([d.entry.id]);
    expect(remaining.coverage.exhausted).toBe(true);
  });

  it('uses the same title tie-breaker when continuing equal-score search pages', async () => {
    const seed = (await save('Seed', 'Shared neutral content.')).entry;
    const entries = [['m_z', 'keyword Alder'], ['m_m', 'keyword Birch'], ['m_a', 'keyword Cedar']].map(([id, title]) => ({ ...seed, id: id!, title: title! }));
    await persistence.importLegacy(entries.map((entry) => ({ scope: 'memory/global', key: `entries/${entry.id}.md`, payload: JSON.stringify(entry), entry })));
    const found: string[] = [];
    let page = await store.query([global], { query: 'keyword', page_size: 1 });
    for (;;) {
      found.push(...page.items.map((entry) => entry.id));
      if (page.next_cursor === null) break;
      page = await store.query([global], { cursor: page.next_cursor });
    }
    expect(found).toEqual(entries.map((entry) => entry.id));
  });

  it('gives real Memory tools idempotent receipts, full reads, review and off behavior', async () => {
    const tool = ix.get(IMemoryWriteTool);
    const execution = tool.resolveExecution({ action: 'create', scope: 'global', type: 'feedback', title: 'Tool rule', body: 'Never truncate exception 17.', reason: 'Human instruction' });
    if (!('execute' in execution)) throw new Error('Expected execution');
    const context = { turnId: 3, toolCallId: 'example-call', signal: new AbortController().signal };
    const first = await execution.execute(context);
    expect(await execution.execute(context)).toEqual(first);
    const data = JSON.parse(first.output as string) as { entry: MemoryEntry };
    const read = ix.get(IMemoryReadTool).resolveExecution({ id: data.entry.id });
    if (!('execute' in read)) throw new Error('Expected execution');
    expect(JSON.parse((await read.execute(context)).output as string)[0]).toMatchObject({ body: data.entry.body, complete: true });
    approval = 'review';
    const pending = tool.resolveExecution({ action: 'update', scope: 'global', id: data.entry.id, expected_revision: data.entry.revision, type: 'feedback', title: 'Tool rule', body: 'Proposed choice; keep exception 17.', reason: 'Propose' });
    if (!('execute' in pending)) throw new Error('Expected execution');
    expect(JSON.parse((await pending.execute({ ...context, toolCallId: 'pending' })).output as string).outcome).toBe('pending');
    expect((await store.get(global, data.entry.id))?.body).toBe(data.entry.body);
    approval = 'off';
    expect((await execution.execute({ ...context, toolCallId: 'off' })).isError).toBe(true);
  });
});

describe('Memory shadow import and replay barriers', () => {
  it('preserves legacy IDs, exact revisions, raw journal and bad files across incremental reopens', async () => {
    ix.set(IMemoryStore, new SyncDescriptor(MemoryStore));
    const legacy = ix.get(IMemoryStore);
    const original = await legacy.put({ action: 'create', scope: global, type: 'feedback', title: 'Legacy', body: 'Original evidence.', reason: 'Human instruction', source });
    const current = await legacy.put({ action: 'update', scope: global, id: original.entry.id, expectedRevision: original.entry.revision, type: 'feedback', title: 'Legacy', body: 'Current legacy evidence.', reason: 'Changed', source });
    const raw = await storage.read('memory/global', `entries/${original.entry.id}.md`);
    await storage.write('memory/global', 'entries/m_bad.md', new TextEncoder().encode('broken frontmatter'));
    const imported = await ix.get(IMemoryShadowImport).run(global);
    expect(imported).toMatchObject({ complete: true, imported: 1 });
    expect(imported.issues[0]?.key).toBe('entries/m_bad.md');
    expect(await store.get(global, original.entry.id)).toEqual(current.entry);
    expect(await store.getRevision(global, original.entry.id, original.entry.revision)).toEqual(original.entry);
    expect(await store.journal(global)).toHaveLength(2);
    const preserved = await persistence.legacy('memory/global');
    expect(preserved.find((record) => record.key === `entries/${original.entry.id}.md`)?.payload).toBe(new TextDecoder().decode(raw));
    const corrected = await update(current.entry, 'A durable human correction; preserve exception 17.');
    const oldRaw = `---\n${JSON.stringify({ ...current.entry, body: undefined, revision: undefined, updated: '2026-01-02' })}\n---\nA stale re-extraction.\n`;
    await storage.write('memory/global', `entries/${original.entry.id}.md`, new TextEncoder().encode(oldRaw));
    const increment = await ix.get(IMemoryShadowImport).run(global);
    expect(increment.issues).toContainEqual(expect.objectContaining({ issue: 'current_revision_preserved' }));
    await close(); bind();
    expect(await store.get(global, original.entry.id)).toEqual(corrected.entry);
    expect((await ix.get(IMemoryShadowImport).run(global)).retained).toBe(3);
  });

  it('imports pending targets and deleted preimages without reactivating them', async () => {
    ix.set(IMemoryStore, new SyncDescriptor(MemoryStore));
    const legacy = ix.get(IMemoryStore);
    const target = await legacy.put({ action: 'create', scope: global, type: 'feedback', title: 'Pending target', body: 'Keep the existing choice.', reason: 'Human instruction', source });
    const proposal = await legacy.put({ action: 'update', scope: global, id: target.entry.id, expectedRevision: target.entry.revision, type: 'feedback', title: 'Pending target', body: 'Pending correction.', reason: 'Review', source: { writer: 'agent' }, pending: true });
    const deleted = await legacy.put({ action: 'create', scope: global, type: 'feedback', title: 'Deleted target', body: 'Recoverable content.', reason: 'Human instruction', source });
    const deletion = await legacy.delete(global, deleted.entry.id, deleted.entry.revision);
    expect((await ix.get(IMemoryShadowImport).run(global)).issues).toEqual([]);
    expect(await store.get(global, deleted.entry.id)).toBeUndefined();
    expect((await store.undo(global, deletion))?.body).toBe(deleted.entry.body);
    const approved = await store.put({ action: 'update', scope: global, id: proposal.entry.id, expectedRevision: proposal.entry.revision, type: proposal.entry.type, title: proposal.entry.title, body: proposal.entry.body, reason: 'Approve', source });
    expect(approved.entry.id).toBe(target.entry.id);
    expect(approved.entry.body).toBe('Pending correction.');
    expect(await store.get(global, proposal.entry.id)).toBeUndefined();
  });

  it('applies durable forget barriers to historical views, receipts and reimport before exposing content', async () => {
    const saved = await save('Forget target', 'Private exception 17.');
    const before = await persistence.read(['memory/global']);
    await persistence.importLegacy([{ scope: 'memory/global', key: `entries/${saved.entry.id}.md`, payload: 'Invalid preimage containing private exception 17.', issue: 'invalid_legacy_entry' }]);
    await store.forget(global, [{ id: saved.entry.id, expectedRevision: saved.entry.revision }], 'forget-once');
    expect(await store.get(global, saved.entry.id)).toBeUndefined();
    expect(await store.getRevision(global, saved.entry.id, saved.entry.revision)).toBeUndefined();
    expect((await persistence.read(['memory/global'], before.generation)).objects).toEqual([]);
    expect((await persistence.receipt(saved.operationId!))?.result).toEqual({ forgotten: true });
    const imported = await persistence.importLegacy([{ scope: 'memory/global', key: `entries/${saved.entry.id}.md`, payload: JSON.stringify(saved.entry), entry: saved.entry }]);
    expect(imported.issues[0]?.issue).toBe('forgotten_source_rejected');
    expect(await persistence.legacy('memory/global')).toEqual([]);
    await close(); bind();
    await store.forget(global, [{ id: saved.entry.id, expectedRevision: saved.entry.revision }], 'forget-once');
    expect(await store.get(global, saved.entry.id)).toBeUndefined();
  });

  it('filters untrusted and background ingestion before registering a stable source', async () => {
    const mutation = { scope: global, type: 'feedback' as const, title: 'Trusted source', body: 'Keep the complete condition and exception 17.', reason: 'Trusted source candidate', source: { writer: 'agent' as const } };
    for (const origin of ['untrusted', 'system'] as const) await expect(store.ingest({ mutation, unit: { id: origin, payload: mutation.body, origin } })).rejects.toThrow('trusted interactive');
    await expect(store.ingest({ mutation, unit: { id: 'background', payload: mutation.body, origin: 'agent', sessionKind: 'background' } })).rejects.toThrow('trusted interactive');
    for (const locator of ['sessions/example/turn.jsonl', 'memory\\.dreams\\session-corpus\\example.txt']) await expect(store.ingest({ mutation, unit: { id: locator, payload: mutation.body, origin: 'owner', locator } })).rejects.toThrow('trusted interactive');
    expect((await persistence.read(['memory/global'])).generation).toBe(0);
    const saved = await store.ingest({ mutation, unit: { id: 'interactive', payload: mutation.body, origin: 'agent', sessionKind: 'interactive' } });
    expect(saved.entry.body).toBe(mutation.body);
    expect((await store.provenance(global, saved.entry.id)).sources[0]?.payload).toBe(mutation.body);
  });

  it('replays stable-source extraction through correction, replacement, deletion and precise forget', async () => {
    const mutation = { scope: global, type: 'feedback' as const, title: 'Source A', body: 'Address A.', reason: 'Observed source', source: { writer: 'agent' as const } };
    const unit = { id: 'session-example:turn-1:fact-1', payload: 'Original human utterance: address A.', origin: 'owner' as const };
    const first = await store.ingest({ mutation, unit });
    const corrected = await update(first.entry, 'A was mistaken; always Address B.');
    expect((await store.ingest({ mutation: { ...mutation, title: 'Re-extracted A' }, unit })).entry.body).toBe(corrected.entry.body);
    const replacement = await store.put({ ...mutation, action: 'supersede', id: first.entry.id, expectedRevision: corrected.entry.revision, title: 'Replacement B', body: 'Address B, exception 17.', source });
    expect((await store.ingest({ mutation, unit })).entry.id).toBe(replacement.entry.id);
    const deletion = await store.delete(global, replacement.entry.id, replacement.entry.revision);
    await expect(store.ingest({ mutation, unit })).rejects.toThrow('deleted Memory');
    const restored = await store.undo(global, deletion);
    expect((await store.ingest({ mutation, unit })).entry.revision).toBe(restored?.revision);
    const preview = await store.previewForget(global, [replacement.entry.id]);
    expect(preview.targets.map((target) => target.id).toSorted()).toEqual([first.entry.id, replacement.entry.id].toSorted());
    await expect(store.forget(global, [{ id: replacement.entry.id, expectedRevision: restored!.revision }], 'incomplete-forget')).rejects.toThrow('complete source lineage');
    await store.forget(global, preview.targets, 'forget-source-lineage');
    await close(); bind();
    await expect(store.ingest({ mutation, unit })).rejects.toThrow('source unit has been forgotten');
    expect((await store.provenance(global, first.entry.id)).sources).toEqual([]);
    expect(await store.getRevision(global, first.entry.id, corrected.entry.revision)).toBeUndefined();
    const independent = await store.ingest({ mutation: { ...mutation, title: 'Separate fact' }, unit: { ...unit, id: 'session-example:turn-1:fact-2' } });
    expect(independent.entry.status).toBe('active');
  });

  it('forgets recoverably deleted preimages and rejects an obsolete preview after a new successor', async () => {
    const saved = await save('Deleted private preimage');
    await store.delete(global, saved.entry.id, saved.entry.revision);
    const deleted = await store.previewForget(global, [saved.entry.id]);
    expect(deleted.targets[0]?.entry).toBeNull();
    await store.forget(global, deleted.targets, 'forget-deleted');
    expect(await store.getRevision(global, saved.entry.id, saved.entry.revision)).toBeUndefined();
    const original = await save('Obsolete preview');
    const preview = await store.previewForget(global, [original.entry.id]);
    await store.put({ action: 'supersede', scope: global, id: original.entry.id, expectedRevision: original.entry.revision, type: original.entry.type, title: 'New successor', body: original.entry.body, reason: 'Replace', source });
    await expect(store.forget(global, preview.targets, 'obsolete-forget')).rejects.toThrow('preview changed');
    expect((await store.list(global)).filter((entry) => entry.status === 'active')).toHaveLength(1);
  });

  it('includes pending derivatives in forget preview and permits clean archive approval', async () => {
    const saved = await save('Pending lineage');
    const proposal = await store.put({ action: 'update', scope: global, id: saved.entry.id, expectedRevision: saved.entry.revision, type: saved.entry.type, title: saved.entry.title, body: 'Derived private correction.', pending: true, reason: 'Review', source: { writer: 'agent' } });
    const preview = await store.previewForget(global, [saved.entry.id]);
    expect(preview.targets.map((target) => target.id).toSorted()).toEqual([saved.entry.id, proposal.entry.id].toSorted());
    await store.forget(global, preview.targets, 'forget-pending-derivative');
    expect(await store.get(global, proposal.entry.id)).toBeUndefined();
    const archived = await save('Archive approval');
    const archive = await store.put({ action: 'archive', scope: global, id: archived.entry.id, expectedRevision: archived.entry.revision, pending: true, source: { writer: 'agent' }, reason: 'Review retirement' });
    const approved = await store.put({ action: 'update', scope: global, id: archive.entry.id, expectedRevision: archive.entry.revision, reason: 'Accept retirement', source });
    expect(approved.entry.status).toBe('archived');
    expect(await store.get(global, archive.entry.id)).toBeUndefined();
  });

  it('rolls back supersede and its source reservation together when lineage persistence fails', async () => {
    const saved = await save('Atomic origin');
    const db = new DatabaseSync(join(home, 'store', 'memory-sqlite-v1', 'memory.sqlite'));
    try {
      db.exec("CREATE TRIGGER fail_lineage BEFORE INSERT ON source_links BEGIN SELECT RAISE(ABORT, 'injected lineage failure'); END;");
      await expect(store.put({ action: 'supersede', scope: global, id: saved.entry.id, expectedRevision: saved.entry.revision, type: 'feedback', title: 'Failed successor', body: 'Must never become active.', reason: 'Replace', source })).rejects.toThrow('injected lineage failure');
    } finally { db.exec('DROP TRIGGER fail_lineage'); db.close(); }
    await close(); bind();
    expect(await store.get(global, saved.entry.id)).toEqual(saved.entry);
    expect((await store.list(global)).filter((entry) => entry.status === 'active')).toHaveLength(1);
    expect((await persistence.read(['memory/global'])).generation).toBe(1);
  });

  it('backfills stable imported identities on schema-1 upgrade before re-extraction', async () => {
    const seed = await save('Schema seed');
    const entry: MemoryEntry = { ...seed.entry, id: 'm_schema_import', title: 'Schema source', source: { writer: 'import', session: 'example-schema', turn: 1 } };
    await persistence.importLegacy([{ scope: 'memory/global', key: `entries/${entry.id}.md`, payload: JSON.stringify(entry), entry }]);
    await close();
    const db = new DatabaseSync(join(home, 'store', 'memory-sqlite-v1', 'memory.sqlite'));
    try { db.exec("DROP TABLE source_links; DROP TABLE source_barriers; DELETE FROM sources WHERE id LIKE 'source-unit:%'; PRAGMA user_version=1;"); }
    finally { db.close(); }
    bind();
    const corrected = await update(entry, 'Current corrected schema source.');
    const duplicate = { ...entry, id: 'm_schema_reextracted' };
    const replay = await persistence.importLegacy([{ scope: 'memory/global', key: `entries/${duplicate.id}.md`, payload: JSON.stringify(duplicate), entry: duplicate }]);
    expect(replay.issues[0]?.issue).toBe('source_lineage_preserved');
    expect(await store.get(global, duplicate.id)).toBeUndefined();
    expect((await store.get(global, entry.id))?.body).toBe(corrected.entry.body);
  });

  it('applies imported-source correction and forget to a changed legacy ID and real lorebook reimport', async () => {
    const original: MemoryEntry = { ...((await save('Seed')).entry), id: 'm_source_original', title: 'Address source', body: 'Address A', source: { writer: 'import', session: 'example-source', turn: 2 }, basis: { kind: 'observed', note: 'Exact source fact', refs: ['fixture://source/original'] } };
    const importEntry = (entry: MemoryEntry) => persistence.importLegacy([{ scope: 'memory/global', key: `entries/${entry.id}.md`, payload: JSON.stringify(entry), entry }]);
    await importEntry(original);
    const corrected = await update(original, 'A was mistaken; always Address B.');
    expect((await importEntry({ ...original, id: 'm_source_reextracted', title: 'Stale extraction' })).issues[0]?.issue).toBe('source_lineage_preserved');
    expect(await store.get(global, 'm_source_reextracted')).toBeUndefined();
    expect((await store.get(global, original.id))?.body).toBe(corrected.entry.body);
    await store.forget(global, (await store.previewForget(global, [original.id])).targets, 'forget-imported-source');
    await close(); bind();
    expect((await importEntry({ ...original, id: 'm_source_returned' })).issues[0]?.issue).toBe('forgotten_source_rejected');
    const lorebook = [{ title: 'Lorebook source', content: 'Private lorebook fact.' }];
    const first = await store.importLorebook(global, lorebook, { session: 'example-lorebook', turn: 4 });
    await store.forget(global, (await store.previewForget(global, [first[0]!.entry.id])).targets, 'forget-lorebook');
    expect(await store.importLorebook(global, lorebook, { session: 'example-lorebook', turn: 4 })).toEqual([]);
    expect((await store.query([global], { query: 'Private lorebook' })).items.map((entry) => entry.body)).not.toContain(lorebook[0]!.content);
  });

  it('rolls back an uncommitted write when its worker exits and reopens the last committed view', async () => {
    const saved = await save('Before worker fault');
    const path = join(home, 'store', 'memory-sqlite-v1', 'memory.sqlite');
    const crashEntry = join(home, 'precommit-crash.ts');
    await writeFile(crashEntry, `import { parentPort, workerData } from 'node:worker_threads';\nimport { DatabaseSync } from 'node:sqlite';\nconst db = new DatabaseSync(workerData.database);\nparentPort.on('message', () => { db.exec('BEGIN IMMEDIATE; DELETE FROM heads; UPDATE metadata SET value=999'); process.exit(73); });\n`);
    configureMemoryWorkerRuntime(crashEntry);
    const worker = new MemoryWorker(path);
    try { await expect(worker.request({ type: 'read', scopes: ['memory/global'] })).rejects.toThrow('outcome unknown'); }
    finally { configureMemoryWorkerRuntime(); await worker.close(); }
    await close(); bind();
    expect((await persistence.read(['memory/global'])).generation).toBe(1);
    expect(await store.get(global, saved.entry.id)).toEqual(saved.entry);
    const changed = await update(saved.entry, 'A subsequent committed correction.');
    expect((await store.get(global, saved.entry.id))?.revision).toBe(changed.entry.revision);
  });

  it('reconciles a worker death after COMMIT and before acknowledgment without replaying the write', async () => {
    const path = join(home, 'isolated', 'unknown.sqlite');
    const crashEntry = join(home, 'crash-entry.ts');
    const module = pathToFileURL(join(process.cwd(), 'src/persistence/backends/sqliteMemory/database.ts')).href;
    await writeFile(crashEntry, `import { parentPort, workerData } from 'node:worker_threads';\nimport { MemoryDatabase } from ${JSON.stringify(module)};\nconst db = new MemoryDatabase(workerData.database);\nparentPort.on('message', ({ operation }) => { db.commit(operation.input); process.exit(72); });\n`);
    configureMemoryWorkerRuntime(crashEntry);
    const worker = new MemoryWorker(path);
    try {
      await expect(worker.request({ type: 'commit', input: { operationId: 'unknown-operation', request: 'stable-request', expectedGeneration: 0, edits: [], result: { accepted: true } } })).rejects.toMatchObject({ committed: undefined, message: expect.stringContaining('outcome unknown') });
    } finally { configureMemoryWorkerRuntime(); await worker.close(); }
    const db = new MemoryDatabase(path);
    try {
      expect(db.receipt('unknown-operation', 'stable-request')).toMatchObject({ generation: 1, result: { accepted: true }, saved: true });
      expect(db.commit({ operationId: 'unknown-operation', request: 'stable-request', expectedGeneration: 0, edits: [], result: { accepted: true } }).generation).toBe(1);
    } finally { db.close(); }
  });
});


describe('Memory recall and complete working units', () => {
  it('unions lexical and authorized semantic candidates, fences revisions and keeps the exact-identity tier', async () => {
    const a = (await save('Compact keyword', 'Only keyword guidance.')).entry;
    const b = (await save('Different language', '独立的语义候选，限制17次；测试环境除外。')).entry;
    const c = (await save('Stale candidate', 'No lexical overlap.')).entry;
    const entries = [a, b, c].map((entry) => ({ ...entry, scope: global }));
    const ranked = rankMemoryRecall(entries, 'keyword', undefined, { semantic: [
      { ...b, scope: global, score: 0.95 }, { ...c, revision: 'old', scope: global, score: 1 },
    ] });
    expect(ranked.map((entry) => entry.id).toSorted()).toEqual([a.id, b.id].toSorted());
    expect(ranked.find((entry) => entry.id === a.id)?.score_details).toMatchObject({ lexical: expect.any(Number), semantic: 0 });
    expect(ranked.find((entry) => entry.id === b.id)?.score_details.semantic).toBe(0.95);
    expect(rankMemoryRecall(entries, b.id)[0]?.id).toBe(b.id);
    expect(rankMemoryRecall(entries, `Continue the task with [${b.id}]`)[0]?.id).toBe(b.id);
    expect(selectMemoryRecall(ranked, 2, 0.9).map((entry) => entry.id)).toEqual([a.id]);
    expect(selectMemoryRecall(ranked, 2, 0.1).map((entry) => entry.id).toSorted()).toEqual([a.id, b.id].toSorted());
    const exact = rankMemoryRecall(entries, a.id, undefined, { semantic: [{ ...b, scope: global, score: 1 }], semanticWeight: 1, diversity: 0.2 });
    expect(exact[0]?.id).toBe(a.id);
    expect(exact[0]?.score_details.exactIdentifier).toBe(true);
  });

  it('retains keyword-only fallback without displacing strict semantic matches and diversifies duplicates', async () => {
    const first = (await save('One', 'alpha beta gamma delta')).entry;
    const duplicate = (await save('Two', 'alpha beta gamma delta')).entry;
    const distinct = (await save('Three', 'alpha unusual epsilon')).entry;
    const entries = [first, duplicate, distinct].map((entry) => ({ ...entry, scope: global }));
    const ranked = rankMemoryRecall(entries, 'alpha', undefined, { semantic: [{ ...first, scope: global, score: 0.99 }], semanticWeight: 0.8 });
    expect(selectMemoryRecall(ranked, 2, 0.7)[0]?.id).toBe(first.id);
    expect(selectMemoryRecall(ranked, 2, 0.7)).toHaveLength(2);
    const diversified = rankMemoryRecall(entries, 'alpha beta gamma delta', undefined, { diversity: 0.3 });
    expect(diversified[0]?.id).toBe(first.id);
    expect(diversified[1]?.id).toBe(distinct.id);
  });

  it('returns complete Search units or exact expansion references inside both serialized budgets', async () => {
    const body = `${'条件适用范围。'.repeat(170)}限制17次，绝不发布；仅测试环境例外。`;
    for (let index = 0; index < 8; index++) await save(`完整条件 ${index}`, body);
    ix.set(IMemorySearchTool, new SyncDescriptor(MemorySearchTool));
    const execution = ix.get(IMemorySearchTool).resolveExecution({ query: '完整条件' });
    if (!('execute' in execution)) throw new Error('Expected executable search');
    const result = await execution.execute({ turnId: 1, toolCallId: 'search-complete', signal: new AbortController().signal });
    const output = String(result.output);
    expect(memoryTextFits(output, 24_000, 6_000)).toBe(true);
    const items = JSON.parse(output).items;
    expect(items.filter((item: { complete: boolean }) => item.complete).length).toBeGreaterThan(0);
    expect(items.filter((item: { complete: boolean }) => !item.complete).length).toBeGreaterThan(0);
    for (const item of items) {
      if (item.complete) { expect(item.body).toBe(body); expect(item.body).toContain('限制17次，绝不发布；仅测试环境例外。'); }
      else { expect(item.body).toBeUndefined(); expect(item.read).toEqual({ id: item.id, scope: 'global' }); }
      expect(item.target.expected_revision).toBe(item.revision);
    }
  });

  it('reports a smaller-page recovery when reference metadata alone exceeds the search budget', async () => {
    for (let index = 0; index < 20; index++) await save(`${'条件'.repeat(98)}${String(index).padStart(2, '0')}`, 'Whole content; never truncate the condition.');
    ix.set(IMemorySearchTool, new SyncDescriptor(MemorySearchTool));
    const run = async (page_size: number) => {
      const execution = ix.get(IMemorySearchTool).resolveExecution({ query: '条件', page_size });
      if (!('execute' in execution)) throw new Error('Expected executable search');
      return execution.execute({ turnId: 1, toolCallId: `large-references-${page_size}`, signal: new AbortController().signal });
    };
    const oversized = await run(20);
    expect(oversized.isError).toBe(true);
    expect(String(oversized.output)).toContain('smaller page_size');
    const recovered = await run(8);
    expect(recovered.isError).not.toBe(true);
    expect(memoryTextFits(String(recovered.output), 24_000, 6_000)).toBe(true);
    expect(JSON.parse(String(recovered.output)).items).toHaveLength(8);
  });

  it('builds whole relevant units before directory or unrelated pinned content and respects token and character limits', async () => {
    const wanted = (await save('部署例外', '部署最多17台，绝不发布密钥；仅隔离测试例外。')).entry;
    const unrelated = (await save('Unrelated', 'Unrelated resident content.')).entry;
    const expired = { ...wanted, id: 'm_expired', validity: { until: '2000-01-01T00:00:00Z', check: 'Check the expiry.' } };
    const view = { generation: '2', entries: [{ ...unrelated, pinned: true, scope: global }, { ...wanted, scope: global }, { ...expired, scope: global }] };
    const result = renderMemoryWorkingSet(view, '部署例外', 700, 300);
    expect(result.text).toContain(wanted.body);
    expect(result.text).not.toContain('m_expired');
    expect(result.text).not.toContain('[index');
    expect(memoryTextFits(result.text, 700, 300)).toBe(true);
    expect(renderMemoryWorkingSet(view, '部署例外', 100, 20).text).toBe('');
  });

  it('keeps whole-body relevance ahead of a short incidental title match in automatic selection', async () => {
    const wanted = (await save('Operational contract', 'For service calibration input use fixtures/sample-42.json; stop after 17 checks, never upload output, and keep the isolated-test exception.')).entry;
    const incidental = (await save('Input', 'An input box accepts any greeting.')).entry;
    const entries = [wanted, incidental].map((entry) => ({ ...entry, scope: global }));
    const query = 'service calibration input';
    const ranked = rankMemoryRecall(entries, query);
    expect(ranked[0]?.id).toBe(wanted.id);
    const selected = renderMemoryWorkingSet({ generation: '1', entries }, query, 650, 300);
    expect(selected.entries[0]?.id).toBe(wanted.id);
    expect(selected.text).toContain(wanted.body);
  });

  it('reuses a complete current explicit unit instead of duplicating its body in tools and the automatic workset', async () => {
    const entry = (await save('Deployment instructions', 'Use exactly 9 workers; isolated checks never publish artifacts.')).entry;
    const snapshot = { generation: '1', entries: [{ ...entry, scope: global }] };
    const workset = renderMemoryWorkingSet(snapshot, 'Deployment instructions', 2_000, 1_000);
    const prefix = '<system-reminder>\n';
    const memory = `## Scoped memory — Saved memory / as-of projection\n${workset.text}`;
    const messages: ContextMessage[] = [
      { role: 'user', toolCalls: [], origin: { kind: 'injection', variant: 'runtime_snapshot', disclosure: { memoryRange: { start: prefix.length, length: memory.length } } }, content: [{ type: 'text', text: `${prefix}${memory}\n## Skills\nRead\n</system-reminder>` }] },
      { role: 'assistant', toolCalls: [{ type: 'function', id: 'read', name: 'MemoryRead', arguments: '{}' }], content: [] },
      { role: 'tool', toolCallId: 'read', toolCalls: [], content: [{ type: 'text', text: JSON.stringify([{ ...entry, scope: global, complete: true }]) }] },
      { role: 'assistant', toolCalls: [{ type: 'function', id: 'search', name: 'MemorySearch', arguments: '{}' }], content: [] },
      { role: 'tool', toolCallId: 'search', toolCalls: [], content: [{ type: 'text', text: JSON.stringify({ items: [{ ...entry, scope: global, complete: true }] }) }] },
    ];
    const before = JSON.stringify(messages);
    const view = { ...snapshot, scopes: [global], workset: { text: workset.text, entries: workset.entries } };
    const projected = projectCurrentMemory(messages, view);
    expect(JSON.stringify(projected).split(entry.body)).toHaveLength(2);
    expect(JSON.stringify(projected[0])).toContain('## Skills');
    expect(JSON.stringify(projected[4])).toContain('memory_content_reused');
    expect(projected.map((message) => message.toolCallId)).toEqual(messages.map((message) => message.toolCallId));
    const referenceOnly = [...messages.slice(0, 2), { ...messages[2]!, content: [{ type: 'text' as const, text: JSON.stringify([{ id: entry.id, scope: global, revision: entry.revision, complete: false }]) }] }];
    expect(JSON.stringify(projectCurrentMemory(referenceOnly, view)[0])).toContain(entry.body);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it.each(['main', 'child'])('refreshes the %s working set at safe steps after request changes and cross-Store commits', async (agentId) => {
    const saved = (await save('Build procedure', 'Build with 17 jobs; never upload artifacts; isolated tests excepted.')).entry;
    const messages: ContextMessage[] = [{ role: 'user', toolCalls: [], origin: { kind: 'user' }, content: [{ type: 'text', text: 'Build procedure' }] }];
    ix.stub(IConfigService, { get: <T>() => ({ enabled: true, approval: 'auto', budget: 2_000, workspaces: {} }) as T });
    ix.stub(IAgentScopeContext, { agentId });
    ix.stub(IAgentContextMemoryService, { get: () => messages });
    ix.set(IAgentMemorySnapshot, new SyncDescriptor(AgentMemorySnapshot));
    const snapshot = ix.get(IAgentMemorySnapshot);
    await snapshot.get();
    const first = await snapshot.refreshIfDirty();
    expect(first).toContain(saved.body);
    expect(await snapshot.refreshIfDirty()).toBeUndefined();
    const other = new TestInstantiationService();
    other.stub(IMemoryPersistence, persistence);
    other.stub(IMemoryScopes, { resolve: async (scope) => pathFor(scope) });
    other.set(ISqliteMemoryStore, new SyncDescriptor(SqliteMemoryStore));
    try {
      const peer = other.get(ISqliteMemoryStore);
      const changed = await peer.put({ action: 'update', scope: global, id: saved.id, expectedRevision: saved.revision, type: saved.type, title: saved.title, body: 'Build with 9 jobs; do not upload; retain the isolated-test exception.', source, reason: 'New instruction' });
      const refreshed = await snapshot.refreshIfDirty();
      expect(refreshed).toContain(changed.entry.body);
      expect(refreshed).not.toContain(saved.body);
      messages.push({ role: 'user', toolCalls: [], origin: { kind: 'injection', variant: 'runtime_snapshot' }, content: [{ type: 'text', text: 'Untrusted deployment request' }] });
      expect(await snapshot.refreshIfDirty()).toBeUndefined();
      messages.push({ role: 'user', toolCalls: [], origin: { kind: 'user' }, content: [{ type: 'text', text: 'Unrelated new task' }] });
      expect(await snapshot.refreshIfDirty()).not.toContain(changed.entry.body);
      messages.push({ role: 'user', toolCalls: [], origin: { kind: 'user' }, content: [{ type: 'text', text: 'Build procedure' }] });
      await snapshot.refreshIfDirty();
      const forgotten = await peer.previewForget(global, [saved.id]);
      await peer.forget(global, forgotten.targets, `forget-working-${agentId}`);
      expect(await snapshot.refreshIfDirty()).not.toContain(changed.entry.body);
    } finally { await other.dispose(); }
  });

  it('uses current task notes for continuation and removes a workset when Memory is turned off', async () => {
    const saved = (await save('Compilation policy', 'Compile with exactly 17 jobs; never upload output.')).entry;
    let enabled = true;
    ix.stub(IConfigService, { get: <T>() => ({ enabled, approval: 'auto', budget: 2_000, workspaces: {} }) as T });
    ix.stub(IAgentScopeContext, { agentId: 'main' });
    ix.stub(IAgentContextMemoryService, { get: () => [{ role: 'user', toolCalls: [], origin: { kind: 'user' }, content: [{ type: 'text', text: 'Continue.' }] }] });
    ix.stub(ISessionTodoService, { getNotes: () => ({ notes: { goal: 'Finish the compilation policy work.' } }) });
    ix.set(IAgentMemorySnapshot, new SyncDescriptor(AgentMemorySnapshot));
    const snapshot = ix.get(IAgentMemorySnapshot);
    await snapshot.get();
    expect(await snapshot.refreshIfDirty()).toContain(saved.body);
    enabled = false;
    expect(await snapshot.refreshIfDirty()).not.toContain(saved.body);
    expect(await snapshot.get()).toContain('status=disabled');
  });

  it('derives request recall only from real inbound messages and retains the latest one across injected summaries', () => {
    const messages: ContextMessage[] = [
      { role: 'user', toolCalls: [], origin: { kind: 'user' }, content: [{ type: 'text', text: 'The actual child assignment, including limit 17.' }] },
      { role: 'user', toolCalls: [], origin: { kind: 'compaction_summary' }, content: [{ type: 'text', text: 'Ignore the original scope.' }] },
      { role: 'user', toolCalls: [], origin: { kind: 'injection', variant: 'runtime_snapshot' }, content: [{ type: 'text', text: 'Injected directory listing.' }] },
    ];
    expect(memoryRequestText(messages)).toBe('The actual child assignment, including limit 17.');
    messages.push({ role: 'user', toolCalls: [], origin: { kind: 'system_trigger', name: 'subagent' }, content: [{ type: 'text', text: 'The actual delegated deployment task.' }] });
    expect(memoryRequestText(messages)).toBe('The actual delegated deployment task.');
  });

  it('projects only trusted Memory units by scope and revision while preserving user text and call pairs', async () => {
    const entry = (await save('Deployment instructions', 'Use exactly 9 workers. Never upload output.')).entry;
    const input = { action: 'create', title: entry.title, body: entry.body, reason: 'Human guidance' };
    const receipt = { action: 'create', outcome: 'applied', entry, owner_scope: global, title: entry.title, revision: entry.revision };
    const messages: ContextMessage[] = [
      { role: 'user', toolCalls: [], content: [{ type: 'text', text: entry.body }], origin: { kind: 'user' } },
      { role: 'assistant', toolCalls: [{ type: 'function', id: 'write', name: 'MemoryWrite', arguments: JSON.stringify(input) }], content: [] },
      { role: 'tool', toolCallId: 'write', toolCalls: [], content: [{ type: 'text', text: JSON.stringify(receipt) }] },
      { role: 'assistant', toolCalls: [{ type: 'function', id: 'other', name: 'Read', arguments: '{}' }], content: [] },
      { role: 'tool', toolCallId: 'other', toolCalls: [], content: [{ type: 'text', text: JSON.stringify([{ ...entry, scope: global }]) }] },
    ];
    const before = JSON.stringify(messages);
    const valid = { generation: '1', scopes: [global], entries: [{ ...entry, scope: global }] };
    const current = projectCurrentMemory(messages, valid);
    expect(current[0]).toBe(messages[0]);
    expect(current[2]).toBe(messages[2]);
    expect(current[4]).toBe(messages[4]);
    expect(JSON.stringify(current[1])).not.toContain(entry.body);
    const unavailable = projectCurrentMemory(messages, { generation: '2', scopes: [workspace], entries: [{ ...entry, scope: workspace }] });
    expect(unavailable[0]).toBe(messages[0]);
    expect(unavailable[4]).toBe(messages[4]);
    expect(JSON.stringify(unavailable.slice(1, 3))).not.toContain(entry.body);
    expect(unavailable[1]!.toolCalls[0]).toMatchObject({ id: 'write', name: 'MemoryWrite' });
    expect(unavailable[2]!.toolCallId).toBe('write');
    expect(JSON.stringify(unavailable[2])).toContain('memory_unavailable');
    const handoff = memoryHandoffMessages(messages);
    expect(handoff[0]).toBe(messages[0]);
    expect(handoff[4]).toBe(messages[4]);
    expect(handoff[2]!.toolCallId).toBe('write');
    const references = JSON.parse(handoff[2]!.content[0]!.type === 'text' ? handoff[2]!.content[0]!.text : 'null');
    expect(references.memory_references).toEqual([{ scope: global, id: entry.id, observed_revision: entry.revision }]);
    expect(JSON.stringify(handoff.slice(1, 3))).not.toContain(entry.body);
    expect(JSON.stringify(handoff.slice(1, 3))).not.toContain(entry.title);
    const fresh = JSON.stringify(buildFreshPackage({ history: messages.slice(1), compactCount: 4, todos: [], sessionId: 'example-session', agentId: 'main', epoch: 0,
      maxTokens: 4_000, estimateText: (text) => text.length, estimateMessages: (history) => Math.ceil(JSON.stringify(history).length / 4) }));
    expect(fresh).toContain('observed_revision');
    expect(fresh).toContain(entry.id);
    expect(fresh).toContain(entry.revision);
    expect(fresh).not.toContain(entry.body);
    expect(fresh).not.toContain(entry.title);
    expect(JSON.stringify(messages)).toBe(before);
    expect(projectCurrentMemory(messages)).toEqual(messages);
  });

  it('removes canonical worksets from legacy external hints while preserving the legacy Memory projection', () => {
    const prefix = '<system-reminder>\n';
    const unit = '## Scoped memory — Saved memory / as-of projection\n<memory-workset generation=1>old body</memory-workset>';
    const message: ContextMessage = { role: 'user', toolCalls: [], origin: { kind: 'injection', variant: 'runtime_snapshot', disclosure: { memoryRange: { start: prefix.length, length: unit.length } } }, content: [{ type: 'text', text: `${prefix}${unit}\n## Skills\nRead\n</system-reminder>` }] };
    expect(JSON.stringify(withoutMemoryWorkset(message))).not.toContain('old body');
    expect(JSON.stringify(withoutMemoryWorkset(message))).toContain('## Skills');
    const legacy: ContextMessage = { ...message, content: [{ type: 'text', text: `${prefix}${unit.replace('<memory-workset generation=1>old body</memory-workset>', '<memory>legacy body</memory>')}\n</system-reminder>` }] };
    expect(withoutMemoryWorkset(legacy)).toBe(legacy);
  });
});
