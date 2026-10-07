import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IMemoryStore, MemoryStore, memoryApplicability, type MemoryEntry } from '#/app/memory/memoryStore';
import { IMemoryScopes, type MemoryScope } from '#/app/memory/memoryScopes';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IMemoryReadTool, IMemorySearchTool, IMemoryWriteTool, MemoryReadTool, MemorySearchTool, MemoryWriteTool } from '#/agent/tools/memory/memoryTools';
import { IAgentMemorySnapshot, type MemoryPersonaContext } from '#/app/memory/memorySnapshot';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IConfigService } from '#/app/config/config';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import type { ToolExecution } from '#/tool/toolContract';

const workspace: MemoryScope = { kind: 'workspace', workspaceId: 'wd_example_0123456789ab' };
const global: MemoryScope = { kind: 'global' };
const source = { writer: 'user' as const };
const basis = { kind: 'human' as const, note: 'Keep the specialist exception with its condition.', refs: ['history:example/t3'] };
const validity = { check: 'Verify the current resource schedule.', until: '2099-01-01T00:00:00Z' };
const encoder = new TextEncoder();
const pathFor = (scope: MemoryScope) => scope.kind === 'global' ? 'memory/global' : scope.kind === 'workspace' ? `memory/workspaces/${scope.workspaceId}` : scope.kind === 'persona' ? `memory/global/personas/${scope.personaId}` : `memory/workspaces/${scope.workspaceId}/personas/${scope.personaId}`;
let ix: TestInstantiationService;
let storage: FileStorageService;
let store: IMemoryStore;
let home: string;
let persona: MemoryPersonaContext | undefined;
let approval: 'auto' | 'review';
const save = (title: string, scope: MemoryScope = workspace, body = 'Default rule; preserve the specialist exception.') => store.put({ action: 'create', scope, type: 'feedback', title, body, reason: 'Human guidance', source, basis, validity });
const update = (entry: MemoryEntry, scope: MemoryScope = workspace, body = entry.body) => store.put({ action: 'update', scope, id: entry.id, expectedRevision: entry.revision, type: entry.type, title: entry.title, body, reason: 'Current correction', source });
async function execute(input: ToolExecution | Promise<ToolExecution>) {
  const execution = await input;
  if (!('execute' in execution)) return { ...execution, data: JSON.parse(execution.output as string) };
  const result = await execution.execute({ turnId: 5, toolCallId: 'example-call', signal: new AbortController().signal });
  return { ...result, data: JSON.parse(result.output as string) };
}

beforeEach(async () => {
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  home = await mkdtemp(join(process.cwd(), '.tmp', 'memory-domain-'));
  storage = new FileStorageService(home);
  ix = new TestInstantiationService();
  ix.stub(IFileSystemStorageService, storage);
  ix.stub(IMemoryScopes, { resolve: async (scope) => pathFor(scope) });
  ix.stub(ISessionContext, { workspaceId: workspace.workspaceId, sessionId: 'example-session' });
  ix.stub(IAgentMemorySnapshot, { getPersona: () => persona });
  ix.stub(IConfigService, { get: <T>() => ({ enabled: true, approval }) as T });
  ix.stub(ICapabilitySnapshotService, { toolAvailable: () => true });
  ix.set(IMemoryStore, new SyncDescriptor(MemoryStore));
  ix.set(IMemoryWriteTool, new SyncDescriptor(MemoryWriteTool));
  ix.set(IMemorySearchTool, new SyncDescriptor(MemorySearchTool));
  ix.set(IMemoryReadTool, new SyncDescriptor(MemoryReadTool));
  store = ix.get(IMemoryStore);
  persona = undefined;
  approval = 'auto';
});
afterEach(async () => { vi.restoreAllMocks(); await ix.dispose(); await rm(home, { recursive: true, force: true }); });

