import { randomUUID } from 'node:crypto';
import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IMemoryPersistence, type MemoryCommit, type MemoryObjectEdit, type MemoryReadView, type MemoryProvenance } from '#/persistence/interface/memoryPersistence';
import { IMemoryScopes, type MemoryScope } from './memoryScopes';
import { decodeMemoryEntry, type IMemoryStore, type MemoryEntry, type MemoryMutation, type MemoryPutResult, type MemoryStoreChange, type MemoryWriter, type MemoryQuery, type MemoryQueryPage, type MemoryLorebookEntry, type MemorySource } from './memoryStore';
import { MemoryDomainError, memoryApplicability, normalizeMemoryBasis, normalizeMemoryValidity } from './memoryMetadata';
import { memoryQueryCursor, memoryQueryRequest } from './memoryQuery';
import { rankMemoryRecall } from './memoryRecall';
import { redactMemorySecrets } from './memorySafety';
import { memorySourceUnitId } from './memorySourceIdentity';

export interface MemorySourceUnit {
  readonly id: string;
  readonly payload: string;
  readonly locator?: string;
  readonly origin: 'owner' | 'agent' | 'untrusted' | 'system';
  readonly sessionKind?: 'interactive' | 'background';
  readonly aliases?: readonly string[];
  readonly signatures?: readonly string[];
}
export function memoryIngestSourceIds(base: string, unit: MemorySourceUnit): readonly string[] {
  return [...new Set([JSON.stringify([base, unit.id]), ...(unit.aliases ?? []), ...(unit.id.startsWith('source-unit:') ? [unit.id] : [])])];
}
export interface MemoryIngestCandidate {
  readonly mutation: Omit<MemoryMutation, 'action' | 'id' | 'expectedRevision'> | (MemoryMutation & { readonly action: 'update' });
  readonly unit: MemorySourceUnit;
}
export interface MemoryForgetTarget {
  readonly id: string;
  readonly expectedRevision: string;
  readonly entry: MemoryEntry | null;
}
export interface MemoryForgetPreview {
  readonly generation: number;
  readonly targets: readonly MemoryForgetTarget[];
}
export interface ISqliteMemoryStore extends IMemoryStore {
  checkpoint(): Promise<string>;
  snapshot(scopes: readonly MemoryScope[]): Promise<import('./memoryStore').MemoryStoreSnapshot>;
  getRevision(scope: MemoryScope, id: string, revision: string): Promise<MemoryEntry | undefined>;
  provenance(scope: MemoryScope, id: string): Promise<MemoryProvenance>;
  ingest(candidate: MemoryIngestCandidate): Promise<MemoryPutResult>;
  previewForget(scope: MemoryScope, ids: readonly string[]): Promise<MemoryForgetPreview>;
  forget(scope: MemoryScope, targets: readonly { readonly id: string; readonly expectedRevision: string }[], operationId: string): Promise<void>;
}
export const ISqliteMemoryStore = createDecorator<ISqliteMemoryStore>('sqliteMemoryStore');
function fail(code: 'revision_conflict' | 'invalid_input' | 'inactive_target' | 'not_found' | 'covered_target_changed' | 'duplicate_title', message: string): never {
  throw new MemoryDomainError(code, message, 'Read the complete current target and reconcile its conditions before retrying.');
}
function newRevision(): string { return `mem2:${randomUUID()}`; }
function same(a: MemoryEntry, b: MemoryEntry): boolean {
  return ['type', 'title', 'body', 'status', 'pinned', 'basis', 'validity', 'covered_by'].every((key) => JSON.stringify(a[key as keyof MemoryEntry]) === JSON.stringify(b[key as keyof MemoryEntry]));
}
function beforeEntry(raw: string): MemoryEntry { return raw.startsWith('---') ? decodeMemoryEntry(raw) : JSON.parse(raw) as MemoryEntry; }
export class SqliteMemoryStore extends Disposable implements ISqliteMemoryStore {
  declare readonly _serviceBrand: undefined;
  private readonly emitter = this._register(new Emitter<MemoryStoreChange>());
  readonly onDidChange = this.emitter.event;
  private readonly cursorSalt = randomUUID();
  constructor(@IMemoryPersistence private readonly persistence: IMemoryPersistence, @IMemoryScopes private readonly scopes: IMemoryScopes) { super(); }
  private async view(scope: MemoryScope): Promise<{ base: string; view: MemoryReadView }> {
    const base = await this.scopes.resolve(scope);
    return { base, view: await this.persistence.read([base]) };
  }
  async checkpoint(): Promise<string> { return String((await this.persistence.read([])).generation); }
  async snapshot(scopes: readonly MemoryScope[]): ReturnType<ISqliteMemoryStore['snapshot']> {
    const bases = await Promise.all(scopes.map((scope) => this.scopes.resolve(scope)));
    const view = await this.persistence.read(bases);
    return { generation: String(view.generation), entries: view.objects.flatMap((object) => {
      const scope = scopes[bases.indexOf(object.scope)];
      return scope === undefined || object.entry === null ? [] : [{ ...object.entry, scope }];
    }) };
  }
  async inventory(scope: MemoryScope): ReturnType<IMemoryStore['inventory']> {
    const { view } = await this.view(scope);
    return { entries: view.objects.flatMap((object) => object.entry === null ? [] : [object.entry]), complete: true, warnings: [], fingerprint: String(view.generation) };
  }
  async list(scope: MemoryScope, includeInactive = false): ReturnType<IMemoryStore['list']> {
    return (await this.inventory(scope)).entries.filter((entry) => includeInactive || entry.status === 'active' || entry.status === 'pending').toSorted((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
  }
  async get(scope: MemoryScope, id: string): Promise<MemoryEntry | undefined> { return (await this.inventory(scope)).entries.find((entry) => entry.id === id); }
  async getRevision(scope: MemoryScope, id: string, revision: string): Promise<MemoryEntry | undefined> { return this.persistence.revision(await this.scopes.resolve(scope), id, revision); }
  async provenance(scope: MemoryScope, id: string): Promise<MemoryProvenance> { return this.persistence.provenance(await this.scopes.resolve(scope), id); }
  async ingest({ mutation, unit }: MemoryIngestCandidate): Promise<MemoryPutResult> {
    const locator = unit.locator?.replaceAll('\\', '/');
    const sessionDerived = locator?.startsWith('sessions/') || locator?.startsWith('memory/.dreams/session-corpus/');
    if (unit.origin !== 'owner' && unit.origin !== 'agent' || (sessionDerived || unit.sessionKind !== undefined) && unit.sessionKind !== 'interactive') fail('invalid_input', 'Only trusted interactive sources can enter durable Memory');
    return this.mutate({ ...mutation, action: 'action' in mutation ? mutation.action : 'create' }, unit);
  }
  async put(original: MemoryMutation): Promise<MemoryPutResult> { return this.mutate(original); }
  private async mutate(original: MemoryMutation, unit?: MemorySourceUnit): Promise<MemoryPutResult> {
    original.signal?.throwIfAborted();
    const base = await this.scopes.resolve(original.scope);
    const operationId = original.operationId ?? randomUUID();
    const request = JSON.stringify({ ...original, unit, signal: undefined, operationId: undefined }, (_key, value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b))) : value);
    const replay = await this.persistence.receipt(operationId, request);
    if (replay !== undefined) {
      if ((replay.result as { forgotten?: boolean }).forgotten) fail('inactive_target', 'This operation refers to forgotten Memory content');
      if (unit === undefined) return replay.result as MemoryPutResult;
    }
    const sourceId = unit === undefined ? `source:${operationId}` : JSON.stringify([base, unit.id]);
    if (unit !== undefined && (!unit.id.trim() || unit.id.length > 1000 || !unit.payload || unit.payload.length > 64 * 1024)) fail('invalid_input', 'Source ingestion requires one stable source unit and a complete source payload');
    const admitted = unit === undefined ? undefined : await this.persistence.source(base, sourceId);
    if (admitted?.state === 'forgotten') fail('inactive_target', 'This exact source unit has been forgotten');
    const view = await this.persistence.read([base]);
    const objects = new Map(view.objects.map((object) => [object.id, object]));
    const entries = view.objects.flatMap((object) => object.entry === null ? [] : [object.entry]);
    if (unit !== undefined) {
      if (admitted?.state === 'registered') {
        if (admitted.source.payload !== unit.payload) fail('invalid_input', 'A changed source requires a new source revision identity');
        if (original.action !== 'create' && !admitted.objectIds.includes(original.id!)) fail('invalid_input', 'This source unit belongs to another Memory lineage');
        return this.retainSource(admitted.objectIds, view);
      }
    }
    let input = original;
    const candidate = input.id === undefined ? undefined : objects.get(input.id)?.entry ?? undefined;
    if (input.action !== 'create' && !input.expectedRevision) throw new MemoryDomainError('missing_revision', 'Memory revision is required', 'Read the complete target and copy its latest revision.');
    if (input.action === 'create' ? input.id !== undefined || input.expectedRevision !== undefined : input.id === undefined) fail('invalid_input', 'Existing targets require ID and revision; create accepts neither');
    if (input.action !== 'create' && (candidate === undefined || candidate.revision !== input.expectedRevision)) fail('revision_conflict', 'Memory revision conflict');
    let accepted: MemoryEntry | undefined;
    if (candidate?.status === 'pending' && !input.pending) {
      if (input.source.writer !== 'user' || input.action !== 'update') fail('inactive_target', 'A pending proposal requires user review');
      if (candidate.pending_action !== undefined) {
        accepted = candidate;
        input = { ...input, action: candidate.pending_action, id: candidate.supersedes, expectedRevision: candidate.supersedes_revision,
          basis: input.basis ?? candidate.basis, validity: input.validity === undefined ? candidate.validity ?? null : input.validity,
          covered_by: candidate.covered_by === undefined ? undefined : { id: candidate.covered_by.id, expected_revision: candidate.covered_by.revision } };
      }
    } else if (candidate?.status === 'pending' && input.action !== 'update') fail('inactive_target', 'A proposal is not an active replacement target');
    const old = input.id === undefined ? undefined : objects.get(input.id)?.entry ?? undefined;
    if (input.action !== 'create' && (old === undefined || old.revision !== input.expectedRevision)) fail('revision_conflict', 'Proposal target or Memory revision changed');
    const archive = input.action === 'archive';
    const type = archive ? old?.type : input.type;
    const title = archive ? old?.title : redactMemorySecrets(input.title?.trim() ?? '');
    const body = archive ? old?.body : redactMemorySecrets(input.body?.trim() ?? '');
    if (type === undefined || !['user', 'feedback', 'project', 'reference'].includes(type) || !title || title.length > 200 || !body || body.length > 1500 || !input.reason.trim()) fail('invalid_input', 'Memory type, title, complete body, or reason is invalid');
    const create = input.action === 'create' || input.action === 'supersede';
    const proposal = input.pending === true && candidate?.status !== 'pending' && (input.action === 'update' || archive);
    const changed = old !== undefined && (old.type !== type || old.title !== title || old.body !== body);
    const basis = archive ? old?.basis : input.basis === undefined ? !create && changed && old?.basis !== undefined ? { kind: 'unknown' as const, note: 'content changed without refreshed attribution' } : create ? undefined : old?.basis : normalizeMemoryBasis(input.basis);
    const validity = archive ? old?.validity : input.validity === undefined ? create ? undefined : old?.validity : normalizeMemoryValidity(input.validity);
    const dependency = input.covered_by;
    if (dependency !== undefined) {
      if (!archive) fail('invalid_input', 'covered_by is only accepted for archive');
      const covered = objects.get(dependency.id)?.entry;
      if (dependency.id === input.id || covered === null || covered === undefined || covered.status !== 'active' || covered.revision !== dependency.expected_revision || memoryApplicability(covered) === 'expired') fail('covered_target_changed', 'Retained same-scope memory changed or is not active');
    }
    const now = new Date().toISOString();
    const id = create || proposal ? `m_${randomUUID().replaceAll('-', '')}` : input.id!;
    const entry: MemoryEntry = { id, type, title, body, basis, validity, pinned: archive ? old?.pinned ?? false : input.pinned ?? (create ? false : old?.pinned) ?? false,
      status: input.pending ? 'pending' : archive ? 'archived' : 'active', created: create || proposal ? now : old?.created ?? now, updated: now, revision: newRevision(), source: input.source, reason: redactMemorySecrets(input.reason.trim()),
      supersedes: input.pending ? input.action === 'supersede' || proposal ? input.id : old?.supersedes : candidate?.status === 'pending' ? undefined : old?.supersedes,
      supersedes_revision: input.pending ? input.action === 'supersede' || proposal ? input.expectedRevision : old?.supersedes_revision : undefined,
      superseded_by: archive ? old?.superseded_by : undefined, pending_action: proposal ? input.action as 'update' | 'archive' : input.pending ? old?.pending_action : undefined,
      covered_by: dependency === undefined ? archive ? old?.covered_by : undefined : { id: dependency.id, revision: dependency.expected_revision } };
    const canonicalSource = memorySourceUnitId(base, entry.source, entry.body, entry.basis?.refs);
    const signatures = [...new Set([...(unit?.signatures ?? []), ...(canonicalSource === undefined ? [] : [canonicalSource])])];
    for (const signature of signatures) if ((await this.persistence.source(base, signature)).state === 'forgotten') {
      if (old === undefined || memorySourceUnitId(base, old.source, old.body, old.basis?.refs) !== signature) fail('inactive_target', 'This exact source unit has been forgotten');
    }
    const aliases = unit === undefined ? [] : memoryIngestSourceIds(base, unit).filter((value) => value !== sourceId);
    for (const alias of aliases) {
      const known = await this.persistence.source(base, alias);
      if (known.state === 'forgotten') fail('inactive_target', 'This exact source unit has been forgotten');
      if (known.state === 'registered' && input.action === 'create') return this.retainSource(known.objectIds, view);
      if (known.state === 'registered' && unit !== undefined && !known.objectIds.includes(input.id!)) fail('invalid_input', 'This source unit belongs to another Memory lineage');
    }
    if (!create && !proposal && accepted === undefined && old !== undefined && same(old, entry)) return { entry: old, operationId: null, outcome: 'unchanged' };
    const duplicate = input.pending ? entries.find((item) => item.status === 'pending' && item.supersedes === entry.supersedes && item.supersedes_revision === entry.supersedes_revision && item.pending_action === entry.pending_action && same(item, entry)) : undefined;
    if (duplicate !== undefined) return { entry: duplicate, operationId: null, outcome: 'pending' };
    if (input.action === 'create' && entries.some((item) => item.status === 'active' && item.title.toLowerCase() === title.toLowerCase())) fail('duplicate_title', 'Similar memory already exists; update or supersede it');
    const edits: MemoryObjectEdit[] = [];
    const add = (id: string, value: MemoryEntry | null): void => { edits.push({ scope: base, id, expectedRevision: objects.get(id)?.revision ?? null, entry: value, revision: value?.revision ?? newRevision() }); };
    let predecessor: MemoryEntry | undefined;
    if (!input.pending) {
      predecessor = input.action === 'supersede' ? old : candidate?.status === 'pending' && candidate.pending_action === undefined && candidate.supersedes !== undefined ? objects.get(candidate.supersedes)?.entry ?? undefined : undefined;
      if (candidate?.status === 'pending' && candidate.pending_action === undefined && candidate.supersedes !== undefined && predecessor?.revision !== candidate.supersedes_revision) fail('revision_conflict', 'Proposal predecessor changed');
      if (predecessor !== undefined) add(predecessor.id, { ...predecessor, status: 'superseded', superseded_by: id, updated: now, revision: newRevision() });
    }
    add(id, entry);
    if (accepted !== undefined) add(accepted.id, null);
    const active = new Map(entries.filter((item) => item.status === 'active').map((item) => [item.id, item]));
    for (const edit of edits) if (edit.entry?.status === 'active') active.set(edit.id, edit.entry); else active.delete(edit.id);
    if (active.size > 300) fail('invalid_input', 'Memory scope is full; merge existing entries');
    const result: MemoryPutResult = { entry, operationId, outcome: entry.status === 'pending' ? 'pending' : 'applied', warnings: changed && basis?.kind === 'unknown' ? ['content changed without refreshed attribution'] : undefined };
    original.signal?.throwIfAborted();
    await this.save(original.scope, view, { operationId, request, expectedGeneration: view.generation, edits,
      sources: [{ id: sourceId, scope: base, objectId: id, payload: unit?.payload ?? JSON.stringify({ writer: input.source, basis }), locator: unit?.locator ?? basis?.refs?.[0], learnedAt: now, aliases, signatures }],
      sourceTransfers: [predecessor, accepted, input.pending && (proposal || input.action === 'supersede') ? old : undefined].flatMap((prior) => prior === undefined ? [] : [{ scope: base, from: prior.id, to: id }]),
      adjudications: input.source.writer === 'user' && !input.pending ? edits.filter((edit) => edit.entry !== null).map((edit) => ({ id: `decision:${operationId}:${edit.id}`, scope: base, objectId: edit.id, kind: archive ? 'retirement' as const : 'correction' as const, revision: edit.revision, reason: entry.reason, sourceIds: [sourceId] })) : undefined,
      journal: edits.map((edit) => ({ scope: base, operationId, action: edit.id === predecessor?.id ? 'supersede_previous' : edit.id === accepted?.id ? 'accept_proposal' : input.action, id: edit.id, at: now, writer: input.source.writer, before: objects.get(edit.id)?.entry ? JSON.stringify(objects.get(edit.id)!.entry) : null, beforeRevision: objects.get(edit.id)?.revision ?? null, afterRevision: edit.entry === null ? null : edit.revision })), result });
    return result;
  }
  private retainSource(ids: readonly string[], view: MemoryReadView): MemoryPutResult {
    const linked = view.objects.flatMap((object) => ids.includes(object.id) && object.entry !== null ? [object.entry] : []);
    const active = linked.filter((entry) => entry.status === 'active');
    if (active.length > 1) fail('invalid_input', 'This source unit has conflicting active successors; review its lineage');
    const retained = active[0] ?? linked.find((entry) => entry.status === 'pending') ?? linked.find((entry) => entry.status === 'archived');
    if (retained === undefined) fail('inactive_target', 'This source unit belongs to a deleted Memory object');
    return { entry: retained, operationId: null, outcome: retained.status === 'pending' ? 'pending' : 'unchanged' };
  }
  private async save(scope: MemoryScope, view: MemoryReadView, commit: MemoryCommit): Promise<void> {
    try { await this.persistence.commit(commit); }
    catch (error) {
      if ((error as { code?: string }).code === 'revision_conflict') fail('revision_conflict', (error as Error).message);
      throw error;
    }
    for (const edit of commit.edits) this.emitter.fire({ scope, id: edit.id, operationId: commit.operationId, beforeStatus: view.objects.find((object) => object.id === edit.id)?.entry?.status, afterStatus: edit.entry?.status });
  }
  async delete(scope: MemoryScope, id: string, expectedRevision: string, writer: MemoryWriter = 'user'): Promise<string> {
    const { base, view } = await this.view(scope);
    const old = view.objects.find((object) => object.id === id)?.entry;
    if (old === undefined || old === null || old.revision !== expectedRevision) fail('revision_conflict', 'Memory revision conflict');
    const operationId = randomUUID();
    await this.save(scope, view, { operationId, request: JSON.stringify({ action: 'delete', base, id, expectedRevision }), expectedGeneration: view.generation,
      edits: [{ scope: base, id, expectedRevision, entry: null, revision: newRevision() }],
      journal: [{ scope: base, operationId, action: 'delete', id, at: new Date().toISOString(), writer, before: JSON.stringify(old), beforeRevision: old.revision, afterRevision: null }], result: { operationId } });
    return operationId;
  }
  async journal(scope: MemoryScope, id?: string): ReturnType<IMemoryStore['journal']> { return this.persistence.journal(await this.scopes.resolve(scope), id); }
  async undo(scope: MemoryScope, operationId: string | null): Promise<MemoryEntry | undefined> {
    const { base, view } = await this.view(scope);
    const records = (await this.journal(scope)).filter((record) => record.operationId === operationId);
    if (records.length === 0) fail('not_found', 'Memory operation not found');
    const nextOperation = randomUUID();
    const edits = records.map((record): MemoryObjectEdit => {
      const current = view.objects.find((object) => object.id === record.id);
      if (current === undefined || (current.entry === null ? null : current.revision) !== record.afterRevision) fail('revision_conflict', 'Undo would overwrite a later Memory edit');
      const before = record.before === null ? null : beforeEntry(record.before);
      const entry = before === null ? null : { ...before, revision: newRevision(), updated: new Date().toISOString() };
      return { scope: base, id: record.id, expectedRevision: current.revision, entry, revision: entry?.revision ?? newRevision() };
    });
    await this.save(scope, view, { operationId: nextOperation, request: JSON.stringify({ action: 'undo', operationId }), expectedGeneration: view.generation, edits,
      adjudications: edits.filter((edit) => edit.entry !== null).map((edit) => ({ id: `decision:${nextOperation}:${edit.id}`, scope: base, objectId: edit.id, kind: 'restoration', revision: edit.revision, reason: `Undo ${operationId}`, sourceIds: [] })),
      journal: edits.map((edit) => { const current = view.objects.find((object) => object.id === edit.id)!; return { scope: base, operationId: nextOperation, action: 'undo', id: edit.id, at: new Date().toISOString(), writer: 'user', before: current.entry === null ? null : JSON.stringify(current.entry), beforeRevision: current.entry?.revision ?? null, afterRevision: edit.entry?.revision ?? null }; }), result: { operationId: nextOperation } });
    const primary = records.find((record) => record.action !== 'supersede_previous') ?? records[0]!;
    return edits.find((edit) => edit.id === primary.id)?.entry ?? undefined;
  }
  async previewForget(scope: MemoryScope, ids: readonly string[]): Promise<MemoryForgetPreview> {
    if (ids.length === 0 || ids.length > 1000) fail('invalid_input', 'Select between one and 1000 Memory objects');
    const base = await this.scopes.resolve(scope);
    const related = new Set<string>();
    for (const id of ids) for (const relatedId of (await this.persistence.provenance(base, id)).relatedObjectIds) related.add(relatedId);
    if (related.size > 1000) fail('invalid_input', 'Memory source lineage exceeds the forget batch limit');
    const view = await this.persistence.read([base]);
    const targets = [...related].toSorted().map((id): MemoryForgetTarget => {
      const object = view.objects.find((item) => item.id === id);
      if (object === undefined) fail('not_found', 'Memory forget target is missing or already forgotten');
      return { id, expectedRevision: object.revision, entry: object.entry };
    });
    return { generation: view.generation, targets };
  }
  async forget(scope: MemoryScope, targets: readonly { readonly id: string; readonly expectedRevision: string }[], operationId: string): Promise<void> {
    if (!operationId || targets.length === 0 || targets.length > 1000 || new Set(targets.map((target) => target.id)).size !== targets.length) fail('invalid_input', 'Forget requires an operation ID and a nonempty exact target set');
    const request = JSON.stringify({ action: 'forget', scope, targets });
    if (await this.persistence.receipt(operationId, request) !== undefined) return;
    const { base, view } = await this.view(scope);
    for (const target of targets) if (view.objects.find((object) => object.id === target.id)?.revision !== target.expectedRevision) fail('revision_conflict', 'Forget preview changed');
    await this.save(scope, view, { operationId, request, expectedGeneration: view.generation, edits: [], barriers: targets.map((target) => ({ scope: base, objectId: target.id, at: new Date().toISOString() })), result: { forgotten: targets.map((target) => target.id) } });
    for (const target of targets) this.emitter.fire({ scope, id: target.id, operationId });
  }
  async query(scopes: readonly MemoryScope[], input: MemoryQuery, signal?: AbortSignal): Promise<MemoryQueryPage> {
    signal?.throwIfAborted();
    const parsed = memoryQueryRequest(scopes, input, this.cursorSalt);
    const { request, position } = parsed;
    const selected = scopes.filter((scope) => request.scope === undefined || request.scope === scope.kind);
    const bases = await Promise.all(selected.map((scope) => this.scopes.resolve(scope)));
    const generation = position.fingerprint === undefined ? undefined : Number(position.fingerprint);
    const view = await this.persistence.read(bases, generation);
    signal?.throwIfAborted();
    const entries = view.objects.flatMap((object) => {
      const scope = selected[bases.indexOf(object.scope)];
      return object.entry !== null && scope !== undefined && request.statuses!.includes(object.entry.status) && (request.type === undefined || request.type === object.entry.type) ? [{ ...object.entry, scope }] : [];
    });
    const ordered = request.mode === 'search' ? rankMemoryRecall(entries, request.query!, request.type) : entries.toSorted((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id) || JSON.stringify(a.scope).localeCompare(JSON.stringify(b.scope)));
    const key = (item: typeof ordered[number]): [number, string, string, string] => ['score' in item ? item.score : 0, item.title, item.id, JSON.stringify(item.scope)];
    const compare = (a: ReturnType<typeof key>, b: ReturnType<typeof key>): number => (request.mode === 'search' ? b[0] - a[0] : 0) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]) || a[3].localeCompare(b[3]);
    const last = position.chunkHash === undefined ? undefined : JSON.parse(position.chunkHash) as ReturnType<typeof key>;
    const remaining = last === undefined ? ordered : ordered.filter((item) => compare(key(item), last) > 0);
    const items = remaining.slice(0, request.page_size!);
    const exhausted = items.length >= remaining.length;
    return { items, mode: request.mode!, next_cursor: exhausted ? null : memoryQueryCursor(scopes, request, { ...position, chunkHash: JSON.stringify(key(items.at(-1)!)), fingerprint: String(view.generation) }, this.cursorSalt), coverage: { scopes: selected, statuses: request.statuses!, exhausted, complete: true, warnings: [] } };
  }
  async search(...[scopes, query, type, includeInactive]: Parameters<IMemoryStore['search']>): ReturnType<IMemoryStore['search']> {
    const view = await this.snapshot(scopes);
    return rankMemoryRecall(view.entries.filter((entry) => includeInactive || entry.status === 'active'), query, type);
  }
  async listPersonaEntries(personaId: string): ReturnType<IMemoryStore['listPersonaEntries']> {
    const scopes: MemoryScope[] = [{ kind: 'persona', personaId }, ...(await this.scopes.listWorkspaceIds?.() ?? []).map((workspaceId) => ({ kind: 'persona_workspace' as const, workspaceId, personaId }))];
    return (await Promise.all(scopes.map(async (scope) => (await this.list(scope, true)).map((entry) => ({ ...entry, scope }))))).flat();
  }
  async deletePersonaNamespaces(personaId: string): ReturnType<IMemoryStore['deletePersonaNamespaces']> {
    const entries = await this.listPersonaEntries(personaId);
    const namespaces = new Set<string>();
    for (const entry of entries) { await this.delete(entry.scope, entry.id, entry.revision); namespaces.add(JSON.stringify(entry.scope)); }
    return { namespaceCount: namespaces.size, entryCount: entries.length };
  }
  async importLorebook(scope: MemoryScope, entries: readonly MemoryLorebookEntry[], source: Partial<MemorySource> = {}): ReturnType<IMemoryStore['importLorebook']> {
    const result: { entry: MemoryEntry; operationId: string }[] = [];
    const base = await this.scopes.resolve(scope);
    const writer: MemorySource = { ...source, writer: 'import' };
    for (const [index, item] of entries.entries()) {
      const title = (item.title ?? item.name ?? `Lorebook entry ${index + 1}`).trim();
      const unitId = memorySourceUnitId(base, writer, item.content, [], `lorebook:${title}`)!;
      if ((await this.persistence.source(base, JSON.stringify([base, unitId]))).state === 'forgotten') continue;
      const saved = await this.ingest({ mutation: { scope, type: 'reference', title, body: item.content, pinned: item.constant, reason: 'Imported from Character Card lorebook', source: writer }, unit: { id: unitId, payload: item.content, origin: 'owner' } });
      if (saved.operationId !== null) result.push({ entry: saved.entry, operationId: saved.operationId });
    }
    return result;
  }
}

registerScopedService(LifecycleScope.App, ISqliteMemoryStore, SqliteMemoryStore, ScopeActivation.OnDemand, 'memory');
