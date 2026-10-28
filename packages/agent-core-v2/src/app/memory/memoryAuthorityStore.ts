import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createDecorator, IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IMemoryPersistence, type MemoryObjectEdit, type MemoryProvenance } from '#/persistence/interface/memoryPersistence';
import { MemoryAuthorityAccess, assertMemoryAuthorityWritable, type MemoryAuthorityState } from '#/persistence/memoryAuthority';
import { IMemoryScopes, MEMORY_PERSONA_ID_PATTERN, MEMORY_WORKSPACE_ID_PATTERN, type MemoryScope } from './memoryScopes';
import { ILegacyMemoryStore, IMemoryStore, type MemoryStoreChange, type MemoryStoreSnapshot } from './memoryStore';
import { ISqliteMemoryStore, type MemoryForgetPreview } from './sqliteMemoryStore';
import { IMemoryShadowImport } from './memoryShadowImport';
import { MemoryDomainError } from './memoryMetadata';

export type { MemoryAuthorityState } from '#/persistence/memoryAuthority';
export interface MemoryRecoveryPackage {
  readonly recoveryId: string;
  readonly scope: string;
  readonly generation: number;
  readonly namespaces: readonly string[];
  readonly mode: 'readonly';
  readonly database: 'memory.sqlite';
  readonly compatibility: 'legacy-current-view';
  readonly resume: 'resumeEditing';
}
export interface IMemoryAuthorityService {
  readonly _serviceBrand: undefined;
  status(): Promise<MemoryAuthorityState>;
  migrate(input: { readonly operationId: string; readonly olderWritersStopped: true; readonly maxPages?: number }, signal?: AbortSignal): Promise<MemoryAuthorityState>;
  cancelMigration(operationId: string): Promise<MemoryAuthorityState>;
  recoverReadOnly(): Promise<MemoryRecoveryPackage>;
  resumeEditing(recoveryId: string, expectedEpoch: number): Promise<MemoryAuthorityState>;
  provenance(scope: MemoryScope, id: string): Promise<MemoryProvenance>;
  getRevision(scope: MemoryScope, id: string, revision: string): ReturnType<ISqliteMemoryStore['getRevision']>;
  previewForget(scope: MemoryScope, ids: readonly string[]): Promise<MemoryForgetPreview>;
  forget(...args: Parameters<ISqliteMemoryStore['forget']>): Promise<void>;
}
export const IMemoryAuthorityService = createDecorator<IMemoryAuthorityService>('memoryAuthorityService');
function invalid(message: string): never { throw new MemoryDomainError('invalid_input', message, 'Inspect Memory authority status and reconcile the reported operation before retrying.'); }
function parseNamespace(base: string): MemoryScope {
  if (base === 'memory/global') return { kind: 'global' };
  const persona = /^memory\/global\/personas\/([^/]+)$/.exec(base);
  if (persona !== null && MEMORY_PERSONA_ID_PATTERN.test(persona[1]!)) return { kind: 'persona', personaId: persona[1]! };
  const workspace = /^memory\/workspaces\/([^/]+)(?:\/personas\/([^/]+))?$/.exec(base);
  if (workspace !== null && MEMORY_WORKSPACE_ID_PATTERN.test(workspace[1]!) && (workspace[2] === undefined || MEMORY_PERSONA_ID_PATTERN.test(workspace[2]))) return workspace[2] === undefined
    ? { kind: 'workspace', workspaceId: workspace[1]! } : { kind: 'persona_workspace', workspaceId: workspace[1]!, personaId: workspace[2] };
  return invalid(`Unsupported Memory namespace: ${base}`);
}
export class MemoryAuthorityStore extends Disposable implements IMemoryStore {
  declare readonly _serviceBrand: undefined;
  private readonly emitter = this._register(new Emitter<MemoryStoreChange>());
  readonly onDidChange = this.emitter.event;
  private readonly authority: MemoryAuthorityAccess;
  private sqlite?: ISqliteMemoryStore;
  private backend: 'legacy' | 'sqlite' = 'legacy';
  constructor(
    @ILegacyMemoryStore private readonly legacy: IMemoryStore,
    @IFileSystemStorageService storage: IFileSystemStorageService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {
    super();
    this.authority = new MemoryAuthorityAccess(storage);
    this._register(legacy.onDidChange((event) => this.emitter.fire(event)));
  }
  private sqliteStore(): ISqliteMemoryStore {
    if (this.sqlite === undefined) {
      this.sqlite = this.instantiation.invokeFunction((accessor) => accessor.get(ISqliteMemoryStore));
      this._register(this.sqlite.onDidChange((event) => this.emitter.fire(event)));
    }
    return this.sqlite;
  }
  private async state(): Promise<MemoryAuthorityState> {
    const state = await this.authority.read();
    this.backend = state.backend;
    return state;
  }
  async prepare(): Promise<void> { await this.state(); }
  private async read<T>(operation: (store: IMemoryStore) => Promise<T>): Promise<T> {
    const state = await this.state();
    const result = await operation(state.backend === 'legacy' ? this.legacy : this.sqliteStore());
    if (state.backend === 'legacy' && (await this.state()).backend !== 'legacy') return operation(this.sqliteStore());
    return result;
  }
  private async mutate<T>(operation: (store: IMemoryStore) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const state = await this.state();
    assertMemoryAuthorityWritable(state, state.backend);
    return state.backend === 'legacy' ? operation(this.legacy) : this.authority.write('sqlite', () => operation(this.sqliteStore()), signal);
  }
  async checkpoint(): Promise<string> {
    const state = await this.state();
    return state.backend === 'legacy' ? `legacy:${state.epoch}` : `sqlite:${state.epoch}:${await this.sqliteStore().checkpoint()}`;
  }
  private readonly takeSnapshot = async (scopes: readonly MemoryScope[]): Promise<MemoryStoreSnapshot> => {
    const state = await this.state();
    if (state.backend !== 'sqlite') invalid('A fixed Memory commit view requires completed SQLite migration');
    const snapshot = await this.sqliteStore().snapshot(scopes);
    return { ...snapshot, generation: `sqlite:${state.epoch}:${snapshot.generation}` };
  };
  get snapshot(): IMemoryStore['snapshot'] { return this.backend === 'sqlite' ? this.takeSnapshot : undefined; }
  inventory(...args: Parameters<IMemoryStore['inventory']>): ReturnType<IMemoryStore['inventory']> { return this.read((store) => store.inventory(...args)); }
  list(...args: Parameters<IMemoryStore['list']>): ReturnType<IMemoryStore['list']> { return this.read((store) => store.list(...args)); }
  get(...args: Parameters<IMemoryStore['get']>): ReturnType<IMemoryStore['get']> { return this.read((store) => store.get(...args)); }
  put(...args: Parameters<IMemoryStore['put']>): ReturnType<IMemoryStore['put']> { return this.mutate((store) => store.put(...args), args[0].signal); }
  query(...args: Parameters<IMemoryStore['query']>): ReturnType<IMemoryStore['query']> { return this.read((store) => store.query(...args)); }
  delete(...args: Parameters<IMemoryStore['delete']>): ReturnType<IMemoryStore['delete']> { return this.mutate((store) => store.delete(...args)); }
  journal(...args: Parameters<IMemoryStore['journal']>): ReturnType<IMemoryStore['journal']> { return this.read((store) => store.journal(...args)); }
  undo(...args: Parameters<IMemoryStore['undo']>): ReturnType<IMemoryStore['undo']> { return this.mutate((store) => store.undo(...args)); }
  search(...args: Parameters<IMemoryStore['search']>): ReturnType<IMemoryStore['search']> { return this.read((store) => store.search(...args)); }
  listPersonaEntries(...args: Parameters<IMemoryStore['listPersonaEntries']>): ReturnType<IMemoryStore['listPersonaEntries']> { return this.read((store) => store.listPersonaEntries(...args)); }
  deletePersonaNamespaces(...args: Parameters<IMemoryStore['deletePersonaNamespaces']>): ReturnType<IMemoryStore['deletePersonaNamespaces']> { return this.mutate((store) => store.deletePersonaNamespaces(...args)); }
  importLorebook(...args: Parameters<IMemoryStore['importLorebook']>): ReturnType<IMemoryStore['importLorebook']> { return this.mutate((store) => store.importLorebook(...args)); }
}

export class MemoryAuthorityService implements IMemoryAuthorityService {
  declare readonly _serviceBrand: undefined;
  private readonly authority: MemoryAuthorityAccess;
  constructor(
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IMemoryScopes private readonly scopes: IMemoryScopes,
    @ILegacyMemoryStore private readonly legacy: IMemoryStore,
    @ISqliteMemoryStore private readonly sqlite: ISqliteMemoryStore,
    @IMemoryShadowImport private readonly shadow: IMemoryShadowImport,
    @IMemoryPersistence private readonly persistence: IMemoryPersistence,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
  ) { this.authority = new MemoryAuthorityAccess(storage); }
  status(): Promise<MemoryAuthorityState> { return this.authority.read(); }
  private async discover(): Promise<string[]> {
    const bases = new Set(['memory/global']);
    for (const id of await this.storage.list('memory/global/personas')) {
      if (!MEMORY_PERSONA_ID_PATTERN.test(id)) invalid(`Unsupported legacy persona namespace: ${id}`);
      bases.add(`memory/global/personas/${id}`);
    }
    for (const id of new Set([...await this.storage.list('memory/workspaces'), ...await this.scopes.listWorkspaceIds?.() ?? []])) {
      if (!MEMORY_WORKSPACE_ID_PATTERN.test(id)) invalid(`Unsupported legacy workspace namespace: ${id}`);
      const base = `memory/workspaces/${id}`;
      bases.add(base);
      for (const persona of await this.storage.list(`${base}/personas`)) {
        if (!MEMORY_PERSONA_ID_PATTERN.test(persona)) invalid(`Unsupported legacy persona namespace: ${persona}`);
        bases.add(`${base}/personas/${persona}`);
      }
    }
    if (bases.size > 1000) invalid('Memory migration exceeds 1000 namespaces');
    return [...bases].toSorted();
  }
  async migrate(input: { readonly operationId: string; readonly olderWritersStopped: true; readonly maxPages?: number }, signal?: AbortSignal): Promise<MemoryAuthorityState> {
    z.object({ operationId: z.string().uuid(), olderWritersStopped: z.literal(true), maxPages: z.number().int().min(1).max(64).optional() }).strict().parse(input);
    return this.authority.exclusive(async (lease) => {
      let state = await lease.read();
      if (state.backend === 'sqlite') {
        if (state.migrationId !== input.operationId) invalid('SQLite Memory already has a different migration');
        return state;
      }
      if (state.mode === 'migrating' && state.migration!.id !== input.operationId) invalid('A different Memory migration is in progress');
      if (state.mode === 'active') {
        state = { ...state, mode: 'migrating', migration: { id: input.operationId, namespaces: await this.discover(), index: 0, issues: [] } };
        await lease.publish(state);
      }
      for (let page = 0; page < (input.maxPages ?? 8) && state.migration!.index < state.migration!.namespaces.length; page++) {
        signal?.throwIfAborted();
        const progress = state.migration!;
        const base = progress.namespaces[progress.index]!;
        const result = await this.shadow.run(parseNamespace(base), progress.after, signal);
        const issues = [...progress.issues, ...result.issues].slice(0, 1000);
        state = { ...state, migration: { ...progress, issues, index: result.complete ? progress.index + 1 : progress.index, after: result.complete ? undefined : result.nextKey } };
        await lease.publish(state);
      }
      const progress = state.migration!;
      if (progress.index !== progress.namespaces.length || progress.issues.length > 0) return state;
      const issues = await this.validateAndReconcile(progress.namespaces, progress.id);
      if (issues.length > 0) { state = { ...state, migration: { ...progress, issues: issues.slice(0, 1000) } }; await lease.publish(state); return state; }
      signal?.throwIfAborted();
      const active: MemoryAuthorityState = { version: 1, epoch: state.epoch + 1, backend: 'sqlite', mode: 'active', migrationId: progress.id };
      await lease.publish(active);
      return active;
    }, signal);
  }
  private async validateAndReconcile(bases: readonly string[], operationId: string): Promise<Array<{ scope: string; key: string; issue: string }>> {
    const issues: Array<{ scope: string; key: string; issue: string }> = [];
    for (const base of bases) {
      const inventory = await this.legacy.inventory(parseNamespace(base));
      if (!inventory.complete) { issues.push({ scope: base, key: '', issue: 'legacy_inventory_incomplete' }); continue; }
      const expected = new Map(inventory.entries.map((entry) => [entry.id, entry]));
      if (expected.size !== inventory.entries.length) issues.push({ scope: base, key: '', issue: 'duplicate_legacy_identity' });
      const events = await this.persistence.journal(base);
      const latest = new Map(events.map((event) => [event.id, event]));
      let view = await this.persistence.read([base]);
      const edits: MemoryObjectEdit[] = [];
      for (const object of view.objects) {
        const entry = expected.get(object.id);
        if (entry !== undefined) {
          if (object.revision !== entry.revision) issues.push({ scope: base, key: object.id, issue: 'current_revision_preserved' });
        } else if (object.entry !== null) {
          const event = latest.get(object.id);
          if (event?.afterRevision === null && event.beforeRevision === object.revision) edits.push({ scope: base, id: object.id, expectedRevision: object.revision, revision: `legacy-deleted:${event.operationId}`, entry: null });
          else issues.push({ scope: base, key: object.id, issue: 'unmatched_shadow_head' });
        }
      }
      for (const entry of expected.values()) {
        if (!view.objects.some((object) => object.id === entry.id)) issues.push({ scope: base, key: entry.id, issue: 'legacy_head_missing' });
        const event = latest.get(entry.id);
        if (event !== undefined && event.afterRevision !== entry.revision) issues.push({ scope: base, key: entry.id, issue: 'legacy_journal_head_mismatch' });
      }
      if (issues.length > 0) continue;
      for (let offset = 0; offset < edits.length; offset += 1000) {
        const batch = edits.slice(offset, offset + 1000);
        await this.persistence.commit({ operationId: `${operationId}:delete:${base}:${offset}`, request: JSON.stringify(batch), expectedGeneration: view.generation, edits: batch, result: { reconciled: batch.length } });
        view = await this.persistence.read([base]);
      }
    }
    for (const base of await this.persistence.namespaces()) if (!bases.includes(base)) issues.push({ scope: base, key: '', issue: 'unmatched_shadow_namespace' });
    return issues;
  }
  cancelMigration(operationId: string): Promise<MemoryAuthorityState> {
    return this.authority.exclusive(async (lease) => {
      const state = await lease.read();
      if (state.mode !== 'migrating' || state.migration?.id !== operationId) invalid('Memory migration does not match the cancellation');
      const active: MemoryAuthorityState = { version: 1, epoch: state.epoch + 1, backend: 'legacy', mode: 'active' };
      await lease.publish(active);
      return active;
    });
  }
  private async requireSqlite(): Promise<void> { if ((await this.authority.read()).backend !== 'sqlite') invalid('This Memory governance operation requires completed SQLite migration'); }
  async getRevision(...args: Parameters<ISqliteMemoryStore['getRevision']>): ReturnType<ISqliteMemoryStore['getRevision']> { await this.requireSqlite(); return this.sqlite.getRevision(...args); }
  async provenance(...args: Parameters<ISqliteMemoryStore['provenance']>): ReturnType<ISqliteMemoryStore['provenance']> { await this.requireSqlite(); return this.sqlite.provenance(...args); }
  async previewForget(...args: Parameters<ISqliteMemoryStore['previewForget']>): Promise<MemoryForgetPreview> { await this.requireSqlite(); return this.sqlite.previewForget(...args); }
  forget(...args: Parameters<ISqliteMemoryStore['forget']>): Promise<void> { return this.authority.write('sqlite', () => this.sqlite.forget(...args)); }
  recoverReadOnly(): Promise<MemoryRecoveryPackage> {
    return this.authority.exclusive(async (lease) => {
      const state = await lease.read();
      if (state.backend !== 'sqlite') invalid('Recovery requires completed SQLite migration');
      if (state.mode === 'readonly') {
        const saved = await this.documents.get<MemoryRecoveryPackage>(`store/memory-recovery-v1/${state.recoveryId}`, 'manifest.json');
        if (saved === undefined) invalid('Memory recovery manifest is missing');
        return saved;
      }
      const recoveryId = randomUUID();
      const backup = await this.persistence.backup(recoveryId);
      const namespaces = await this.persistence.namespaces();
      const view = await this.persistence.read(namespaces, backup.generation);
      for (const object of view.objects) {
        if (object.entry === null) continue;
        const { body, ...metadata } = object.entry;
        const key = `${object.scope}/${object.entry.status === 'pending' ? 'inbox' : 'entries'}/${object.id}.md`;
        await this.storage.write(`${backup.scope}/legacy-current-view`, key, new TextEncoder().encode(`---\n${JSON.stringify(metadata, null, 2)}\n---\n${body}\n`), { atomic: true });
      }
      const manifest: MemoryRecoveryPackage = { recoveryId, scope: backup.scope, generation: backup.generation, namespaces, mode: 'readonly', database: 'memory.sqlite', compatibility: 'legacy-current-view', resume: 'resumeEditing' };
      await this.documents.set(backup.scope, 'manifest.json', manifest);
      await lease.publish({ ...state, epoch: state.epoch + 1, mode: 'readonly', recoveryId });
      return manifest;
    });
  }
  resumeEditing(recoveryId: string, expectedEpoch: number): Promise<MemoryAuthorityState> {
    return this.authority.exclusive(async (lease) => {
      const state = await lease.read();
      if (state.backend !== 'sqlite' || state.mode !== 'readonly' || state.recoveryId !== recoveryId || state.epoch !== expectedEpoch) invalid('Memory recovery state changed; reload its exact recovery ID and epoch');
      const active: MemoryAuthorityState = { version: 1, epoch: state.epoch + 1, backend: 'sqlite', mode: 'active', migrationId: state.migrationId };
      await lease.publish(active);
      return active;
    });
  }
}
registerScopedService(LifecycleScope.App, IMemoryStore, MemoryAuthorityStore, ScopeActivation.OnDemand, 'memory');
registerScopedService(LifecycleScope.App, IMemoryAuthorityService, MemoryAuthorityService, ScopeActivation.OnDemand, 'memory');