describe('memory attribution, validity and exact state changes', () => {
  it('loads old data without backfilling and keeps writer distinct from derived evidence', async () => {
    const saved = await store.put({ action: 'create', scope: global, type: 'project', title: 'Old compatible rule', body: 'Keep the permitted exception.', reason: 'Historical import', source });
    const before = await storage.read(pathFor(global), `entries/${saved.entry.id}.md`);
    expect((await store.get(global, saved.entry.id))?.basis).toBeUndefined();
    expect(memoryApplicability(saved.entry)).toBe('unrecorded');
    expect(await storage.read(pathFor(global), `entries/${saved.entry.id}.md`)).toEqual(before);
    const derived = await store.put({ action: 'update', scope: global, id: saved.entry.id, expectedRevision: saved.entry.revision, type: 'project', title: saved.entry.title, body: 'Agent plan: reserve 90 percent locally; this is not a human budget.', reason: 'Peer plan', source: { writer: 'agent', session: 'example-writer', turn: 8 }, basis: { kind: 'derived', note: 'The human limited communication; the peer supplied the numeric allocation.', refs: ['history:example/t4', 'peer:example-plan'] } });
    expect(derived.entry.source).toEqual({ writer: 'agent', session: 'example-writer', turn: 8 });
    expect(derived.entry.basis?.kind).toBe('derived');
    expect((await store.get(global, saved.entry.id))?.basis).toEqual(derived.entry.basis);
  });

  it('preserves intentional global/workspace mirrors and specialist exceptions while updating the same IDs', async () => {
    const g = await save('General default', global);
    const w = await save('General default', workspace);
    const specialist = await save('Specialist exception', workspace, 'Only for specialist work: preserve the explicit permission and limit.');
    const changedG = await update(g.entry, global, 'New general default, with all still-valid conditions.');
    const changedW = await update(w.entry, workspace, 'New general default, with all still-valid conditions.');
    expect(changedG.entry.id).toBe(g.entry.id);
    expect(changedW.entry.id).toBe(w.entry.id);
    expect(await store.get(workspace, specialist.entry.id)).toEqual(specialist.entry);
    expect(changedG.entry.basis).toEqual({ kind: 'unknown', note: 'content changed without refreshed attribution' });
    expect(changedG.warnings).toContain('content changed without refreshed attribution');
    expect(changedG.entry.validity).toEqual(validity);
    expect((await store.journal(global, g.entry.id)).at(-1)?.before).toContain('history:example/t3');
  });

  it('redacts secrets in basis/refs/check in entry, receipt and journal and retains or explicitly clears validity', async () => {
    const fake = `ghp_${'A'.repeat(30)}`;
    const saved = await store.put({ action: 'create', scope: global, type: 'reference', title: 'Authority pointer', body: 'Read the current authority before relying on mutable facts.', reason: 'Discovery pointer', source, basis: { kind: 'observed', note: `Evidence ${fake}`, refs: [`example-path/${fake}`] }, validity: { check: `Verify ${fake}`, until: '2000-01-01T00:00:00Z' } });
    expect(JSON.stringify(saved)).not.toContain(fake);
    expect(memoryApplicability(saved.entry)).toBe('expired');
    expect((await store.get(global, saved.entry.id))?.status).toBe('active');
    const changed = await update(saved.entry, global, 'Read example-authority.md when this contract matters; do not copy its schedule.');
    expect(changed.entry.validity).toEqual(saved.entry.validity);
    expect(JSON.stringify(await store.journal(global))).not.toContain(fake);
    const cleared = await store.put({ action: 'update', scope: global, id: changed.entry.id, expectedRevision: changed.entry.revision, type: changed.entry.type, title: changed.entry.title, body: changed.entry.body, reason: 'Authority is stable', source, validity: null });
    expect(cleared.entry.validity).toBeUndefined();
    expect(memoryApplicability(cleared.entry)).toBe('unrecorded');
    await store.undo(global, cleared.operationId);
    expect((await store.get(global, saved.entry.id))?.validity).toEqual(saved.entry.validity);
    const journal = await store.journal(global);
    for (const metadata of [
      { basis: { kind: 'observed' as const, note: `${'x'.repeat(479)} password=12345678` } },
      { basis: { kind: 'observed' as const, note: 'Evidence', refs: [`${'x'.repeat(479)} password=12345678`] } },
      { validity: { check: `${'x'.repeat(280)} password=12345678` } },
    ]) await expect(store.put({ action: 'create', scope: global, type: 'reference', title: 'Redaction boundary', body: 'Reference pointer.', reason: 'Boundary test', source, ...metadata })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await store.journal(global)).toEqual(journal);
  });

  it('does not reuse proposal attribution for newly edited approval content and rejects retirement of a proposal', async () => {
    const old = await save('Reviewed rule');
    const proposal = await store.put({ action: 'update', scope: workspace, id: old.entry.id, expectedRevision: old.entry.revision, type: old.entry.type, title: old.entry.title, body: 'Proposed current conditions.', reason: 'Review correction', source: { writer: 'agent' }, basis, pending: true });
    await expect(store.put({ action: 'archive', scope: workspace, id: proposal.entry.id, expectedRevision: proposal.entry.revision, reason: 'Retire proposal', source, pending: true })).rejects.toMatchObject({ code: 'inactive_target' });
    const accepted = await store.put({ action: 'update', scope: workspace, id: proposal.entry.id, expectedRevision: proposal.entry.revision, type: proposal.entry.type, title: proposal.entry.title, body: 'Different approval content with a new qualification.', reason: 'Edited by reviewer', source });
    expect(accepted.entry.id).toBe(old.entry.id);
    expect(accepted.entry.basis).toEqual({ kind: 'unknown', note: 'content changed without refreshed attribution' });
    expect(accepted.entry.validity).toEqual(validity);
    expect((await store.journal(workspace)).at(-2)?.before).toContain('Keep the specialist exception');
  });

  it('returns exact no-op without changing revision/source/journal/catalog/events even under review', async () => {
    const saved = await save('Unchanged rule');
    const catalog = await storage.read(pathFor(workspace), 'MEMORY.md');
    const writes = vi.spyOn(storage, 'write');
    const events = vi.fn();
    const listener = store.onDidChange(events);
    const result = await store.put({ action: 'update', scope: workspace, id: saved.entry.id, expectedRevision: saved.entry.revision, type: saved.entry.type, title: saved.entry.title, body: saved.entry.body, reason: 'Repeated confirmation', source: { writer: 'agent', turn: 99 }, pending: true });
    expect(result).toMatchObject({ outcome: 'unchanged', operationId: null, entry: saved.entry });
    expect(await store.journal(workspace)).toHaveLength(1);
    expect(await storage.read(pathFor(workspace), 'MEMORY.md')).toEqual(catalog);
    expect(writes).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    const receipt = await execute(ix.get(IMemoryWriteTool).resolveExecution({ action: 'update', id: saved.entry.id, expected_revision: saved.entry.revision, type: saved.entry.type, title: saved.entry.title, body: saved.entry.body, reason: 'Same current guidance' }));
    expect(receipt.data).toMatchObject({ outcome: 'unchanged', operation_id: null, entry: JSON.parse(JSON.stringify(saved.entry)), owner_scope: workspace });
    expect(receipt.memoryReceipt?.operationId).toBeUndefined();
    expect(receipt.memoryReceipt?.outcome).toBe('unchanged');
    expect(writes).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    await expect(store.undo(workspace, result.operationId)).rejects.toThrow('not found');
    await expect(store.put({ action: 'update', scope: workspace, id: saved.entry.id, expectedRevision: 'stale', type: 'feedback', title: saved.entry.title, body: saved.entry.body, reason: 'Stale identical input', source })).rejects.toMatchObject({ code: 'revision_conflict' });
    listener.dispose();
  });

  it('archives without accepting replacement content and restores full metadata via CAS-safe undo', async () => {
    const saved = await save('Archived with conditions');
    const archived = await store.put({ action: 'archive', scope: workspace, id: saved.entry.id, expectedRevision: saved.entry.revision, type: 'reference', title: 'Covered elsewhere', body: 'Changed legacy archive input', reason: 'Revoked by human', source });
    expect(archived.entry).toMatchObject({ title: saved.entry.title, body: saved.entry.body, type: saved.entry.type, basis, validity, status: 'archived' });
    expect(archived.warnings).toContain('ignored_archive_content');
    await store.undo(workspace, archived.operationId);
    expect(await store.get(workspace, saved.entry.id)).toEqual(saved.entry);
    const again = await store.put({ action: 'archive', scope: workspace, id: saved.entry.id, expectedRevision: saved.entry.revision, reason: 'Withdraw', source });
    const restored = await update(again.entry);
    expect(restored.outcome).toBe('applied');
    expect(restored.entry.status).toBe('active');
    await expect(store.undo(workspace, again.operationId)).rejects.toThrow('revision conflict');
    expect(await store.get(workspace, saved.entry.id)).toEqual(restored.entry);
  });
});

