import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MemoryWorker } from '#/persistence/backends/sqliteMemory/host';
import { configureMemoryWorkerRuntime } from '#/persistence/backends/sqliteMemory/protocol';
import { join } from 'node:path';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IMemoryScopes, MemoryScopes, type MemoryScope } from '#/app/memory/memoryScopes';
import { ILegacyMemoryStore, IMemoryStore, MemoryStore, decodeMemoryEntry, type MemoryEntry } from '#/app/memory/memoryStore';
import { IWorkspacePersistence } from '#/app/workspace/workspacePersistence';
import { stubClientIdentity } from '../bootstrap/stubs';
import { IMemoryAuthorityService, MemoryAuthorityService, MemoryAuthorityStore } from '#/app/memory/memoryAuthorityStore';
import { MemoryAuthorityAccess, MEMORY_AUTHORITY_SCOPE } from '#/persistence/memoryAuthority';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
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

function toolText(output: unknown): string {
  if (typeof output !== 'string') throw new Error('Expected a complete serialized Memory tool result');
  return output;
}
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

  it('imports equal archived sources as independent objects across pages and reopen', async () => {
    const seed = (await save('Archive fixture')).entry;
    const entries = ['m_archive_first', 'm_archive_second', 'm_archive_third'].map((id): MemoryEntry => ({ ...seed, id, title: id, status: 'archived', source: { writer: 'agent', session: 'archive-fixture', turn: 17 }, body: 'Replaced by m_retained.', superseded_by: undefined }));
    const records = entries.map((entry) => ({ scope: 'memory/global', key: `entries/${entry.id}.md`, payload: JSON.stringify(entry), entry }));
    expect(await persistence.importLegacy(records.slice(0, 1))).toMatchObject({ imported: 1, issues: [] });
    await close(); bind();
    expect(await persistence.importLegacy(records.slice(1))).toMatchObject({ imported: 2, issues: [] });
    expect(await persistence.importLegacy(records)).toMatchObject({ imported: 0, retained: 3, issues: [] });
    for (const entry of entries) {
      expect(await store.get(global, entry.id)).toEqual(entry);
      expect((await store.provenance(global, entry.id)).relatedObjectIds).toEqual([entry.id]);
      expect((await store.provenance(global, entry.id)).sources.map((source) => source.payload)).toEqual([JSON.stringify(entry)]);
      expect((await store.previewForget(global, [entry.id])).targets.map((target) => target.id)).toEqual([entry.id]);
    }
  });

  it('keeps equal native fingerprints independent while enforcing explicit stable sources and forget barriers', async () => {
    const origin = { writer: 'agent' as const, session: 'independent-source-fixture', turn: 17 };
    const mutation = { scope: global, type: 'feedback' as const, title: 'First independent rule', body: 'Identical retained condition.', source: origin, reason: 'Independent instruction' };
    const unit = { id: 'explicit-first', payload: mutation.body, origin: 'owner' as const };
    const first = await store.ingest({ mutation, unit });
    const second = await store.ingest({ mutation: { ...mutation, title: 'Second independent rule' }, unit: { ...unit, id: 'explicit-second' } });
    expect(second.entry.id).not.toBe(first.entry.id);
    const updated = await store.ingest({ mutation: { ...mutation, action: 'update', id: second.entry.id, expectedRevision: second.entry.revision, title: 'Second renamed rule' }, unit: { ...unit, id: 'explicit-update' } });
    expect(updated.entry.id).toBe(second.entry.id);
    await expect(store.ingest({ mutation, unit: { ...unit, payload: 'Changed stable payload.' } })).rejects.toThrow('new source revision identity');
    await expect(store.ingest({ mutation: { ...mutation, action: 'update', id: updated.entry.id, expectedRevision: updated.entry.revision }, unit })).rejects.toThrow('another Memory lineage');
    expect((await store.previewForget(global, [first.entry.id])).targets.map((target) => target.id)).toEqual([first.entry.id]);
    await store.forget(global, [{ id: first.entry.id, expectedRevision: first.entry.revision }], 'forget-independent-first');
    expect(await store.get(global, updated.entry.id)).toEqual(updated.entry);
    const archived = await store.put({ action: 'archive', scope: global, id: updated.entry.id, expectedRevision: updated.entry.revision, reason: 'Retire independent rule', source: origin });
    expect(archived.entry.status).toBe('archived');
    await expect(store.put({ ...mutation, action: 'create', title: 'New replay after forgetting' })).rejects.toThrow('source unit has been forgotten');
    await expect(store.ingest({ mutation, unit })).rejects.toThrow('source unit has been forgotten');
  });

  it.each(['supersede', 'proposal'] as const)('transfers an independent peer lineage through %s after its equal-source peer is forgotten', async (action) => {
    const seed = (await save('Independent peer fixture')).entry;
    const origin = { writer: 'agent' as const, session: 'retained-peer-fixture', turn: 17 };
    const [first, second] = ['m_forgotten_peer', 'm_retained_peer'].map((id): MemoryEntry => ({ ...seed, id, title: id, source: origin }));
    const records = [first!, second!].map((entry) => ({ scope: 'memory/global', key: `entries/${entry.id}.md`, payload: JSON.stringify(entry), entry }));
    expect(await persistence.importLegacy(records)).toMatchObject({ imported: 2, issues: [] });
    await store.forget(global, [{ id: first!.id, expectedRevision: first!.revision }], 'forget-equal-source-peer');
    await close(); bind();
    const result = await store.put({ action: action === 'proposal' ? 'update' : 'supersede', pending: action === 'proposal', scope: global, id: second!.id, expectedRevision: second!.revision, type: second!.type, title: 'Replacement independent rule', body: second!.body, source: origin, reason: 'Retain the complete instruction' });
    const ids = [second!.id, result.entry.id].toSorted();
    expect((await store.previewForget(global, [second!.id])).targets.map((target) => target.id)).toEqual(ids);
    expect((await store.provenance(global, result.entry.id)).sources).toContainEqual(expect.objectContaining({ payload: records[1]!.payload }));
    expect(await store.get(global, first!.id)).toBeUndefined();
    if (action === 'proposal') {
      const approved = await store.put({ action: 'update', scope: global, id: result.entry.id, expectedRevision: result.entry.revision, type: result.entry.type, title: result.entry.title, body: result.entry.body, source, reason: 'Approve the retained peer proposal' });
      expect(approved.entry.id).toBe(second!.id);
      expect(approved.entry.status).toBe('active');
    } else {
      expect(result.entry.status).toBe('active');
      expect((await store.get(global, second!.id))?.superseded_by).toBe(result.entry.id);
      const restoredSource = await store.put({ action: 'supersede', scope: global, id: result.entry.id, expectedRevision: result.entry.revision, type: result.entry.type, title: 'Next independent successor', body: result.entry.body, source: origin, reason: 'Keep the same source lineage' });
      expect((await store.previewForget(global, [restoredSource.entry.id])).targets.map((target) => target.id).toSorted()).toEqual([...ids, restoredSource.entry.id].toSorted());
    }
    expect(await persistence.importLegacy(records.slice(0, 1))).toMatchObject({ imported: 0, issues: [expect.objectContaining({ issue: 'forgotten_source_rejected' })] });
    await expect(store.put({ action: 'create', scope: global, type: second!.type, title: 'Unrelated replay', body: second!.body, source: origin, reason: 'Unrelated creation' })).rejects.toThrow('source unit has been forgotten');
  });

  it('rejects invalid transfers before granting a forgotten signature to a new identity', async () => {
    const seed = (await save('Transfer boundary fixture')).entry;
    const origin = { writer: 'agent' as const, session: 'transfer-boundary-fixture', turn: 17 };
    const [first, second] = ['m_transfer_forgotten', 'm_transfer_retained'].map((id): MemoryEntry => ({ ...seed, id, title: id, source: origin }));
    await persistence.importLegacy([first!, second!].map((entry) => ({ scope: 'memory/global', key: `entries/${entry.id}.md`, payload: JSON.stringify(entry), entry })));
    await store.forget(global, [{ id: first!.id, expectedRevision: first!.revision }], 'forget-transfer-peer');
    const before = await persistence.read(['memory/global']);
    const replacement = { ...second!, id: 'm_invalid_successor', revision: 'mem2:invalid-successor', title: 'Invalid successor' };
    const target = { scope: 'memory/global', id: replacement.id, expectedRevision: null, entry: replacement, revision: replacement.revision };
    const invalid: MemoryCommit[] = [
      { operationId: 'transfer-forgotten-parent', request: 'forgotten-parent', expectedGeneration: before.generation, edits: [{ ...target, entry: { ...replacement, status: 'pending', supersedes: first!.id, supersedes_revision: first!.revision } }], sourceTransfers: [{ scope: 'memory/global', from: first!.id, to: replacement.id }], result: {} },
      { operationId: 'transfer-stale-proposal', request: 'stale-proposal', expectedGeneration: before.generation, edits: [{ ...target, entry: { ...replacement, status: 'pending', supersedes: second!.id, supersedes_revision: 'stale' } }], sourceTransfers: [{ scope: 'memory/global', from: second!.id, to: replacement.id }], result: {} },
      { operationId: 'transfer-active-parent', request: 'active-parent', expectedGeneration: before.generation, edits: [{ scope: 'memory/global', id: second!.id, expectedRevision: second!.revision, revision: 'mem2:still-active', entry: { ...second!, revision: 'mem2:still-active' } }, target], sourceTransfers: [{ scope: 'memory/global', from: second!.id, to: replacement.id }], result: {} },
      { operationId: 'transfer-deleted-active-parent', request: 'deleted-active-parent', expectedGeneration: before.generation, edits: [{ scope: 'memory/global', id: second!.id, expectedRevision: second!.revision, revision: 'mem2:invalid-delete', entry: null }, target], sourceTransfers: [{ scope: 'memory/global', from: second!.id, to: replacement.id }], result: {} },
      { operationId: 'transfer-misdirected-successor', request: 'misdirected-successor', expectedGeneration: before.generation, edits: [{ scope: 'memory/global', id: second!.id, expectedRevision: second!.revision, revision: 'mem2:invalid-link', entry: { ...second!, status: 'superseded', superseded_by: 'm_unrelated', revision: 'mem2:invalid-link' } }, target], sourceTransfers: [{ scope: 'memory/global', from: second!.id, to: replacement.id }], result: {} },
    ];
    for (const [index, commit] of invalid.entries()) {
      await expect(persistence.commit(commit)).rejects.toMatchObject({ code: 'revision_conflict', message: index < 2 ? 'Memory proposal source changed' : 'Invalid Memory source lineage transfer' });
      expect(await persistence.receipt(commit.operationId)).toBeUndefined();
      expect(await persistence.read(['memory/global'])).toEqual(before);
    }
    await expect(persistence.commit({ operationId: 'unrelated-signature-create', request: 'unrelated-create', expectedGeneration: before.generation, edits: [target], result: {} })).rejects.toThrow('source has a forget barrier');
    await store.delete(global, second!.id, second!.revision);
    const deleted = await persistence.read(['memory/global']);
    const tombstone = deleted.objects.find((object) => object.id === second!.id)!;
    const resurrection: MemoryCommit = { operationId: 'transfer-deleted-preimage', request: 'deleted-preimage', expectedGeneration: deleted.generation, edits: [{ scope: 'memory/global', id: second!.id, expectedRevision: tombstone.revision, revision: 'mem2:invalid-resurrection', entry: { ...second!, status: 'superseded', superseded_by: replacement.id, revision: 'mem2:invalid-resurrection' } }, target], sourceTransfers: [{ scope: 'memory/global', from: second!.id, to: replacement.id }], result: {} };
    await expect(persistence.commit(resurrection)).rejects.toMatchObject({ code: 'revision_conflict', message: 'Invalid Memory source lineage transfer' });
    expect(await persistence.read(['memory/global'])).toEqual(deleted);
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

  it('upgrades schema-1 sources without merging independent IDs or overwriting corrections', async () => {
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
    expect(replay).toMatchObject({ imported: 1, issues: [] });
    expect(await store.get(global, duplicate.id)).toEqual(duplicate);
    expect((await store.provenance(global, duplicate.id)).relatedObjectIds).toEqual([duplicate.id]);
    expect((await store.get(global, entry.id))?.body).toBe(corrected.entry.body);
  });

  it('applies imported-source correction and forget to a changed legacy ID and real lorebook reimport', async () => {
    const original: MemoryEntry = { ...((await save('Seed')).entry), id: 'm_source_original', title: 'Address source', body: 'Address A', source: { writer: 'import', session: 'example-source', turn: 2 }, basis: { kind: 'observed', note: 'Exact source fact', refs: ['fixture://source/original'] } };
    const importEntry = (entry: MemoryEntry) => persistence.importLegacy([{ scope: 'memory/global', key: `entries/${entry.id}.md`, payload: JSON.stringify(entry), entry }]);
    await importEntry(original);
    const corrected = await update(original, 'A was mistaken; always Address B.');
    const independent = { ...original, id: 'm_source_independent', title: 'Independent source object' };
    expect(await importEntry(independent)).toMatchObject({ imported: 1, issues: [] });
    expect(await store.get(global, independent.id)).toEqual(independent);
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
    const output = toolText(result.output);
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
    expect(toolText(oversized.output)).toContain('smaller page_size');
    const recovered = await run(8);
    expect(recovered.isError).not.toBe(true);
    expect(memoryTextFits(toolText(recovered.output), 24_000, 6_000)).toBe(true);
    expect(JSON.parse(toolText(recovered.output)).items).toHaveLength(8);
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
    const input = { action: 'create', scope: 'global', type: 'feedback', title: entry.title, body: entry.body,
      reason: 'Human guidance: use exactly 9 workers', expected_revision: 'previous-observation', validity: null,
      basis: { kind: 'human', note: 'Owner requested 9 workers', refs: ['history:example/t9'] }, pinned: false };
    const { body: _body, ...nonBodyInput } = input;
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
    expect(JSON.parse(current[1]!.toolCalls[0]!.arguments!)).toEqual(nonBodyInput);
    const changed = (await update(entry, 'Use exactly 5 workers. Never upload output.')).entry;
    for (const entries of [[{ ...changed, scope: global }], []]) {
      const invalidated = projectCurrentMemory(messages, { generation: '2', scopes: [global], entries });
      for (const oldText of [entry.body, entry.title, input.reason, input.basis.note, input.basis.refs[0]!]) expect(JSON.stringify(invalidated.slice(1, 3))).not.toContain(oldText);
      expect(JSON.parse(invalidated[1]!.toolCalls[0]!.arguments!)).toEqual({ action: input.action, scope: input.scope, memory_content_omitted: true });
    }
    const failed = [messages[1]!, { ...messages[2]!, isError: true }];
    expect(projectCurrentMemory(failed, { generation: '2', scopes: [global], entries: [] })).toEqual(failed);
    expect(memoryHandoffMessages(failed)).toEqual(failed);
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

function managedMemory() {
  ix.set(ILegacyMemoryStore, new SyncDescriptor(MemoryStore));
  ix.set(IMemoryStore, new SyncDescriptor(MemoryAuthorityStore));
  ix.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
  ix.set(IMemoryAuthorityService, new SyncDescriptor(MemoryAuthorityService));
  return { memory: ix.get(IMemoryStore), authority: ix.get(IMemoryAuthorityService), legacy: ix.get(ILegacyMemoryStore) };
}
const migration = () => ({ operationId: randomUUID() });
const createManaged = (memory: IMemoryStore, title: string, body = 'Use 9 workers; never upload output.') => memory.put({ action: 'create', scope: global, type: 'feedback', title, body, reason: 'Owner guidance', source });

describe('single Memory authority and isolated recovery', () => {
  it.each([false, true])('automatically migrates a cold App with an unprepared session index and disabled Memory (failed marker: %s)', async (failed) => {
    const { bootstrap, logSeed, resolveLoggingConfig } = await import('#/index');
    const { ISessionIndex } = await import('#/app/sessionIndex/sessionIndex');
    const targets: MemoryScope[] = [global, workspace, { kind: 'persona', personaId: 'cold-start' }, { kind: 'persona_workspace', workspaceId: workspace.workspaceId, personaId: 'cold-start' }];
    const entries = targets.map((scope, index) => {
      const id = `m_cold_start_${index}`;
      const raw = `---\n${JSON.stringify({ id, type: 'feedback', title: `Cold startup sentinel ${index}`, status: 'active', pinned: true, created: '2026-01-01', updated: '2026-01-01', source, reason: 'Owner instruction' })}\n---\nRetain the pinned sentinel and exact exception ${index + 17}.\n`;
      return { scope, id, raw, entry: decodeMemoryEntry(raw) };
    });
    for (const item of entries) await storage.write(pathFor(item.scope), `entries/${item.id}.md`, new TextEncoder().encode(item.raw));
    await writeFile(join(home, 'config.toml'), '[memory]\nenabled = false\n');
    const interruptedId = randomUUID();
    if (failed) await storage.write(MEMORY_AUTHORITY_SCOPE, 'backend.json', new TextEncoder().encode(JSON.stringify({ version: 1, epoch: 0, backend: 'legacy', mode: 'migrating', migration: { id: interruptedId, namespaces: [], index: 0, issues: [], phase: 'failed', failure: { code: 'session.index_building', message: 'session index is building' } } })));
    const env = { KIKI_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL: 'true' };
    const open = () => bootstrap({ homeDir: home, clientIdentity: stubClientIdentity, env }, logSeed(resolveLoggingConfig({ homeDir: home, env })));
    let app = open();
    try {
      expect(app.app.accessor.get(ISessionIndex).status()).toMatchObject({ source: 'read-model', state: 'uninitialized' });
      const state = await app.memoryReady;
      expect(state).toMatchObject({ backend: 'sqlite', mode: 'active' });
      if (failed) expect(state.migrationId).toBe(interruptedId);
      const memory = app.app.accessor.get(IMemoryStore);
      for (const item of entries) {
        expect(await memory.get(item.scope, item.id)).toEqual(item.entry);
        expect(new TextDecoder().decode((await storage.read(pathFor(item.scope), `entries/${item.id}.md`))!)).toBe(item.raw);
      }
      expect(app.app.accessor.get(IConfigService).get<{ enabled: boolean }>('memory').enabled).toBe(false);
      expect(app.app.accessor.get(ISessionIndex).status().state).toBe('uninitialized');
      const checkpoint = await memory.checkpoint!();
      await app.app.dispose();
      app = open();
      expect(await app.memoryReady).toEqual(state);
      expect(await app.app.accessor.get(IMemoryStore).checkpoint!()).toBe(checkpoint);
      for (const item of entries) expect(await app.app.accessor.get(IMemoryStore).get(item.scope, item.id)).toEqual(item.entry);
      expect(app.app.accessor.get(IConfigService).get<{ enabled: boolean }>('memory').enabled).toBe(false);
    } finally { await app.app.dispose(); }
  }, 60_000);

  it('resolves registered and on-disk Memory workspaces without legacy workspace discovery', async () => {
    const registered = 'wd_registered_abcdef012345';
    const catalog = vi.fn(async () => ({ workspaces: [{ id: registered, root: '/example', name: 'Example', createdAt: 1, lastOpenedAt: 1, pinned: false }], deletedIds: [] }));
    ix.stub(IWorkspacePersistence, { load: catalog });
    ix.set(IMemoryScopes, new SyncDescriptor(MemoryScopes));
    const scopes = ix.get(IMemoryScopes);
    await storage.write(pathFor(workspace), 'entries/m_existing.md', new TextEncoder().encode('Existing namespace'));
    expect(await scopes.resolve(workspace)).toBe(pathFor(workspace));
    expect(catalog).not.toHaveBeenCalled();
    expect(await scopes.resolve({ kind: 'workspace', workspaceId: registered })).toBe(`memory/workspaces/${registered}`);
    expect(await scopes.listWorkspaceIds!()).toEqual([registered, workspace.workspaceId]);
    await expect(scopes.resolve({ kind: 'workspace', workspaceId: 'wd_unknown_0123456789ab' })).rejects.toThrow('Workspace not found');
    await expect(scopes.resolve({ kind: 'workspace', workspaceId: '../invalid' })).rejects.toThrow('Invalid workspace id');
  });

  it('reports real Memory namespace storage failures without publishing SQLite authority', async () => {
    const { authority } = managedMemory();
    const original = storage.list.bind(storage);
    const failure = Object.assign(new Error('Memory directory cannot be read'), { code: 'storage.io_failed' });
    vi.spyOn(storage, 'list').mockImplementation((scope, prefix) => scope === 'memory/workspaces' ? Promise.reject(failure) : original(scope, prefix));
    await expect(authority.prepare()).rejects.toBe(failure);
    expect(await authority.status()).toMatchObject({ backend: 'legacy', mode: 'migrating', migration: { phase: 'failed', failure: { code: failure.code, message: failure.message } } });
    const resolver = new TestInstantiationService();
    resolver.stub(IWorkspacePersistence, { load: async () => undefined });
    resolver.stub(IFileSystemStorageService, storage);
    resolver.set(IMemoryScopes, new SyncDescriptor(MemoryScopes));
    try {
      await expect(resolver.get(IMemoryScopes).listWorkspaceIds!()).rejects.toBe(failure);
      const size = vi.spyOn(storage, 'size').mockRejectedValue(failure);
      await expect(resolver.get(IMemoryScopes).resolve(workspace)).rejects.toBe(failure);
      size.mockRestore();
    } finally { await resolver.dispose(); }
  });

  it('keeps legacy authoritative during shadow import and routes the same tools to SQLite after cutover without dual writes', async () => {
    const { memory, authority, legacy } = managedMemory();
    const saved = await createManaged(legacy, 'Stable identity');
    const initial = await storage.read('memory/global', `entries/${saved.entry.id}.md`);
    await ix.get(IMemoryShadowImport).run(global);
    expect((await authority.status()).backend).toBe('legacy');
    await memory.prepare?.();
    expect(await authority.status()).toMatchObject({ backend: 'sqlite', mode: 'active' });
    expect(await memory.get(global, saved.entry.id)).toEqual(saved.entry);
    const before = await memory.checkpoint!();
    await memory.prepare?.();
    expect(await memory.checkpoint!()).toBe(before);
    expect((await memory.snapshot!([global])).entries).toContainEqual({ ...saved.entry, scope: global });
    const tool = ix.get(IMemoryWriteTool);
    const execution = tool.resolveExecution({ action: 'update', id: saved.entry.id, scope: 'global', expected_revision: saved.entry.revision, type: 'feedback', title: saved.entry.title, body: 'Use 5 workers; never upload output.', reason: 'Owner correction' });
    if (!('execute' in execution)) throw new Error('Expected normal Memory write execution');
    const result = await execution.execute({ turnId: 2, toolCallId: 'managed-write', signal: new AbortController().signal });
    expect(result.isError).not.toBe(true);
    expect((await memory.get(global, saved.entry.id))?.body).toBe('Use 5 workers; never upload output.');
    expect(await storage.read('memory/global', `entries/${saved.entry.id}.md`)).toEqual(initial);
    await expect(createManaged(legacy, 'Old writer')).rejects.toThrow('authority changed');
    const child = await promisify(execFile)(process.execPath, [createRequire(import.meta.url).resolve('tsx/cli'), '--tsconfig', 'tsconfig.json', 'test/fixtures/memoryLegacyWriter.mts', home], { cwd: process.cwd(), timeout: 15_000 });
    expect(JSON.parse(child.stdout.trim())).toMatchObject({ written: false, code: 'storage.locked' });
  });

  it('reconciles a legacy deletion and an incremental correction after a completed shadow pass', async () => {
    const { memory, authority, legacy } = managedMemory();
    const deleted = await createManaged(legacy, 'Delete after shadow');
    const corrected = await createManaged(legacy, 'Correct after shadow');
    await ix.get(IMemoryShadowImport).run(global);
    const operation = await legacy.delete(global, deleted.entry.id, deleted.entry.revision);
    const latest = await legacy.put({ action: 'update', scope: global, id: corrected.entry.id, expectedRevision: corrected.entry.revision, type: corrected.entry.type, title: corrected.entry.title, body: 'Use 5 workers with the original exception.', reason: 'Correction before cutover', source });
    expect((await authority.prepare()).backend).toBe('sqlite');
    expect(await memory.get(global, deleted.entry.id)).toBeUndefined();
    expect(await memory.get(global, corrected.entry.id)).toEqual(latest.entry);
    expect((await memory.undo(global, operation))?.body).toBe(deleted.entry.body);
  });

  it('persists the paused write barrier across reopen and resumes the exact migration', async () => {
    let managed = managedMemory();
    const saved = await createManaged(managed.legacy, 'Paused migration');
    await mkdir(join(home, pathFor(workspace)), { recursive: true });
    const input = migration();
    const paused = await managed.authority.migrate({ ...input, maxPages: 1 });
    expect(paused.mode).toBe('migrating');
    await expect(createManaged(managed.legacy, 'Blocked old writer')).rejects.toThrow('write barrier');
    await close();
    bind();
    managed = managedMemory();
    expect((await managed.authority.status()).migration?.id).toBe(input.operationId);
    await managed.memory.prepare?.();
    expect(await managed.authority.status()).toMatchObject({ mode: 'active', migrationId: input.operationId });
    expect(await managed.memory.get(global, saved.entry.id)).toEqual(saved.entry);
    await expect(managed.authority.migrate(migration())).rejects.toThrow('different migration');
  });

  it('cancels a paused maintenance batch without disabling the next automatic preparation', async () => {
    const { memory, legacy, authority } = managedMemory();
    const saved = await createManaged(legacy, 'Retain through maintenance cancellation');
    await mkdir(join(home, pathFor(workspace)), { recursive: true });
    const input = migration();
    expect((await authority.migrate({ ...input, maxPages: 1 })).mode).toBe('migrating');
    await expect(authority.cancelMigration(randomUUID())).rejects.toThrow('does not match');
    expect(await authority.cancelMigration(input.operationId)).toMatchObject({ backend: 'legacy', mode: 'active' });
    await memory.prepare!();
    expect((await authority.status()).backend).toBe('sqlite');
    expect(await memory.get(global, saved.entry.id)).toEqual(saved.entry);
  });

  it('resumes the persisted startup operation after its importing process exits without cleanup', async () => {
    const { legacy, memory, authority } = managedMemory();
    const first = await createManaged(legacy, 'Interrupted startup rule');
    const persona = { kind: 'persona', personaId: 'startup-example' } as const;
    const second = await legacy.put({ action: 'create', scope: persona, type: 'reference', title: 'Persona retained through restart', body: 'Retain this exact persona-only condition.', reason: 'Owner instruction', source });
    const run = promisify(execFile)(process.execPath, ['--import', 'tsx', '--import', '../../build/register-raw-text-loader.mjs', 'test/fixtures/memoryStartupInterrupted.mts', home], { cwd: process.cwd(), timeout: 20_000 });
    const crashed = await run.then(() => { throw new Error('Expected interrupted startup'); }, (error: { code: number; stdout: string; stderr: string }) => error);
    expect(crashed.code, crashed.stderr).toBe(73);
    const interrupted = JSON.parse(crashed.stdout.trim());
    expect(interrupted).toMatchObject({ backend: 'legacy', mode: 'migrating', migration: { phase: 'importing', index: 1 } });
    expect((await authority.status()).migration?.id).toBe(interrupted.migration.id);
    await memory.prepare!();
    expect(await authority.status()).toMatchObject({ backend: 'sqlite', mode: 'active', migrationId: interrupted.migration.id });
    expect(await memory.get(global, first.entry.id)).toEqual(first.entry);
    expect(await memory.get(persona, second.entry.id)).toEqual(second.entry);
  }, 30_000);

  it.each(['retry', 'startup', 'batch'] as const)('repairs old source collisions and continues index 7 under the same operation through %s', async (resume) => {
    const namespaces = ['memory/global', ...Array.from({ length: 13 }, (_,index) => `memory/workspaces/wd_recovery_${index.toString(16).padStart(12, '0')}`)];
    for (const base of namespaces) await mkdir(join(home, base), { recursive: true });
    const base = namespaces[5]!;
    const entries = ['m_archived_first', 'm_archived_second'].map((id) => {
      const raw = `---\n${JSON.stringify({ id, type: 'feedback', title: id, status: 'archived', pinned: false, created: '2026-01-01', updated: '2026-01-02', source: { writer: 'agent', session: 'archive-recovery-fixture', turn: 17 }, reason: 'Batch archive' })}\n---\nReplaced by m_retained.\n`;
      return { raw, entry: decodeMemoryEntry(raw) };
    });
    for (const { raw, entry } of entries) await storage.write(base, `entries/${entry.id}.md`, new TextEncoder().encode(raw));
    const first = entries[0]!;
    await persistence.importLegacy([{ scope: base, key: `entries/${first.entry.id}.md`, payload: first.raw, entry: first.entry }]);
    const operationId = randomUUID();
    await storage.write(MEMORY_AUTHORITY_SCOPE, 'backend.json', new TextEncoder().encode(JSON.stringify({ version: 1, epoch: 0, backend: 'legacy', mode: 'migrating', migration: { id: operationId, namespaces, index: 7, phase: 'failed', issues: [{ scope: base, key: `entries/${entries[1]!.entry.id}.md`, issue: 'source_lineage_preserved' }], failure: { code: 'memory.source_invalid', message: 'Previous source collision' } } })));
    await close(); bind();
    const { memory, authority } = managedMemory();
    const shadow = vi.spyOn(ix.get(IMemoryShadowImport), 'run');
    const indexes: number[] = [];
    const write = storage.write.bind(storage);
    vi.spyOn(storage, 'write').mockImplementation(async (...args) => {
      if (args[0] === MEMORY_AUTHORITY_SCOPE) { const state = JSON.parse(new TextDecoder().decode(args[2])); if (state.migration !== undefined) indexes.push(state.migration.index); }
      return write(...args);
    });
    if (resume === 'retry') await authority.retryMigration(operationId);
    else if (resume === 'batch') {
      expect(await authority.migrate({ operationId, maxPages: 1 })).toMatchObject({ migration: { id: operationId, index: 8 } });
      await memory.prepare!();
    } else await memory.prepare!();
    expect(await authority.status()).toMatchObject({ backend: 'sqlite', mode: 'active', migrationId: operationId });
    expect(indexes[0]).toBe(7);
    expect(Math.min(...indexes)).toBe(7);
    expect(shadow.mock.calls.map(([scope]) => pathFor(scope))).toEqual([base, ...namespaces.slice(7)]);
    const target = { kind: 'workspace', workspaceId: base.split('/').at(-1)! } as const;
    for (const { entry, raw } of entries) {
      expect(await memory.get(target, entry.id)).toEqual(entry);
      expect((await authority.provenance(target, entry.id)).relatedObjectIds).toEqual([entry.id]);
      expect(new TextDecoder().decode(await storage.read(base, `entries/${entry.id}.md`))).toBe(raw);
    }
    const checkpoint = await memory.checkpoint!();
    expect((await authority.retryMigration(operationId)).migrationId).toBe(operationId);
    expect(await memory.checkpoint!()).toBe(checkpoint);
  });

  it('completes migration with visible retained-revision and forgotten-source issues', async () => {
    const { memory, authority, legacy } = managedMemory();
    const original = await createManaged(legacy, 'Curated before cutover');
    const forgotten = await createManaged(legacy, 'Forgotten before cutover');
    const raw = await storage.read('memory/global', `entries/${forgotten.entry.id}.md`);
    await ix.get(IMemoryShadowImport).run(global);
    const corrected = await update(original.entry, 'Only this corrected instruction applies.');
    await store.forget(global, [{ id: forgotten.entry.id, expectedRevision: forgotten.entry.revision }], 'forget-before-cutover');
    const state = await authority.prepare();
    expect(state).toMatchObject({ backend: 'sqlite', mode: 'active', migrationIssues: expect.arrayContaining([expect.objectContaining({ issue: 'current_revision_preserved' }), expect.objectContaining({ issue: 'forgotten_source_rejected', key: `entries/${forgotten.entry.id}.md` })]) });
    expect(await memory.get(global, original.entry.id)).toEqual(corrected.entry);
    expect(await memory.get(global, forgotten.entry.id)).toBeUndefined();
    expect(await storage.read('memory/global', `entries/${forgotten.entry.id}.md`)).toEqual(raw);
    expect((await createManaged(memory, 'Write after retained issues')).outcome).toBe('applied');
    await close(); bind();
    expect(await managedMemory().authority.status()).toEqual(state);
  });

  it.each(['migrate', 'retry'] as const)('uses durable forget barriers beyond 1000 migration notes through %s', async (resume) => {
    const seed: MemoryEntry = { id: 'm_limit_seed', revision: 'mem2:limit-seed', type: 'feedback', title: 'Forgotten entry', body: 'Equal source and complete body.', status: 'active', pinned: false, source: { writer: 'agent', session: 'migration-limit-fixture', turn: 17 }, reason: 'Independent instruction', created: '2026-01-01', updated: '2026-01-01' };
    const entries = Array.from({ length: 1001 }, (_, index) => ({ ...seed, id: `m_limit_${String(index).padStart(4, '0')}` }));
    const record = (entry: MemoryEntry) => ({ scope: 'memory/global', key: `entries/${entry.id}.md`, payload: JSON.stringify(entry), entry });
    for (let offset = 0; offset < entries.length; offset += 1000) await persistence.importLegacy(entries.slice(offset, offset + 1000).map(record));
    for (let offset = 0; offset < entries.length; offset += 1000) await store.forget(global, entries.slice(offset, offset + 1000).map((entry) => ({ id: entry.id, expectedRevision: entry.revision })), `forget-limit-${offset}`);
    const input = migration();
    if (resume === 'retry') await storage.write(MEMORY_AUTHORITY_SCOPE, 'backend.json', new TextEncoder().encode(JSON.stringify({ version: 1, epoch: 0, backend: 'legacy', mode: 'migrating', migration: { id: input.operationId, namespaces: ['memory/global'], index: 1, phase: 'failed', issues: [{ scope: 'memory/global', key: entries.at(-1)!.id, issue: 'legacy_head_missing' }], failure: { code: 'memory.source_invalid', message: 'Previous truncated forget notes' } } })));
    await close(); bind();
    const { memory, authority, legacy } = managedMemory();
    vi.spyOn(legacy, 'inventory').mockResolvedValue({ entries, complete: true, warnings: [], fingerprint: 'forgotten-inventory' });
    vi.spyOn(ix.get(IMemoryShadowImport), 'run').mockImplementation(async (_scope, after) => {
      const page = entries.filter((entry) => after === undefined || record(entry).key > after).slice(0, 128);
      const imported = await persistence.importLegacy(page.map(record));
      const complete = page.at(-1)?.id === entries.at(-1)!.id || page.length === 0;
      return { ...imported, complete, nextKey: complete ? undefined : record(page.at(-1)!).key };
    });
    const state = resume === 'retry' ? await authority.retryMigration(input.operationId) : await authority.migrate({ ...input, maxPages: 64 });
    expect(state).toMatchObject({ backend: 'sqlite', mode: 'active', migrationId: input.operationId });
    expect(state.migrationIssues).toHaveLength(1000);
    expect(state.migrationIssues?.every((issue) => issue.issue === 'forgotten_source_rejected')).toBe(true);
    expect(await memory.list(global, true)).toEqual([]);
    const checkpoint = await memory.checkpoint!();
    expect(await authority.retryMigration(input.operationId)).toEqual(state);
    expect(await memory.checkpoint!()).toBe(checkpoint);
  }, 30_000);

  it('keeps a genuinely missing legacy head blocking despite an unverified forgotten-source note', async () => {
    const { authority, legacy } = managedMemory();
    const entry: MemoryEntry = { id: 'm_missing_legacy', revision: 'mem2:missing', type: 'feedback', title: 'Missing legacy entry', body: 'Complete expected legacy body.', status: 'active', pinned: false, source, reason: 'Owner instruction', created: '2026-01-01', updated: '2026-01-01' };
    vi.spyOn(legacy, 'inventory').mockResolvedValue({ entries: [entry], complete: true, warnings: [], fingerprint: 'missing-inventory' });
    vi.spyOn(ix.get(IMemoryShadowImport), 'run').mockResolvedValue({ complete: true, imported: 0, retained: 0, issues: [{ scope: 'memory/global', key: `entries/${entry.id}.md`, issue: 'forgotten_source_rejected' }] });
    const state = await authority.migrate(migration());
    expect(state).toMatchObject({ backend: 'legacy', mode: 'migrating', migration: { phase: 'failed', issues: expect.arrayContaining([{ scope: 'memory/global', key: entry.id, issue: 'legacy_head_missing' }]) } });
  });

  it('keeps blocking source failures visible when nonfatal migration notes fill the issue limit', async () => {
    const { authority } = managedMemory();
    const blocking = { scope: 'memory/global', key: 'entries/m_broken.md', issue: 'invalid_legacy_entry' };
    const notes = Array.from({ length: 1000 }, (_, index) => ({ scope: 'memory/global', key: `entries/m_forgotten_${index}.md`, issue: 'forgotten_source_rejected' }));
    vi.spyOn(ix.get(IMemoryShadowImport), 'run').mockResolvedValue({ complete: true, imported: 0, retained: 0, issues: [...notes, blocking] });
    const state = await authority.migrate(migration());
    expect(state).toMatchObject({ backend: 'legacy', mode: 'migrating', migration: { phase: 'failed', failure: { code: 'memory.source_invalid' } } });
    expect(state.migration?.issues).toHaveLength(1000);
    expect(state.migration?.issues).toContainEqual(blocking);
  });

  it('preserves malformed source payloads, reports failure and retries the same operation after repair', async () => {
    const { memory, authority } = managedMemory();
    const raw = new TextEncoder().encode('Malformed source payload');
    await storage.write('memory/global', 'entries/m_broken.md', raw);
    await expect(memory.prepare!()).rejects.toThrow('startup migration failed');
    const state = await authority.status();
    expect(state).toMatchObject({ backend: 'legacy', mode: 'migrating', migration: { phase: 'failed', failure: { code: 'memory.source_invalid' } } });
    expect(state.migration?.issues).toContainEqual(expect.objectContaining({ key: 'entries/m_broken.md', issue: 'Invalid memory frontmatter' }));
    expect(new Uint8Array((await storage.read('memory/global', 'entries/m_broken.md'))!)).toEqual(raw);
    await expect(memory.list(global)).rejects.toThrow('startup migration failed');
    await expect(createManaged(memory, 'No silent partial cutover')).rejects.toThrow('startup migration failed');
    await expect(authority.retryMigration(randomUUID())).rejects.toThrow('does not match');
    await storage.delete('memory/global', 'entries/m_broken.md');
    expect(await authority.retryMigration(state.migration!.id)).toMatchObject({ backend: 'sqlite', migrationId: state.migration!.id });
    expect((await createManaged(memory, 'Repaired source')).outcome).toBe('applied');
  });

  it('fails closed on a corrupted marker and reconciles an uncertain marker publication by status', async () => {
    const { memory, authority } = managedMemory();
    await storage.write(MEMORY_AUTHORITY_SCOPE, 'backend.json', new TextEncoder().encode('{broken'));
    await expect(memory.list(global)).rejects.toThrow('Invalid Memory authority marker');
    await expect(createManaged(memory, 'No fallback')).rejects.toThrow('Invalid Memory authority marker');
    await storage.delete(MEMORY_AUTHORITY_SCOPE, 'backend.json');
    const write = storage.write.bind(storage);
    let interrupted = false;
    storage.write = async (...args: Parameters<typeof write>) => {
      await write(...args);
      if (!interrupted && args[0] === MEMORY_AUTHORITY_SCOPE && new TextDecoder().decode(args[2]).includes('"backend":"sqlite"')) { interrupted = true; throw new Error('Publication acknowledgement lost'); }
    };
    const input = migration();
    expect(await authority.migrate(input)).toMatchObject({ backend: 'sqlite', migrationId: input.operationId });
    expect(await authority.migrate(input)).toMatchObject({ backend: 'sqlite', mode: 'active', migrationId: input.operationId });
    await close();
    bind();
    expect((await createManaged(managedMemory().memory, 'Write after reconciliation')).outcome).toBe('applied');
  });

  it('backs up post-cutover operations, adjudications, proposals and forget barriers before read-only recovery', async () => {
    let managed = managedMemory();
    const original = await createManaged(managed.legacy, 'Corrected rule');
    const forgotten = await createManaged(managed.legacy, 'Forgotten rule', 'Unique forgotten source text.');
    const originalRaw = new TextDecoder().decode((await storage.read('memory/global', `entries/${forgotten.entry.id}.md`))!);
    expect((await managed.authority.migrate(migration())).backend).toBe('sqlite');
    const changed = await managed.memory.put({ action: 'update', scope: global, id: original.entry.id, expectedRevision: original.entry.revision, type: original.entry.type, title: original.entry.title, body: 'Use 5 workers; never upload output.', reason: 'Human correction after cutover', source });
    const added = await createManaged(managed.memory, 'Created after cutover', 'Keep the new post-cutover choice.');
    const proposal = await managed.memory.put({ action: 'archive', scope: global, id: changed.entry.id, expectedRevision: changed.entry.revision, reason: 'Review a later retirement', source: { writer: 'agent' }, pending: true });
    const provenance = await managed.authority.provenance(global, forgotten.entry.id);
    const preview = await managed.authority.previewForget(global, [forgotten.entry.id]);
    await managed.authority.forget(global, preview.targets, randomUUID());
    const recovery = await managed.authority.recoverReadOnly();
    expect(recovery.mode).toBe('readonly');
    expect(await managed.authority.recoverReadOnly()).toEqual(recovery);
    const state = await managed.authority.status();
    expect(state).toMatchObject({ backend: 'sqlite', mode: 'readonly', recoveryId: recovery.recoveryId });
    expect((await managed.memory.get(global, original.entry.id))?.body).toBe(changed.entry.body);
    await expect(createManaged(managed.memory, 'Readonly edit')).rejects.toThrow('read-only');
    await expect(managed.authority.forget(global, [{ id: added.entry.id, expectedRevision: added.entry.revision }], randomUUID())).rejects.toThrow('read-only');
    const markdown = await storage.read(`${recovery.scope}/legacy-current-view`, `memory/global/inbox/${proposal.entry.id}.md`);
    expect(new TextDecoder().decode(markdown)).toContain(proposal.entry.id);
    expect(await storage.read(`${recovery.scope}/legacy-current-view`, `memory/global/entries/${forgotten.entry.id}.md`)).toBeUndefined();
    await mkdir(join(home, 'restored'), { recursive: true });
    const restoredPath = join(home, 'restored', 'memory.sqlite');
    await copyFile(storage.pathFor(recovery.scope, recovery.database), restoredPath);
    const restored = new MemoryDatabase(restoredPath);
    try {
      const objects = restored.read(['memory/global']).objects;
      expect(objects.find((item) => item.id === added.entry.id)?.entry).toEqual(added.entry);
      expect(objects.find((item) => item.id === proposal.entry.id)?.entry?.status).toBe('pending');
      expect(restored.receipt(added.operationId!)?.result).toEqual(added);
      expect(restored.provenance('memory/global', original.entry.id).adjudications).toContainEqual(expect.objectContaining({ kind: 'correction', revision: changed.entry.revision }));
      expect(restored.revision('memory/global', forgotten.entry.id, forgotten.entry.revision)).toBeUndefined();
      for (const evidence of provenance.sources) expect(restored.source('memory/global', evidence.id).state).toBe('forgotten');
      expect(restored.importLegacy([{ scope: 'memory/global', key: `entries/${forgotten.entry.id}.md`, payload: originalRaw, entry: forgotten.entry }]).issues).toContainEqual(expect.objectContaining({ issue: 'forgotten_source_rejected' }));
    } finally { restored.close(); }
    await close();
    bind();
    managed = managedMemory();
    expect((await managed.authority.status()).mode).toBe('readonly');
    expect(await managed.memory.get(global, forgotten.entry.id)).toBeUndefined();
    expect((await managed.memory.get(global, original.entry.id))?.body).toBe(changed.entry.body);
    await expect(managed.authority.resumeEditing(recovery.recoveryId, state.epoch - 1)).rejects.toThrow('state changed');
    expect((await managed.authority.resumeEditing(recovery.recoveryId, state.epoch)).mode).toBe('active');
    expect((await createManaged(managed.memory, 'Normal editing restored')).outcome).toBe('applied');
    expect((await managed.memory.get(global, proposal.entry.id))?.status).toBe('pending');
  });

  it('preserves canonical native-source barriers across correction, forget and a complete database restore', async () => {
    const { memory, authority } = managedMemory();
    await authority.migrate(migration());
    const origin = { writer: 'user' as const, session: 'source-proof-fixture', turn: 17 };
    const input = { action: 'create' as const, scope: global, type: 'feedback' as const, title: 'Traceable post-cutover source', body: 'TRACEABLE_FORGOTTEN_BODY_8237', reason: 'Traceable owner instruction', source: origin };
    const saved = await memory.put(input);
    const provenance = await authority.provenance(global, saved.entry.id);
    expect(provenance.sources[0]?.id).toBe(`source:${saved.operationId}`);
    const correction = { mutation: { ...input, action: 'update' as const, id: saved.entry.id, expectedRevision: saved.entry.revision, body: 'Only the corrected choice applies.', source }, unit: { id: 'owner-correction-source', payload: 'Only the corrected choice applies.', origin: 'owner' as const } };
    await expect(store.ingest({ ...correction, mutation: { ...correction.mutation, expectedRevision: 'stale' } })).rejects.toThrow('revision conflict');
    const changed = await store.ingest(correction);
    const renamed = { ...saved.entry, id: 'm_renamed_source_replay' };
    const payload = [{ scope: 'memory/global', key: `entries/${renamed.id}.md`, payload: JSON.stringify(renamed), entry: renamed }];
    expect(await persistence.importLegacy(payload)).toMatchObject({ imported: 1, issues: [] });
    const candidate = { mutation: { ...input, title: 'Changed extraction ID' }, unit: { id: 'different-extraction-id', payload: input.body, origin: 'owner' as const } };
    const independent = await store.ingest(candidate);
    expect(independent.entry.id).not.toBe(changed.entry.id);
    expect((await authority.previewForget(global, [saved.entry.id])).targets.map((target) => target.id)).toEqual([saved.entry.id]);
    await authority.forget(global, (await authority.previewForget(global, [saved.entry.id, renamed.id, independent.entry.id])).targets, randomUUID());
    await expect(store.ingest(candidate)).rejects.toThrow('source unit has been forgotten');
    const recovery = await authority.recoverReadOnly();
    const restoredPath = join(home, 'restored-source.sqlite');
    await copyFile(storage.pathFor(recovery.scope, recovery.database), restoredPath);
    const restored = new MemoryDatabase(restoredPath);
    try {
      expect(restored.source('memory/global', provenance.sources[0]!.id).state).toBe('forgotten');
      expect(() => restored.commit({ operationId: randomUUID(), request: 'changed-audit-id-replay', expectedGeneration: restored.read(['memory/global']).generation, edits: [{ scope: 'memory/global', id: renamed.id, expectedRevision: null, revision: renamed.revision, entry: renamed }], sources: [{ ...provenance.sources[0]!, id: 'source:new-audit-id', objectId: renamed.id }], result: {} })).toThrow('source has a forget barrier');
      expect(restored.importLegacy(payload)).toMatchObject({ imported: 0, issues: [expect.objectContaining({ issue: 'forgotten_source_rejected' })] });
      expect(restored.read(['memory/global']).objects).toEqual([]);
    } finally { restored.close(); }
    const state = await authority.status();
    await authority.resumeEditing(recovery.recoveryId, state.epoch);
    expect((await memory.put({ ...input, title: 'A distinct new owner instruction', source: { ...origin, turn: 18 } })).outcome).toBe('applied');
    expect((await memory.put({ ...input, scope: workspace })).outcome).toBe('applied');
  });

  it('backfills canonical aliases for existing readable SQLite revision history before its first forget', async () => {
    let managed = managedMemory();
    await managed.authority.migrate(migration());
    const saved = await managed.memory.put({ action: 'create', scope: global, type: 'feedback', title: 'Existing native entry', body: 'Existing original source A.', reason: 'Original owner instruction', source: { writer: 'user', session: 'existing-sqlite-source', turn: 17 } });
    const changed = await managed.memory.put({ action: 'update', scope: global, id: saved.entry.id, expectedRevision: saved.entry.revision, type: saved.entry.type, title: saved.entry.title, body: 'Existing corrected source B.', reason: 'New owner instruction', source: { writer: 'user', session: 'existing-sqlite-source', turn: 18 } });
    await close();
    const database = new DatabaseSync(join(home, 'store', 'memory-sqlite-v1', 'memory.sqlite'));
    try {
      database.exec("DELETE FROM source_links WHERE source_id LIKE 'source-unit:%'");
      expect(database.prepare("SELECT COUNT(*) AS n FROM source_links WHERE source_id LIKE 'source-unit:%'").get()?.['n']).toBe(0);
    } finally { database.close(); }
    bind();
    managed = managedMemory();
    expect(await managed.memory.get(global, changed.entry.id)).toEqual(changed.entry);
    await managed.authority.forget(global, [{ id: changed.entry.id, expectedRevision: changed.entry.revision }], randomUUID());
    for (const original of [saved.entry, changed.entry]) {
      const renamed = { ...original, id: `m_renamed_${original.source.turn}` };
      expect((await persistence.importLegacy([{ scope: 'memory/global', key: `entries/${renamed.id}.md`, payload: JSON.stringify(renamed), entry: renamed }])).issues).toContainEqual(expect.objectContaining({ issue: 'forgotten_source_rejected' }));
    }
    expect(await managed.memory.list(global, true)).toEqual([]);
  });

  it('keeps the live SQLite authority editable if recovery-package publication fails', async () => {
    const { memory, authority } = managedMemory();
    await authority.migrate(migration());
    const spy = vi.spyOn(ix.get(IAtomicDocumentStore), 'set').mockRejectedValueOnce(new Error('Recovery manifest storage failed'));
    await expect(authority.recoverReadOnly()).rejects.toThrow('manifest storage failed');
    spy.mockRestore();
    expect(await authority.status()).toMatchObject({ backend: 'sqlite', mode: 'active' });
    expect((await createManaged(memory, 'Still editable')).outcome).toBe('applied');
  });

  it('serializes legacy writes against publication and rechecks the marker after acquiring the shared lease', async () => {
    const { legacy, authority } = managedMemory();
    await persistence.read([]);
    const access = new MemoryAuthorityAccess(storage);
    let onLeaseAcquired!: () => void;
    let releaseLease!: () => void;
    const leaseAcquired = new Promise<void>((resolve) => { onLeaseAcquired = resolve; });
    const released = new Promise<void>((resolve) => { releaseLease = resolve; });
    const exclusive = access.exclusive(async (lease) => {
      onLeaseAcquired();
      await released;
      await lease.publish({ version: 1, epoch: 1, backend: 'sqlite', mode: 'active', migrationId: randomUUID() });
    });
    await leaseAcquired;
    const waiting = createManaged(legacy, 'Queued legacy write');
    releaseLease();
    await exclusive;
    await expect(waiting).rejects.toThrow('authority changed');
    expect((await authority.status()).backend).toBe('sqlite');
    expect(await legacy.list(global)).toEqual([]);
  });
});

describe('revision-bound Memory Markdown imports', () => {
  const editFile = (markdown: string, changes: Record<string, unknown> = {}, body?: string): string => {
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(markdown)!;
    return `---\n${JSON.stringify({ ...JSON.parse(match[1]!), ...changes }, null, 2)}\n---\n${body ?? match[2]!.trim()}\n`;
  };
  const fileInput = (markdown: string, sourceLocator = 'file:///example/memory/rule.md') => ({ markdown, sourceLocator, reason: 'Reviewed owner Markdown edit' });

  it('previews complete revision-bound changes, applies only the reviewed payload and retains its original source', async () => {
    const { memory, authority } = managedMemory();
    await authority.migrate(migration());
    const saved = await memory.put({ action: 'create', scope: global, type: 'feedback', title: 'Deployment guidance', body: 'Use 9 workers; never upload output; isolated tests remain allowed.', reason: 'Owner instruction', source, basis: { kind: 'human', note: 'Direct owner instruction', refs: ['fixture://owner/instruction'] }, validity: { check: 'Recheck before production', until: '2030-01-01T00:00:00Z' } });
    const exported = await authority.exportMarkdown(global, saved.entry.id);
    expect(exported.markdown).toContain(saved.entry.revision);
    expect((await authority.previewImport(global, fileInput(exported.markdown))).action).toBe('unchanged');
    const markdown = editFile(exported.markdown, { pinned: true, validity: null }, 'Use 5 workers; never upload output; isolated tests remain allowed.');
    const preview = await authority.previewImport(global, fileInput(markdown));
    expect(preview).toMatchObject({ canApply: true, action: 'update', current: JSON.parse(JSON.stringify(saved.entry)), incoming: { body: 'Use 5 workers; never upload output; isolated tests remain allowed.', pinned: true, validity: null, basis: saved.entry.basis } });
    expect(await memory.get(global, saved.entry.id)).toEqual(saved.entry);
    await expect(authority.applyImport(workspace, preview.previewToken!, randomUUID())).rejects.toThrow('scope does not match');
    const applied = await authority.applyImport(global, preview.previewToken!, randomUUID());
    expect(applied.entry).toMatchObject({ id: saved.entry.id, body: preview.incoming.body, pinned: true, basis: saved.entry.basis });
    expect(applied.entry.validity).toBeUndefined();
    expect((await authority.provenance(global, applied.entry.id)).sources).toContainEqual(expect.objectContaining({ payload: markdown, locator: 'file:///example/memory/rule.md' }));
    expect((await authority.previewImport(global, fileInput(markdown)))).toMatchObject({ canApply: false, action: 'retained', current: JSON.parse(JSON.stringify(applied.entry)) });
    const metadataEdit = editFile((await authority.exportMarkdown(global, applied.entry.id)).markdown, { title: 'Renamed deployment guidance' });
    const next = await authority.previewImport(global, fileInput(metadataEdit));
    expect(next.canApply).toBe(true);
    expect((await authority.applyImport(global, next.previewToken!, randomUUID())).entry.title).toBe('Renamed deployment guidance');
  });

  it('rejects a concurrent correction without overwriting it and requires a fresh complete preview', async () => {
    const { memory, authority } = managedMemory();
    await authority.migrate(migration());
    const saved = await createManaged(memory, 'Concurrent Markdown edit');
    const exported = await authority.exportMarkdown(global, saved.entry.id);
    const preview = await authority.previewImport(global, fileInput(editFile(exported.markdown, {}, 'The reviewed Markdown choice, exception 17.')));
    const corrected = await update(saved.entry, 'The concurrent owner correction, exception 19.');
    await expect(authority.applyImport(global, preview.previewToken!, randomUUID())).rejects.toThrow('revision conflict');
    expect(await memory.get(global, saved.entry.id)).toEqual(corrected.entry);
    expect(await authority.previewImport(global, fileInput(editFile(exported.markdown, {}, 'The reviewed Markdown choice, exception 17.')))).toMatchObject({ canApply: false, issue: { code: 'revision_conflict' }, current: JSON.parse(JSON.stringify(corrected.entry)) });
    const current = await authority.exportMarkdown(global, saved.entry.id);
    const fresh = await authority.previewImport(global, fileInput(editFile(current.markdown, {}, 'Reconciled complete choice, exceptions 17 and 19.')));
    expect((await authority.applyImport(global, fresh.previewToken!, randomUUID())).entry.body).toBe(fresh.incoming.body);
  });

  it('blocks corrected or forgotten exported origins despite renamed IDs, titles and locators', async () => {
    const { memory, authority } = managedMemory();
    await authority.migrate(migration());
    const saved = await createManaged(memory, 'Exported native source without session coordinates');
    const exported = await authority.exportMarkdown(global, saved.entry.id);
    const copied = editFile(exported.markdown, { id: 'new', revision: null, title: 'Renamed extraction' });
    const corrected = await update(saved.entry, 'Only the corrected choice 5 applies; never upload output.');
    expect(await authority.previewImport(global, fileInput(copied))).toMatchObject({ canApply: false, action: 'retained', current: JSON.parse(JSON.stringify(corrected.entry)) });
    await authority.forget(global, (await authority.previewForget(global, [saved.entry.id])).targets, randomUUID());
    await close();
    bind();
    const reopened = managedMemory();
    await expect(reopened.authority.previewImport(global, fileInput(copied, 'file:///example/renamed-again.md'))).rejects.toThrow('source has been forgotten');
    expect(await reopened.memory.list(global, true)).toEqual([]);
    const freshRevision = editFile(copied, { origin: null, source: { writer: 'user', session: 'distinct-owner-instruction', turn: 18 } }, 'A genuinely new instruction after forget; exception 23.');
    const preview = await reopened.authority.previewImport(global, fileInput(freshRevision));
    expect(preview).toMatchObject({ action: 'create', canApply: true, current: null });
    expect((await reopened.authority.applyImport(global, preview.previewToken!, randomUUID())).entry.body).toBe(preview.incoming.body);
  });

  it('allows distinct Markdown source revisions while preventing an old file from replaying a prior choice', async () => {
    const { memory, authority } = managedMemory();
    await authority.migrate(migration());
    const seed = await createManaged(memory, 'Markdown source template');
    const template = (await authority.exportMarkdown(global, seed.entry.id)).markdown;
    const fresh = editFile(template, { id: 'new', revision: null, origin: null, source: { writer: 'import', session: 'owner-document', turn: 1 }, title: 'New Markdown source' }, 'Choice A; preserve exception 17.');
    const initial = await authority.previewImport(global, fileInput(fresh));
    const created = await authority.applyImport(global, initial.previewToken!, randomUUID());
    const corrected = await update(created.entry, 'Choice B; preserve exceptions 17 and 19.');
    expect(await authority.previewImport(global, fileInput(fresh))).toMatchObject({ canApply: false, action: 'retained', current: JSON.parse(JSON.stringify(corrected.entry)) });
    const ownerRevert = await authority.previewImport(global, fileInput(editFile((await authority.exportMarkdown(global, corrected.entry.id)).markdown, {}, 'Choice A; preserve exception 17.')));
    expect(ownerRevert.canApply).toBe(true);
    expect((await authority.applyImport(global, ownerRevert.previewToken!, randomUUID())).entry.body).toBe('Choice A; preserve exception 17.');
    await authority.forget(global, (await authority.previewForget(global, [created.entry.id])).targets, randomUUID());
    await expect(authority.previewImport(global, fileInput(editFile(fresh, { title: 'Another extraction title' })))).rejects.toThrow('source has been forgotten');
    const revised = editFile(fresh, {}, 'Choice C from a revised source; exception 23.');
    const next = await authority.previewImport(global, fileInput(revised));
    expect((await authority.applyImport(global, next.previewToken!, randomUUID())).entry.body).toBe(next.incoming.body);
  });

  it('binds confirmation to the token, expiry, process and authority epoch while preserving read-only export', async () => {
    const { memory, authority } = managedMemory();
    await authority.migrate(migration());
    const saved = await createManaged(memory, 'Confirmation boundary');
    const input = fileInput(editFile((await authority.exportMarkdown(global, saved.entry.id)).markdown, {}, 'The reviewed new choice.'));
    const preview = await authority.previewImport(global, input);
    await expect(authority.applyImport(global, `${preview.previewToken!}tampered`, randomUUID())).rejects.toThrow('preview is invalid');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(preview.expiresAt!) + 1);
    try { await expect(authority.applyImport(global, preview.previewToken!, randomUUID())).rejects.toThrow('preview is invalid'); }
    finally { clock.mockRestore(); }
    const recovery = await authority.recoverReadOnly();
    await expect(authority.previewImport(global, input)).rejects.toThrow('read-only');
    await expect(authority.applyImport(global, preview.previewToken!, randomUUID())).rejects.toThrow('read-only');
    expect((await authority.exportMarkdown(global, saved.entry.id)).entry).toEqual(saved.entry);
    await authority.resumeEditing(recovery.recoveryId, (await authority.status()).epoch);
    await expect(authority.applyImport(global, preview.previewToken!, randomUUID())).rejects.toThrow('preview is invalid');
    const fresh = await authority.previewImport(global, input);
    await close();
    bind();
    await expect(managedMemory().authority.applyImport(global, fresh.previewToken!, randomUUID())).rejects.toThrow('preview is invalid');
  });

  it('validates complete Markdown ownership and shows duplicate or inactive targets before confirmation', async () => {
    const { memory, authority } = managedMemory();
    await authority.migrate(migration());
    const saved = await createManaged(memory, 'Existing Markdown title');
    const exported = await authority.exportMarkdown(global, saved.entry.id);
    await expect(authority.previewImport(global, fileInput(editFile(exported.markdown, { revision: null })))).rejects.toThrow('exported revision');
    await expect(authority.previewImport(global, fileInput(editFile(exported.markdown, { unknown: true })))).rejects.toThrow();
    await expect(authority.previewImport(global, fileInput(editFile(exported.markdown, {}, 'x'.repeat(1_501))))).rejects.toThrow('oversized');
    await expect(authority.previewImport(workspace, fileInput(exported.markdown))).rejects.toThrow('scope does not match');
    const duplicate = editFile(exported.markdown, { id: 'new', revision: null, origin: null }, 'A different fact using an existing title.');
    expect(await authority.previewImport(global, fileInput(duplicate))).toMatchObject({ canApply: false, action: 'create', issue: { code: 'duplicate_title' }, current: { id: saved.entry.id } });
    const pending = await memory.put({ action: 'create', scope: global, type: 'reference', title: 'Pending source', body: 'Awaiting explicit review.', source: { writer: 'agent' }, pending: true, reason: 'Review required' });
    expect(await authority.previewImport(global, fileInput((await authority.exportMarkdown(global, pending.entry.id)).markdown))).toMatchObject({ canApply: false, issue: { code: 'inactive_target' } });
    const preview = await authority.previewImport(global, fileInput(editFile(exported.markdown, {}, 'Reviewed edit before a later forget.')));
    await authority.forget(global, (await authority.previewForget(global, [saved.entry.id])).targets, randomUUID());
    await expect(authority.applyImport(global, preview.previewToken!, randomUUID())).rejects.toThrow('revision conflict');
    expect(await memory.get(global, saved.entry.id)).toBeUndefined();
  });
});

describe('single Memory authority safe-boundary activation', () => {
  it('preserves all four namespaces and pending revision targets through migration', async () => {
    const { memory, authority, legacy } = managedMemory();
    const targets: MemoryScope[] = [global, workspace, { kind: 'persona', personaId: 'example-role' }, { kind: 'persona_workspace', workspaceId: workspace.workspaceId, personaId: 'example-role' }];
    const saved = await Promise.all(targets.map((scope) => legacy.put({ action: 'create', scope, type: 'feedback', title: 'Scoped instruction', body: 'Preserve this complete scoped condition.', reason: 'Owner instruction', source })));
    const pending = await legacy.put({ action: 'update', scope: targets[3]!, id: saved[3]!.entry.id, expectedRevision: saved[3]!.entry.revision, type: 'feedback', title: 'Scoped instruction', body: 'Proposed scoped correction.', reason: 'Review correction', source: { writer: 'agent' }, pending: true });
    expect((await authority.prepare()).backend).toBe('sqlite');
    for (const [index, scope] of targets.entries()) expect(await memory.get(scope, saved[index]!.entry.id)).toEqual(saved[index]!.entry);
    expect(await memory.get(targets[3]!, pending.entry.id)).toEqual(pending.entry);
    const approved = await memory.put({ action: 'update', scope: targets[3]!, id: pending.entry.id, expectedRevision: pending.entry.revision, type: pending.entry.type, title: pending.entry.title, body: pending.entry.body, reason: 'Approve preserved proposal', source });
    expect(approved.entry.body).toBe('Proposed scoped correction.');
    expect(approved.entry.id).toBe(saved[3]!.entry.id);
  });

  it('automatically prepares SQLite before main and child working sets', async () => {
    const { legacy, authority } = managedMemory();
    const saved = await createManaged(legacy, 'Deployment instructions');
    ix.stub(IConfigService, { get: <T>() => ({ enabled: true, approval: 'auto', budget: 2_000, workspaces: {} }) as T });
    ix.stub(IAgentScopeContext, { agentId: 'main' });
    ix.stub(IAgentContextMemoryService, { get: () => [] });
    ix.set(IAgentMemorySnapshot, new SyncDescriptor(AgentMemorySnapshot));
    const main = ix.get(IAgentMemorySnapshot);
    await main.get();
    expect(main.workingSet).toBe(true);
    expect((await authority.status()).backend).toBe('sqlite');
    expect(await main.refreshIfDirty('Deployment instructions')).toContain(saved.entry.body);
    expect(main.workingSet).toBe(true);
    ix.stub(IAgentScopeContext, { agentId: 'child-example' });
    ix.set(IAgentMemorySnapshot, new SyncDescriptor(AgentMemorySnapshot));
    const child = ix.get(IAgentMemorySnapshot);
    await child.get();
    expect(await child.refreshIfDirty('Deployment instructions')).toContain(saved.entry.body);
    expect(await child.resolveReferences(`[${saved.entry.id}]`)).toContainEqual(expect.stringContaining(saved.entry.id));
  });

  it('rejects missing or truncated SQLite authority instead of opening an empty replacement or stale legacy view', async () => {
    const { memory, legacy } = managedMemory();
    const saved = await createManaged(legacy, 'Do not restore stale legacy content');
    await memory.prepare!();
    await close();
    await rm(join(home, 'store', 'memory-sqlite-v1'), { recursive: true });
    bind();
    const reopened = managedMemory();
    await expect(reopened.memory.get(global, saved.entry.id)).rejects.toThrow('database is missing or truncated');
    await expect(createManaged(reopened.memory, 'No empty replacement')).rejects.toThrow('database is missing or truncated');
    expect(await storage.size('store/memory-sqlite-v1', 'memory.sqlite')).toBeUndefined();
    await storage.write('store/memory-sqlite-v1', 'memory.sqlite', new Uint8Array(0));
    await expect(reopened.authority.recoverReadOnly()).rejects.toThrow('database is missing or truncated');
  });
});