describe('same-scope retained dependencies and proposals', () => {
  it('rejects cross-scope/pending/expired/self/stale retained targets and leaves the original active', async () => {
    const retired = await save('Old rule', global);
    const local = await save('Narrow workspace rule');
    const archive = (id: string, revision: string) => store.put({ action: 'archive', scope: global, id: retired.entry.id, expectedRevision: retired.entry.revision, reason: 'Consolidation', source, covered_by: { id, expected_revision: revision } });
    await expect(archive(local.entry.id, local.entry.revision)).rejects.toMatchObject({ code: 'covered_target_changed' });
    await expect(archive(retired.entry.id, retired.entry.revision)).rejects.toMatchObject({ code: 'covered_target_changed' });
    const retained = await save('Retained global rule', global);
    const changed = await update(retained.entry, global, 'Complete global conditions, including the exception.');
    await expect(archive(retained.entry.id, retained.entry.revision)).rejects.toMatchObject({ code: 'covered_target_changed' });
    const expired = await store.put({ action: 'update', scope: global, id: changed.entry.id, expectedRevision: changed.entry.revision, type: changed.entry.type, title: changed.entry.title, body: changed.entry.body, reason: 'Known endpoint', source, validity: { check: 'Check authority', until: '2000-01-01T00:00:00Z' } });
    await expect(archive(expired.entry.id, expired.entry.revision)).rejects.toMatchObject({ code: 'covered_target_changed' });
    const pending = await store.put({ action: 'create', scope: global, type: 'feedback', title: 'Pending retained rule', body: 'Not yet active.', reason: 'Review', source, pending: true });
    await expect(archive(pending.entry.id, pending.entry.revision)).rejects.toMatchObject({ code: 'covered_target_changed' });
    expect(await store.get(global, retired.entry.id)).toEqual(retired.entry);
    expect((await store.journal(global, retired.entry.id))).toHaveLength(1);
  });

  it.each(['revision', 'status', 'until'] as const)('rechecks retained %s at proposal approval and preserves both original and proposal on failure', async (change) => {
    const old = await save('Old overlapping rule');
    const retained = await save('Complete retained rule');
    const proposal = await store.put({ action: 'archive', scope: workspace, id: old.entry.id, expectedRevision: old.entry.revision, reason: 'Consolidation', source: { writer: 'agent' }, pending: true, covered_by: { id: retained.entry.id, expected_revision: retained.entry.revision } });
    if (change === 'revision') await update(retained.entry, workspace, 'Concurrent new condition.');
    else if (change === 'status') await store.put({ action: 'archive', scope: workspace, id: retained.entry.id, expectedRevision: retained.entry.revision, reason: 'Withdraw', source });
    else vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'));
    await expect(store.put({ action: 'update', scope: workspace, id: proposal.entry.id, expectedRevision: proposal.entry.revision, type: proposal.entry.type, title: proposal.entry.title, body: proposal.entry.body, reason: 'Approve', source })).rejects.toMatchObject({ code: 'covered_target_changed' });
    expect(await store.get(workspace, old.entry.id)).toEqual(old.entry);
    expect(await store.get(workspace, proposal.entry.id)).toEqual(proposal.entry);
  });

  it('deduplicates proposals, identifies their original target, forbids agent approval, and approves/undoes safely', async () => {
    const old = await save('Old rule');
    const retained = await save('Retained rule');
    const request = { action: 'archive' as const, scope: workspace, id: old.entry.id, expectedRevision: old.entry.revision, reason: 'Covered in same scope', source: { writer: 'agent' as const }, pending: true, covered_by: { id: retained.entry.id, expected_revision: retained.entry.revision } };
    const proposal = await store.put(request);
    const duplicate = await store.put(request);
    expect(duplicate.entry).toEqual(proposal.entry);
    expect(duplicate.operationId).toBeNull();
    expect((await store.journal(workspace))).toHaveLength(3);
    const review = { action: 'update' as const, scope: workspace, id: proposal.entry.id, expectedRevision: proposal.entry.revision, type: proposal.entry.type, title: proposal.entry.title, body: proposal.entry.body, reason: 'Approved' };
    await expect(store.put({ ...review, source: { writer: 'agent' } })).rejects.toMatchObject({ code: 'inactive_target' });
    const accepted = await store.put({ ...review, source });
    expect(accepted.entry).toMatchObject({ id: old.entry.id, body: old.entry.body, basis, validity, status: 'archived', covered_by: { id: retained.entry.id, revision: retained.entry.revision } });
    expect(await store.get(workspace, proposal.entry.id)).toBeUndefined();
    await store.undo(workspace, accepted.operationId);
    expect(await store.get(workspace, old.entry.id)).toEqual(old.entry);
    expect(await store.get(workspace, proposal.entry.id)).toEqual(proposal.entry);
  });
});

describe('review recovery and commit boundaries (MD01–03)', () => {
  async function interruptedApproval(action: 'update' | 'archive') {
    const original = await save('Interrupted review');
    const proposal = await store.put({ action, scope: workspace, id: original.entry.id, expectedRevision: original.entry.revision, type: original.entry.type, title: original.entry.title, body: 'Reviewed correction; keep its condition.', reason: 'Correction', source: { writer: 'agent' }, pending: true });
    const deleteFile = storage.delete.bind(storage);
    let interrupted = false;
    vi.spyOn(storage, 'delete').mockImplementation(async (base, key) => {
      if (!interrupted && key === `inbox/${proposal.entry.id}.md`) { interrupted = true; throw new Error('one-shot proposal cleanup failure'); }
      return deleteFile(base, key);
    });
    await expect(update(proposal.entry)).rejects.toThrow('one-shot proposal cleanup failure');
    expect(await store.get(workspace, proposal.entry.id)).toEqual(proposal.entry);
    const current = (await store.get(workspace, original.entry.id))!;
    expect(current.status).toBe(action === 'archive' ? 'archived' : 'active');
    expect(current.body).toBe(action === 'archive' ? original.entry.body : proposal.entry.body);
    await expect(update(proposal.entry)).rejects.toMatchObject({ code: 'revision_conflict' });
    const acceptance = (await store.journal(workspace)).findLast((event) => event.action === 'accept_proposal');
    expect(acceptance).toBeDefined();
    await ix.dispose();
    ix = new TestInstantiationService();
    ix.stub(IFileSystemStorageService, storage);
    ix.stub(IMemoryScopes, { resolve: async (scope) => pathFor(scope) });
    ix.set(IMemoryStore, new SyncDescriptor(MemoryStore));
    store = ix.get(IMemoryStore);
    expect(await store.get(workspace, original.entry.id)).toEqual(current);
    expect(await store.get(workspace, proposal.entry.id)).toEqual(proposal.entry);
    return { original: original.entry, proposal: proposal.entry, current, operationId: acceptance!.operationId };
  }

  it.each(['update', 'archive'] as const)('MD01 restores a partial %s approval after reopening without rewriting the untouched proposal', async (action) => {
    const state = await interruptedApproval(action);
    const events = vi.fn();
    const listener = store.onDidChange(events);
    await store.undo(workspace, state.operationId);
    expect(await store.get(workspace, state.original.id)).toEqual(state.original);
    expect(await store.get(workspace, state.proposal.id)).toEqual(state.proposal);
    expect(events).toHaveBeenCalledTimes(1);
    expect(events.mock.calls[0]![0].id).toBe(state.original.id);
    await expect(store.undo(workspace, state.operationId)).rejects.toThrow('revision conflict');
    listener.dispose();
  });

  it.each([
    ['update', 'original'], ['update', 'proposal'], ['archive', 'original'], ['archive', 'proposal'],
  ] as const)('MD01 rejects Undo of partial %s approval when the %s has a genuinely newer revision', async (action, target) => {
    const state = await interruptedApproval(action);
    const entry = target === 'original' ? state.current : state.proposal;
    const covering = action === 'archive' && target === 'proposal' ? await save('New retained dependency') : undefined;
    const changed = await store.put({ action: 'update', scope: workspace, id: entry.id, expectedRevision: entry.revision, type: entry.type, title: entry.title, body: 'Concurrent guidance with a new condition.', reason: 'New correction', source, pending: target === 'proposal', covered_by: covering === undefined ? undefined : { id: covering.entry.id, expected_revision: covering.entry.revision } });
    expect(changed.entry.revision).not.toBe(entry.revision);
    const beforeOriginal = await store.get(workspace, state.original.id);
    const beforeProposal = await store.get(workspace, state.proposal.id);
    const journal = await store.journal(workspace);
    await expect(store.undo(workspace, state.operationId)).rejects.toThrow('revision conflict');
    expect(await store.get(workspace, state.original.id)).toEqual(beforeOriginal);
    expect(await store.get(workspace, state.proposal.id)).toEqual(beforeProposal);
    expect(await store.journal(workspace)).toEqual(journal);
  });

  it.each([
    ['direct', true], ['approval', true], ['direct', false], ['approval', false],
  ] as const)('MD02 checks expiry after %s journal append (expires=%s) before replacing the original document', async (mode, expires) => {
    const original = await save('Rule to retain until safe retirement');
    const retained = await save('Complete covering rule');
    const before = Date.parse('2098-12-31T23:59:59Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(before);
    const request = { action: 'archive' as const, scope: workspace, id: original.entry.id, expectedRevision: original.entry.revision, reason: 'Consolidation', source, covered_by: { id: retained.entry.id, expected_revision: retained.entry.revision } };
    const proposal = mode === 'approval' ? await store.put({ ...request, source: { writer: 'agent' }, pending: true }) : undefined;
    const append = storage.append.bind(storage);
    vi.spyOn(storage, 'append').mockImplementation(async (...args) => {
      const result = await append(...args);
      clock.mockReturnValue(expires ? Date.parse('2099-01-01T00:00:01Z') : before + 500);
      return result;
    });
    const events = vi.fn();
    const listener = store.onDidChange(events);
    const commit = () => proposal === undefined ? store.put(request) : update(proposal.entry);
    if (expires) {
      await expect(commit()).rejects.toMatchObject({ code: 'covered_target_changed' });
      expect(await store.get(workspace, original.entry.id)).toEqual(original.entry);
      if (proposal !== undefined) expect(await store.get(workspace, proposal.entry.id)).toEqual(proposal.entry);
      expect(events).not.toHaveBeenCalled();
    } else {
      const accepted = await commit();
      expect(accepted.outcome).toBe('applied');
      expect(accepted.entry).toMatchObject({ id: original.entry.id, status: 'archived', body: original.entry.body, basis, validity, covered_by: { id: retained.entry.id, revision: retained.entry.revision } });
      if (proposal !== undefined) expect(await store.get(workspace, proposal.entry.id)).toBeUndefined();
      await store.undo(workspace, accepted.operationId);
      expect(await store.get(workspace, original.entry.id)).toEqual(original.entry);
      if (proposal !== undefined) expect(await store.get(workspace, proposal.entry.id)).toEqual(proposal.entry);
    }
    expect(await store.get(workspace, retained.entry.id)).toEqual(retained.entry);
    listener.dispose();
  });

  it.each(['retained', 'changed', 'cleared', 'override-object', 'override-null'] as const)('MD03 approves the complete %s validity state and restores both before-images on Undo', async (mode) => {
    const original = await save('Reviewed validity');
    const changed = { check: 'Check the revised authority.', until: '2099-02-01T00:00:00Z' };
    const override = { check: 'Check the explicit reviewer authority.' };
    const proposedValidity = mode === 'retained' ? undefined : mode === 'cleared' || mode === 'override-object' ? null : changed;
    const proposal = await store.put({ action: 'update', scope: workspace, id: original.entry.id, expectedRevision: original.entry.revision, type: original.entry.type, title: original.entry.title, body: 'Reviewed final rule with its condition.', reason: 'Review change', source: { writer: 'agent' }, pending: true, validity: proposedValidity });
    expect(proposal.entry.validity).toEqual(mode === 'retained' ? validity : proposedValidity ?? undefined);
    expect(await store.get(workspace, original.entry.id)).toEqual(original.entry);
    const accepted = await store.put({ action: 'update', scope: workspace, id: proposal.entry.id, expectedRevision: proposal.entry.revision, type: proposal.entry.type, title: proposal.entry.title, body: proposal.entry.body, reason: 'Approve', source, validity: mode === 'override-object' ? override : mode === 'override-null' ? null : undefined });
    const expected = mode === 'retained' ? validity : mode === 'changed' ? changed : mode === 'override-object' ? override : undefined;
    expect(accepted.entry.validity).toEqual(expected);
    expect(await store.get(workspace, original.entry.id)).toEqual(accepted.entry);
    expect(await store.get(workspace, proposal.entry.id)).toBeUndefined();
    await store.undo(workspace, accepted.operationId);
    expect(await store.get(workspace, original.entry.id)).toEqual(original.entry);
    expect(await store.get(workspace, proposal.entry.id)).toEqual(proposal.entry);
    const ordinary = await update(original.entry, workspace, 'Ordinary correction; preserve the existing validity.');
    expect(ordinary.entry.validity).toEqual(validity);
  });
});

describe('memory tool targeting and inventory recovery', () => {
  it('provides a full receipt/read target, resolves omitted scope uniquely, and exposes correct conflict recovery', async () => {
    const saved = await save('Global rule', global);
    const read = await execute(ix.get(IMemoryReadTool).resolveExecution({ id: saved.entry.id }));
    expect(read.data[0]).toMatchObject({ scope: global, target: { scope: 'global', id: saved.entry.id, expected_revision: saved.entry.revision }, basis, validity, complete: true });
    const write = await execute(ix.get(IMemoryWriteTool).resolveExecution({ action: 'update', id: saved.entry.id, expected_revision: saved.entry.revision, type: saved.entry.type, title: saved.entry.title, body: 'New current body; preserve the exception.', reason: 'Human correction', basis }));
    expect(write.data).toMatchObject({ outcome: 'applied', scope: 'global', owner_scope: global, entry: { id: saved.entry.id, body: 'New current body; preserve the exception.' }, target: { scope: 'global', expected_revision: write.data.revision } });
    expect(write.memoryReceipt?.ownerScope).toEqual(global);
    const mismatch = await execute(ix.get(IMemoryWriteTool).resolveExecution({ action: 'archive', scope: 'workspace', id: saved.entry.id, expected_revision: write.data.revision, reason: 'Wrong scope' }));
    expect(mismatch.data).toMatchObject({ code: 'scope_mismatch', visible_targets: [{ scope: 'global', id: saved.entry.id }] });
    const missing = await execute(ix.get(IMemoryWriteTool).resolveExecution({ action: 'archive', id: saved.entry.id, reason: 'Missing revision' }));
    expect(missing.data.code).toBe('missing_revision');
    expect((await store.get(global, saved.entry.id))?.status).toBe('active');
  });

  it('rejects ambiguous IDs and never discloses hidden namespace matches', async () => {
    const g = await save('Shared ID', global);
    const raw = await storage.read(pathFor(global), `entries/${g.entry.id}.md`);
    await storage.write(pathFor(workspace), `entries/${g.entry.id}.md`, raw!);
    const read = await execute(ix.get(IMemoryReadTool).resolveExecution({ id: g.entry.id }));
    expect(read.data[0].code).toBe('ambiguous_target');
    expect(read.data[0].visible_targets.map((item: { scope: string }) => item.scope).toSorted()).toEqual(['global', 'workspace']);
    const write = await execute(ix.get(IMemoryWriteTool).resolveExecution({ action: 'archive', id: g.entry.id, expected_revision: g.entry.revision, reason: 'Ambiguous target' }));
    expect(write.data.code).toBe('ambiguous_target');
    persona = { id: 'example-persona', shared: [] };
    const hidden = await execute(ix.get(IMemoryReadTool).resolveExecution({ id: g.entry.id }));
    expect(hidden.data).toEqual([{ id: g.entry.id, missing: true, reason: 'not_found', recovery: 'Locate the ID in visible scopes; do not create a duplicate to bypass lookup.' }]);
    const denied = await execute(ix.get(IMemoryWriteTool).resolveExecution({ action: 'archive', scope: 'global', id: g.entry.id, expected_revision: g.entry.revision, reason: 'No permission' }));
    expect(denied.data.code).toBe('scope_mismatch');
    expect(denied.data.visible_targets).toBeUndefined();
  });

  it('returns full pending proposals with an explicit switch and never labels the original as replaced', async () => {
    const old = await save('Existing rule');
    approval = 'review';
    const proposed = await execute(ix.get(IMemoryWriteTool).resolveExecution({ action: 'update', id: old.entry.id, expected_revision: old.entry.revision, type: old.entry.type, title: old.entry.title, body: 'Proposed correction, with conditions.', reason: 'Review correction', basis }));
    expect(proposed.data).toMatchObject({ outcome: 'pending', entry: { status: 'pending' }, proposed_target: { scope: 'workspace', id: old.entry.id, expected_revision: old.entry.revision } });
    expect(proposed.data.target.id).not.toBe(old.entry.id);
    expect(proposed.data.reference_hint).toContain('The existing active entry is unchanged.');
    expect(await store.get(workspace, old.entry.id)).toEqual(old.entry);
    expect((await execute(ix.get(IMemoryReadTool).resolveExecution({ id: proposed.data.id }))).data[0].reason).toBe('pending_excluded');
    expect((await execute(ix.get(IMemoryReadTool).resolveExecution({ id: proposed.data.id, include_pending: true }))).data[0]).toMatchObject({ status: 'pending', body: 'Proposed correction, with conditions.', complete: true });
    const both = await execute(ix.get(IMemoryReadTool).resolveExecution({ id: old.entry.id, ids: [old.entry.id] }));
    expect(both.data.code).toBe('invalid_input');
  });

  it('pages beyond 8 and 20 hits, prioritizes the complete title query, and invalidates changed/permission-bound cursors', async () => {
    for (let index = 0; index < 24; index++) await save(`Needle topic ${String(index).padStart(2, '0')}`);
    const first = await execute(ix.get(IMemorySearchTool).resolveExecution({ query: 'Needle topic', scope: 'workspace' }));
    expect(first.data.items).toHaveLength(8);
    expect(first.data.coverage).toMatchObject({ complete: true, exhausted: false, scopes: [workspace], statuses: ['active'] });
    expect(first.data.items[0]).toMatchObject({ target: { scope: 'workspace' }, applicability: 'recheck', basis_kind: 'human' });
    const second = await execute(ix.get(IMemorySearchTool).resolveExecution({ cursor: first.data.next_cursor }));
    const third = await execute(ix.get(IMemorySearchTool).resolveExecution({ cursor: second.data.next_cursor }));
    expect(third.data.coverage.exhausted).toBe(true);
    expect(new Set([...first.data.items, ...second.data.items, ...third.data.items].map((item) => item.id)).size).toBe(24);
    const list = await execute(ix.get(IMemorySearchTool).resolveExecution({ mode: 'list', scope: 'workspace' }));
    expect(list.data.items).toHaveLength(20);
    expect(list.data.items[0].snippet).toBeUndefined();
    expect(list.data.items[0].score).toBeUndefined();
    await save('Newest unrelated addition');
    const invalid = await execute(ix.get(IMemorySearchTool).resolveExecution({ cursor: list.data.next_cursor }));
    expect(invalid.data.code).toBe('cursor_invalidated');
    persona = { id: 'example-persona', shared: [] };
    expect((await execute(ix.get(IMemorySearchTool).resolveExecution({ cursor: first.data.next_cursor }))).data.code).toBe('cursor_invalidated');
    persona = undefined;
    for (const args of [{ query: 'x'.repeat(201) }, { query: '!!!' }, { query: Array.from({ length: 11 }, () => 'word').join(' ') }, { mode: 'list' as const, query: 'Needle' }, { query: 'Needle', statuses: ['active' as const], include_superseded: true }]) {
      const error = await execute(ix.get(IMemorySearchTool).resolveExecution(args));
      expect(error.isError).toBe(true);
      expect(error.data.code).toBe('invalid_query');
    }
  }, 30_000);

  it('enumerates beyond the old 1000-record cutoff and discloses invalid/oversized inputs without leaking paths', async () => {
    const saved = await save('Inventory template');
    const rawFor = (index: number) => {
      const id = `m_example_${String(index).padStart(4, '0')}`;
      const { revision: _revision, ...entry } = saved.entry;
      return { id, text: `---\n${JSON.stringify({ ...entry, id, title: `Archive ${index}`, status: 'archived' })}\n---\n${entry.body}\n` };
    };
    for (let start = 0; start < 1_002; start += 100) await Promise.all(Array.from({ length: Math.min(100, 1_002 - start) }, (_, offset) => rawFor(start + offset)).map(({ id, text }) => storage.write(pathFor(workspace), `entries/${id}.md`, encoder.encode(text))));
    const complete = await store.inventory(workspace);
    expect(complete.complete).toBe(true);
    expect(complete.entries).toHaveLength(1_003);
    expect(complete.entries.some((entry) => entry.id === 'm_example_1001')).toBe(true);
    await storage.write(pathFor(workspace), 'entries/m_invalid.md', encoder.encode('not frontmatter'));
    await storage.write(pathFor(workspace), 'entries/m_oversized.md', encoder.encode('x'.repeat(65_537)));
    const partial = await store.query([workspace], { mode: 'list', statuses: ['archived'] });
    expect(partial.coverage).toMatchObject({ complete: false, exhausted: false });
    expect(partial.coverage.warnings.join(' ')).toContain('2 memory records were skipped');
    expect(JSON.stringify(partial.coverage)).not.toContain(home);
    expect(JSON.stringify(partial.coverage)).not.toContain('m_invalid');
    await expect(store.list(workspace, true)).rejects.toMatchObject({ code: 'storage_unavailable' });
  }, 30_000);
});


describe('bounded memory source continuation and final capacity', () => {
  const seed = async (index: number, status: 'active' | 'pending' | 'archived' = 'archived') => {
    const id = `m_continuation_${String(index).padStart(3, '0')}`;
    const entry = { id, type: 'reference', title: `Continuation ${index}`, body: 'needle '.repeat(50), status, pinned: false, created: '2026-01-01', updated: '2026-01-01', source, reason: 'Fixture' };
    await storage.write(pathFor(global), `${status === 'pending' ? 'inbox' : 'entries'}/${id}.md`, encoder.encode(`---\n${JSON.stringify(entry)}\n---\n${entry.body}\n`));
    return (await store.get(global, id))!;
  };
  const smallBudget = () => Object.defineProperty(store, 'queryBudget', { value: { records: 2, bytes: 1400 } });
  it('automatically traversable source cursors reach valid suffixes across record and byte budgets without retaining all bodies', async () => {
    smallBudget();
    for (let i = 0; i < 7; i++) await seed(i);
    const read = vi.spyOn(storage, 'readStream');
    let page = await store.query([global], { mode: 'list', statuses: ['archived'], page_size: 1 });
    const ids: string[] = [];
    let calls = 0;
    do {
      expect(page.coverage.complete).toBe(true);
      expect(page.items.length).toBeLessThanOrEqual(1);
      ids.push(...page.items.map((entry) => entry.id));
      calls++;
      if (page.next_cursor === null) break;
      read.mockClear();
      page = await store.query([global], { cursor: page.next_cursor });
      expect(read.mock.calls.length).toBeLessThanOrEqual(4);
    } while (calls < 80);
    expect(page.coverage.exhausted).toBe(true);
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    expect(calls).toBeGreaterThan(7);
  });
  it('reports one bad record cumulatively without losing readable Inbox proposals or calling a preparation page empty', async () => {
    smallBudget();
    for (let i = 0; i < 5; i++) await seed(i, 'pending');
    await storage.write(pathFor(global), 'inbox/m_bad.md', encoder.encode('broken frontmatter'));
    let page = await store.query([global], { mode: 'list', statuses: ['pending'] });
    expect(page).toMatchObject({ items: [], coverage: { exhausted: false, complete: true } });
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      ids.push(...page.items.map((entry) => entry.id));
      if (page.next_cursor === null) break;
      page = await store.query([global], { cursor: page.next_cursor });
    }
    expect(ids).toHaveLength(5);
    expect(page.coverage).toMatchObject({ complete: false, exhausted: true });
    expect(page.coverage.warnings[0]).toContain('1 memory records');
    expect(page.coverage.warnings[0]).not.toContain('budget');
  });
  it('rejects mixed/tampered/scope-changed cursors and source edits including an in-place same-size edit', async () => {
    smallBudget();
    const entry = await seed(0);
    await seed(1);
    vi.spyOn(storage, 'mtime').mockResolvedValue(123);
    let page = await store.query([global], { mode: 'list', statuses: ['archived'], page_size: 1 });
    while (page.items.length === 0 && page.next_cursor !== null) page = await store.query([global], { cursor: page.next_cursor });
    expect(page.next_cursor).not.toBeNull();
    await expect(store.query([global], { cursor: page.next_cursor!, mode: 'list' })).rejects.toMatchObject({ code: 'cursor_invalidated' });
    await expect(store.query([workspace], { cursor: page.next_cursor! })).rejects.toMatchObject({ code: 'cursor_invalidated' });
    await expect(store.query([global], { cursor: `${page.next_cursor}x` })).rejects.toMatchObject({ code: 'cursor_invalidated' });
    const key = `entries/${entry.id}.md`;
    const raw = await storage.read(pathFor(global), key);
    await storage.write(pathFor(global), key, encoder.encode(new TextDecoder().decode(raw).replace('needle', 'change')), { atomic: false });
    await expect((async () => {
      let cursor = page.next_cursor;
      while (cursor !== null) {
        const next = await store.query([global], { cursor });
        expect(next.items).toEqual([]);
        cursor = next.next_cursor;
      }
    })()).rejects.toMatchObject({ code: 'cursor_invalidated' });
  });
  it('allows full-capacity net replacements but rejects growth at direct creation, restoration and proposal approval', async () => {
    Object.defineProperty(store, 'activeCapacity', { value: 2 });
    const a = await seed(0, 'active');
    await seed(1, 'active');
    const saved = await store.put({ action: 'supersede', scope: global, id: a.id, expectedRevision: a.revision, type: a.type, title: 'Replacement', body: a.body, reason: 'Replace', source });
    expect(saved.entry.status).toBe('active');
    expect((await store.get(global, a.id))?.status).toBe('superseded');
    await expect(store.put({ action: 'create', scope: global, type: 'reference', title: 'Growth', body: 'New rule', reason: 'Create', source })).rejects.toThrow('full');
    const inactive = await seed(2);
    await expect(update(inactive, global)).rejects.toThrow('full');
    const pending = await store.put({ action: 'create', scope: global, type: 'reference', title: 'Reviewed growth', body: 'New rule', reason: 'Propose', source: { writer: 'agent' }, pending: true });
    await expect(store.put({ action: 'update', scope: global, id: pending.entry.id, expectedRevision: pending.entry.revision, type: pending.entry.type, title: pending.entry.title, body: pending.entry.body, reason: 'Approve', source })).rejects.toThrow('full');
    await expect(store.put({ action: 'update', scope: global, id: pending.entry.id, expectedRevision: pending.entry.revision, type: pending.entry.type, title: pending.entry.title, body: pending.entry.body, reason: 'Self approve', source: { writer: 'agent' } })).rejects.toMatchObject({ code: 'inactive_target' });
    const proposal = await store.put({ action: 'supersede', scope: global, id: saved.entry.id, expectedRevision: saved.entry.revision, type: 'reference', title: 'Reviewed replacement', body: 'Same capacity', reason: 'Propose', source: { writer: 'agent' }, pending: true });
    const approved = await store.put({ action: 'update', scope: global, id: proposal.entry.id, expectedRevision: proposal.entry.revision, type: proposal.entry.type, title: proposal.entry.title, body: proposal.entry.body, reason: 'Approve', source });
    expect(approved.entry.status).toBe('active');
    expect((await store.query([global], { mode: 'list' })).items).toHaveLength(2);
  });
});


it('bounds streamed records and charges actual bytes when source size grows after its stat', async () => {
  const base = pathFor(global);
  await storage.write(base, 'inbox/m_growing.md', encoder.encode('x'.repeat(70_000)));
  const size = storage.size.bind(storage);
  vi.spyOn(storage, 'size').mockImplementation((scope, key) => key === 'inbox/m_growing.md' ? Promise.resolve(10) : size(scope, key));
  const reads = vi.spyOn(storage, 'readStream');
  const page = await store.query([global], { mode: 'list', statuses: ['pending'] });
  expect(page.coverage).toMatchObject({ complete: false, exhausted: true });
  expect(page.coverage.warnings[0]).toContain('1 memory records');
  expect(reads.mock.calls).toHaveLength(2);
  for (const call of reads.mock.calls) expect(call[2]).toEqual({ start: 0, end: 64 * 1024 });
});


describe('memory query read reuse and pending-only writes', () => {
  it('reads each unchanged source once per call and still reads fresh bytes across pages', async () => {
    for (let index = 0; index < 3; index++) await save(`Read reuse ${index}`, global);
    const reads = vi.spyOn(storage, 'readStream');
    const first = await store.query([global], { mode: 'list', page_size: 1 });
    expect(first.items).toHaveLength(1);
    expect(reads).toHaveBeenCalledTimes(3);
    reads.mockClear();
    const next = await store.query([global], { cursor: first.next_cursor! });
    expect(next.items).toHaveLength(1);
    expect(next.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(reads).toHaveBeenCalledTimes(3);
  });

  it('retains the second read when source modification metadata is unavailable', async () => {
    const saved = await save('Unverifiable metadata', global);
    const mtime = storage.mtime.bind(storage);
    vi.spyOn(storage, 'mtime').mockImplementation((scope, key) => key === `entries/${saved.entry.id}.md` ? Promise.resolve(undefined) : mtime(scope, key));
    const reads = vi.spyOn(storage, 'readStream');
    const page = await store.query([global], { mode: 'list' });
    expect(page.items).toHaveLength(1);
    expect(page.coverage.complete).toBe(true);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it.each(['addition', 'journal'] as const)('invalidates a concurrent %s discovered by the final directory proof', async (change) => {
    const saved = await save('Directory proof', global);
    const base = pathFor(global);
    const raw = (await storage.read(base, `entries/${saved.entry.id}.md`))!;
    const list = storage.list.bind(storage);
    let checks = 0;
    vi.spyOn(storage, 'list').mockImplementation(async (scope) => {
      if (scope === `${base}/entries` && ++checks === 2) {
        if (change === 'addition') await storage.write(base, 'entries/m_added.md', encoder.encode(new TextDecoder().decode(raw).replaceAll(saved.entry.id, 'm_added')));
        else await storage.append(base, 'journal.jsonl', encoder.encode('{}\n'));
      }
      return list(scope);
    });
    await expect(store.query([global], { mode: 'list' })).rejects.toMatchObject({ code: 'cursor_invalidated' });
  });

  it.each(['edit', 'delete'] as const)('invalidates a source %s between validation and materialization instead of returning retained bytes', async (change) => {
    const saved = await save('Concurrent source', global);
    const base = pathFor(global);
    const key = `entries/${saved.entry.id}.md`;
    const raw = (await storage.read(base, key))!;
    const size = storage.size.bind(storage);
    let checks = 0;
    vi.spyOn(storage, 'size').mockImplementation(async (scope, file) => {
      if (scope === base && file === key && ++checks === 2) {
        if (change === 'delete') await storage.delete(base, key);
        else await storage.write(base, key, encoder.encode(new TextDecoder().decode(raw).replace('Concurrent source', 'Changed source')));
      }
      return size(scope, file);
    });
    await expect(store.query([global], { mode: 'list' })).rejects.toMatchObject({ code: 'cursor_invalidated' });
  });

  it('edits pending entries without scanning active records or rewriting their catalog, while preserving CAS and journal order', async () => {
    const active = await save('Retained active', global);
    const pending = await store.put({ action: 'create', scope: global, type: 'feedback', title: 'Pending rule', body: 'Awaiting review.', reason: 'Propose', source, pending: true });
    const base = pathFor(global);
    const catalog = await storage.read(base, 'MEMORY.md');
    const lists = vi.spyOn(storage, 'list');
    const writes = vi.spyOn(storage, 'write');
    const append = vi.spyOn(storage, 'append');
    const locks = vi.spyOn(storage, 'acquireLock');
    const changed = await store.put({ action: 'update', scope: global, id: pending.entry.id, expectedRevision: pending.entry.revision, type: pending.entry.type, title: pending.entry.title, body: 'Revised proposal.', reason: 'Edit proposal', source, pending: true });
    expect(changed.outcome).toBe('pending');
    expect(lists).not.toHaveBeenCalled();
    expect(writes.mock.calls.map((call) => call[1])).toEqual([`inbox/${pending.entry.id}.md`]);
    expect(append).toHaveBeenCalledTimes(1);
    expect(locks).toHaveBeenCalledTimes(1);
    expect(append.mock.invocationCallOrder[0]).toBeLessThan(writes.mock.invocationCallOrder[0]!);
    expect(writes.mock.calls[0]![3]).toEqual({ atomic: true });
    expect(await storage.read(base, 'MEMORY.md')).toEqual(catalog);
    expect(await store.get(global, active.entry.id)).toEqual(active.entry);
    await expect(store.put({ action: 'update', scope: global, id: pending.entry.id, expectedRevision: pending.entry.revision, type: pending.entry.type, title: pending.entry.title, body: 'Stale proposal.', reason: 'Stale edit', source, pending: true })).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(await store.get(global, pending.entry.id)).toEqual(changed.entry);
    await store.undo(global, changed.operationId);
    expect(await store.get(global, pending.entry.id)).toEqual(pending.entry);
  });
});
