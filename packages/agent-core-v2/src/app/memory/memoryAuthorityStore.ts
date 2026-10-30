import { createHmac, randomUUID } from 'node:crypto';
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
import { ILegacyMemoryStore, IMemoryStore, type MemoryEntry, type MemoryPutResult, type MemoryStoreChange, type MemoryStoreSnapshot } from './memoryStore';
import { ISqliteMemoryStore, memoryIngestSourceIds, type MemoryForgetPreview, type MemoryIngestCandidate } from './sqliteMemoryStore';
import { IMemoryShadowImport } from './memoryShadowImport';
import { MemoryDomainError } from './memoryMetadata';
import { parseMemoryMarkdown, serializeMemoryMarkdown, type MemoryMarkdownDocument } from './memoryMarkdown';
import { memoryObjectSourceUnitId, memorySourceUnitId } from './memorySourceIdentity';

export type { MemoryAuthorityState } from '#/persistence/memoryAuthority';
export type { MemoryMarkdownDocument } from './memoryMarkdown';
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
const importInputSchema = z.object({ markdown: z.string().max(65_536), sourceLocator: z.string().trim().min(1).max(2_000), reason: z.string().trim().min(1).max(500) }).strict();
const importTokenSchema = z.object({ version: z.literal(1), epoch: z.number().int().nonnegative(), expiresAt: z.number().int(), input: importInputSchema }).strict();
export type MemoryImportInput = z.infer<typeof importInputSchema>;
export interface MemoryImportPreview {
  readonly incoming: MemoryMarkdownDocument;
  readonly current: MemoryEntry | null;
  readonly action: 'create' | 'update' | 'unchanged' | 'retained';
  readonly canApply: boolean;
  readonly previewToken?: string;
  readonly expiresAt?: string;
  readonly issue?: { readonly code: 'revision_conflict' | 'inactive_target' | 'duplicate_title' | 'invalid_input'; readonly recovery: string };
}
export interface IMemoryAuthorityService {
  readonly _serviceBrand: undefined;
  status(): Promise<MemoryAuthorityState>;
  prepare(): Promise<MemoryAuthorityState>;
  retryMigration(operationId: string): Promise<MemoryAuthorityState>;
  migrate(input: { readonly operationId: string; readonly maxPages?: number }, signal?: AbortSignal): Promise<MemoryAuthorityState>;
  cancelMigration(operationId: string): Promise<MemoryAuthorityState>;
  recoverReadOnly(): Promise<MemoryRecoveryPackage>;
  resumeEditing(recoveryId: string, expectedEpoch: number): Promise<MemoryAuthorityState>;
  provenance(scope: MemoryScope, id: string): Promise<MemoryProvenance>;
  getRevision(scope: MemoryScope, id: string, revision: string): ReturnType<ISqliteMemoryStore['getRevision']>;
  previewForget(scope: MemoryScope, ids: readonly string[]): Promise<MemoryForgetPreview>;
  forget(...args: Parameters<ISqliteMemoryStore['forget']>): Promise<void>;
  exportMarkdown(scope: MemoryScope, id: string): Promise<{ readonly markdown: string; readonly entry: MemoryEntry }>;
  previewImport(scope: MemoryScope, input: MemoryImportInput): Promise<MemoryImportPreview>;
  applyImport(scope: MemoryScope, previewToken: string, operationId: string): Promise<MemoryPutResult>;
}
export const IMemoryAuthorityService = createDecorator<IMemoryAuthorityService>('memoryAuthorityService');
function invalid(message: string): never { throw new MemoryDomainError('invalid_input', message, 'Inspect Memory authority status and reconcile the reported operation before retrying.'); }
type MigrationIssue = NonNullable<MemoryAuthorityState['migration']>['issues'][number];
function blocksMigration(issue: MigrationIssue): boolean { return !['current_revision_preserved', 'forgotten_source_rejected'].includes(issue.issue); }
function uniqueIssues(issues: readonly MigrationIssue[]): MigrationIssue[] {
  return [...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()].toSorted((a, b) => Number(blocksMigration(b)) - Number(blocksMigration(a))).slice(0, 1000);
}
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
    @ILegacyMemoryStore legacy: IMemoryStore,
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
    let state = await this.authority.read();
    if (state.backend === 'legacy') {
      await this.instantiation.invokeFunction((accessor) => accessor.get(IMemoryAuthorityService)).prepare();
      state = await this.authority.read();
    }
    if (state.backend !== 'sqlite') invalid('Memory startup migration has not completed; inspect authority status and retry the same operation');
    this.backend = state.backend;
    return state;
  }
  async prepare(): Promise<void> { await this.state(); }
  private async read<T>(operation: (store: IMemoryStore) => Promise<T>): Promise<T> {
    await this.state();
    return operation(this.sqliteStore());
  }
  private async mutate<T>(operation: (store: IMemoryStore) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const state = await this.state();
    assertMemoryAuthorityWritable(state, 'sqlite');
    return this.authority.write('sqlite', () => operation(this.sqliteStore()), signal);
  }
  async checkpoint(): Promise<string> {
    const state = await this.state();
    return `sqlite:${state.epoch}:${await this.sqliteStore().checkpoint()}`;
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

export class MemoryAuthorityService extends Disposable implements IMemoryAuthorityService {
  declare readonly _serviceBrand: undefined;
  private readonly authority: MemoryAuthorityAccess;
  private readonly importSalt = randomUUID();
  private readonly shutdown = new AbortController();
  private preparation?: Promise<MemoryAuthorityState>;
  private preparing = false;
  constructor(
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IMemoryScopes private readonly scopes: IMemoryScopes,
    @ILegacyMemoryStore private readonly legacy: IMemoryStore,
    @ISqliteMemoryStore private readonly sqlite: ISqliteMemoryStore,
    @IMemoryShadowImport private readonly shadow: IMemoryShadowImport,
    @IMemoryPersistence private readonly persistence: IMemoryPersistence,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
  ) { super(); this.authority = new MemoryAuthorityAccess(storage); }
  override async dispose(): Promise<void> {
    this.shutdown.abort();
    await this.preparation?.catch(() => undefined);
    await super.dispose();
  }
  status(): Promise<MemoryAuthorityState> { return this.authority.read(); }
  prepare(): Promise<MemoryAuthorityState> {
    if (this.preparation === undefined) {
      this.preparing = true;
      this.preparation = this.prepareMigration().finally(() => { this.preparing = false; });
    }
    return this.preparation;
  }
  private async prepareMigration(): Promise<MemoryAuthorityState> {
    let state = await this.authority.read();
    let restart = true;
    while (state.backend === 'legacy') {
      state = await this.advance(undefined, 8, this.shutdown.signal, restart);
      restart = false;
      if (state.migration?.phase === 'failed') invalid(`Memory startup migration failed: ${state.migration.failure?.message ?? 'Inspect the reported source issues'}`);
    }
    await this.sqlite.checkpoint();
    return state;
  }
  async retryMigration(operationId: string): Promise<MemoryAuthorityState> {
    z.string().uuid().parse(operationId);
    const state = await this.authority.read();
    if ((state.backend === 'sqlite' ? state.migrationId : state.migration?.id) !== operationId) invalid('Memory migration does not match the retry');
    if (state.backend === 'sqlite') return state;
    if (this.preparing) return this.prepare();
    this.preparation = undefined;
    return this.prepare();
  }
  private async discover(): Promise<string[]> {
    const bases = new Set(['memory/global']);
    for (const id of await this.storage.list('memory/global/personas')) {
      if (!MEMORY_PERSONA_ID_PATTERN.test(id)) invalid(`Unsupported legacy persona namespace: ${id}`);
      bases.add(`memory/global/personas/${id}`);
    }
    for (const id of await this.storage.list('memory/workspaces')) {
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
  async migrate(input: { readonly operationId: string; readonly maxPages?: number }, signal?: AbortSignal): Promise<MemoryAuthorityState> {
    z.object({ operationId: z.string().uuid(), maxPages: z.number().int().min(1).max(64).optional() }).strict().parse(input);
    return this.advance(input.operationId, input.maxPages ?? 8, signal);
  }
  private advance(operationId: string | undefined, maxPages: number, signal?: AbortSignal, restart = false): Promise<MemoryAuthorityState> {
    return this.authority.exclusive(async (lease) => {
      let state = await lease.read();
      if (state.backend === 'sqlite') {
        if (operationId !== undefined && state.migrationId !== operationId) invalid('SQLite Memory already has a different migration');
        return state;
      }
      if (operationId !== undefined && state.mode === 'migrating' && state.migration!.id !== operationId) invalid('A different Memory migration is in progress');
      const id = state.migration?.id ?? operationId ?? randomUUID();
      try {
        if (state.mode === 'active') {
          state = { ...state, mode: 'migrating', migration: { id, namespaces: [], index: 0, issues: [], phase: 'importing' } };
          await lease.publish(state);
        }
        if (state.migration!.phase === 'failed' || restart && state.migration!.issues.length > 0) {
          const issues: MigrationIssue[] = [];
          for (const base of new Set(state.migration!.issues.map((issue) => issue.scope))) {
            let after: string | undefined;
            for (;;) {
              signal?.throwIfAborted();
              const result = await this.shadow.run(parseNamespace(base), after, signal);
              issues.push(...result.issues);
              if (result.complete) break;
              after = result.nextKey;
            }
          }
          state = { ...state, migration: { ...state.migration!, issues: uniqueIssues(issues), phase: 'importing', failure: undefined } };
          await lease.publish(state);
        }
        if (state.migration!.namespaces.length === 0) {
          state = { ...state, migration: { ...state.migration!, namespaces: await this.discover() } };
          await lease.publish(state);
        }
        for (let page = 0; page < maxPages && state.migration!.index < state.migration!.namespaces.length; page++) {
          signal?.throwIfAborted();
          const progress = state.migration!;
          const base = progress.namespaces[progress.index]!;
          const result = await this.shadow.run(parseNamespace(base), progress.after, signal);
          const issues = uniqueIssues([...progress.issues, ...result.issues]);
          state = { ...state, migration: { ...progress, phase: 'importing', failure: undefined, issues, index: result.complete ? progress.index + 1 : progress.index, after: result.complete ? undefined : result.nextKey } };
          await lease.publish(state);
        }
        let progress = state.migration!;
        if (progress.index !== progress.namespaces.length) return state;
        if (!progress.issues.some(blocksMigration)) {
          progress = { ...progress, phase: 'validating' };
          state = { ...state, migration: progress };
          await lease.publish(state);
          const issues = await this.validateAndReconcile(progress.namespaces, progress.id);
          progress = { ...progress, issues: uniqueIssues([...progress.issues, ...issues]) };
        }
        const blocking = progress.issues.filter(blocksMigration);
        if (blocking.length > 0) {
          state = { ...state, migration: { ...progress, phase: 'failed', failure: { code: 'memory.source_invalid', message: `Memory source validation found ${blocking.length} issue(s); repair the listed sources and retry this operation` } } };
          await lease.publish(state);
          return state;
        }
        await this.sqlite.checkpoint();
        signal?.throwIfAborted();
        const active: MemoryAuthorityState = { version: 1, epoch: state.epoch + 1, backend: 'sqlite', mode: 'active', migrationId: progress.id, migrationIssues: progress.issues.length === 0 ? undefined : progress.issues };
        await lease.publish(active);
        return active;
      } catch (error) {
        const current = await lease.read();
        if (current.backend === 'sqlite' && current.migrationId === id) return current;
        if (current.migration?.id === id && !signal?.aborted) {
          const code = (error as { code?: unknown })?.code;
          await lease.publish({ ...current, migration: { ...current.migration, phase: 'failed', failure: { code: typeof code === 'string' ? code : 'memory.migration_failed', message: error instanceof Error ? error.message : String(error) } } });
        }
        throw error;
      }
    }, signal);
  }
  private async validateAndReconcile(bases: readonly string[], operationId: string): Promise<MigrationIssue[]> {
    const issues: MigrationIssue[] = [];
    for (const base of bases) {
      const inventory = await this.legacy.inventory(parseNamespace(base));
      if (!inventory.complete) { issues.push({ scope: base, key: '', issue: 'legacy_inventory_incomplete' }); continue; }
      const rejected = new Set(await this.persistence.rejectedLegacyIds(base, inventory.entries));
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
        if (rejected.has(entry.id)) continue;
        if (!view.objects.some((object) => object.id === entry.id)) issues.push({ scope: base, key: entry.id, issue: 'legacy_head_missing' });
        const preserved = view.objects.some((object) => object.id === entry.id && object.revision !== entry.revision);
        const event = latest.get(entry.id);
        if (!preserved && event !== undefined && event.afterRevision !== entry.revision) issues.push({ scope: base, key: entry.id, issue: 'legacy_journal_head_mismatch' });
      }
      if (issues.some(blocksMigration)) continue;
      for (let offset = 0; offset < edits.length; offset += 1000) {
        const batch = edits.slice(offset, offset + 1000);
        await this.persistence.commit({ operationId: `${operationId}:delete:${base}:${offset}`, request: JSON.stringify(batch), expectedGeneration: view.generation, edits: batch, result: { reconciled: batch.length } });
        view = await this.persistence.read([base]);
      }
    }
    for (const base of await this.persistence.namespaces()) if (!bases.includes(base)) issues.push({ scope: base, key: '', issue: 'unmatched_shadow_namespace' });
    return issues;
  }
  async cancelMigration(operationId: string): Promise<MemoryAuthorityState> {
    if (this.preparing) invalid('Wait for the automatic Memory startup operation before cancelling a paused maintenance batch');
    const state = await this.authority.exclusive(async (lease) => {
      const state = await lease.read();
      if (state.mode !== 'migrating' || state.migration?.id !== operationId) invalid('Memory migration does not match the cancellation');
      const active: MemoryAuthorityState = { version: 1, epoch: state.epoch + 1, backend: 'legacy', mode: 'active' };
      await lease.publish(active);
      return active;
    });
    this.preparation = undefined;
    return state;
  }
  private async requireSqlite(): Promise<void> { if ((await this.authority.read()).backend !== 'sqlite') invalid('This Memory governance operation requires completed SQLite migration'); }
  async exportMarkdown(scope: MemoryScope, id: string): Promise<{ markdown: string; entry: MemoryEntry }> {
    await this.requireSqlite();
    const entry = await this.sqlite.get(scope, id);
    if (entry === undefined) throw new MemoryDomainError('not_found', 'Memory not found', 'Reload the current scoped entry before exporting.');
    await this.sqlite.provenance(scope, id);
    return { markdown: serializeMemoryMarkdown(scope, entry), entry };
  }
  private async importCandidate(scope: MemoryScope, input: MemoryImportInput): Promise<{ incoming: MemoryMarkdownDocument; candidate: MemoryIngestCandidate; base: string }> {
    const incoming = parseMemoryMarkdown(input.markdown);
    const identity = (value: MemoryScope) => JSON.stringify([value.kind, 'workspaceId' in value ? value.workspaceId : null, 'personaId' in value ? value.personaId : null]);
    if (identity(scope) !== identity(incoming.scope)) throw new MemoryDomainError('scope_mismatch', 'Markdown scope does not match the selected owner', 'Select the exported workspace and persona; exporting or importing never moves an entry.');
    const base = await this.scopes.resolve(scope);
    const content = JSON.stringify([incoming.source, incoming.origin?.revision ?? null, incoming.type, incoming.title, incoming.body, incoming.pinned, incoming.basis ?? null, incoming.validity]);
    const unitId = memorySourceUnitId(base, incoming.source, content, [input.sourceLocator], 'markdown-revision')!;
    const aliases = [memorySourceUnitId(base, incoming.source, incoming.body, [input.sourceLocator], 'markdown')!, ...(incoming.origin === null ? [] : [memoryObjectSourceUnitId(base, incoming.origin.id, incoming.body)])];
    const mutation = { scope, type: incoming.type, title: incoming.title, body: incoming.body, pinned: incoming.pinned, basis: incoming.basis, validity: incoming.validity, reason: input.reason, source: { writer: 'user' as const } };
    const signature = memorySourceUnitId(base, incoming.source, incoming.body, incoming.basis?.refs);
    const candidate: MemoryIngestCandidate = { mutation: incoming.id === 'new' ? mutation : { ...mutation, action: 'update', id: incoming.id, expectedRevision: incoming.revision! }, unit: { id: unitId, payload: input.markdown, locator: input.sourceLocator, origin: 'owner', sessionKind: 'interactive', aliases, signatures: signature === undefined ? [] : [signature] } };
    return { incoming, candidate, base };
  }
  async previewImport(scope: MemoryScope, original: MemoryImportInput): Promise<MemoryImportPreview> {
    const input = importInputSchema.parse(original);
    const state = await this.authority.read();
    assertMemoryAuthorityWritable(state, 'sqlite');
    const { incoming, candidate, base } = await this.importCandidate(scope, input);
    const states = await Promise.all(memoryIngestSourceIds(base, candidate.unit).map((id) => this.persistence.source(base, id)));
    const signatures = await Promise.all((candidate.unit.signatures ?? []).map((id) => this.persistence.source(base, id)));
    if ([...states, ...signatures].some((state) => state.state === 'forgotten')) throw new MemoryDomainError('inactive_target', 'This exact Markdown source has been forgotten', 'Use a distinct new source; an old source cannot recreate forgotten Memory.');
    const related = new Set(states.flatMap((state) => state.state === 'registered' ? state.objectIds : []));
    if (related.size > 0) {
      const view = await this.sqlite.snapshot([scope]);
      const linked = view.entries.filter((entry) => related.has(entry.id));
      const active = linked.filter((entry) => entry.status === 'active');
      if (active.length > 1) invalid('This Markdown source has conflicting active successors');
      const current = active[0] ?? linked.find((entry) => entry.status === 'pending') ?? linked.find((entry) => entry.status === 'archived');
      if (current === undefined) throw new MemoryDomainError('inactive_target', 'This Markdown source belongs to a deleted Memory object', 'Undo the recoverable deletion through its existing operation before editing.');
      if (states[0]?.state === 'registered' || incoming.id !== current.id || incoming.revision !== current.revision) return { incoming, current, action: 'retained', canApply: false };
    }
    const current = incoming.id === 'new' ? null : await this.sqlite.get(scope, incoming.id) ?? null;
    if (incoming.id !== 'new' && (current === null || current.revision !== incoming.revision)) return { incoming, current, action: 'update', canApply: false, issue: { code: 'revision_conflict', recovery: 'Export the current entry again, reconcile the complete content and preview that new file.' } };
    if (incoming.status !== 'active' || current !== null && current.status !== 'active') return { incoming, current, action: incoming.id === 'new' ? 'create' : 'update', canApply: false, issue: { code: 'inactive_target', recovery: 'Use the normal review or restoration controls for pending, replaced or archived entries before importing an edit.' } };
    if (incoming.id === 'new') {
      const active = (await this.sqlite.snapshot([scope])).entries.filter((entry) => entry.status === 'active');
      const duplicate = active.find((entry) => entry.title.toLowerCase() === incoming.title.toLowerCase());
      if (duplicate !== undefined) return { incoming, current: duplicate, action: 'create', canApply: false, issue: { code: 'duplicate_title', recovery: 'Export the existing entry and reconcile its complete content instead of creating a duplicate title.' } };
      if (active.length >= 300) return { incoming, current: null, action: 'create', canApply: false, issue: { code: 'invalid_input', recovery: 'The scope is full; merge or retire existing entries before importing a new one.' } };
    }
    const changedContent = current !== null && (current.type !== incoming.type || current.title !== incoming.title || current.body !== incoming.body);
    const projected = { ...incoming, basis: incoming.basis ?? (changedContent && current?.basis !== undefined ? { kind: 'unknown' as const, note: 'content changed without refreshed attribution' } : current?.basis) };
    if (current !== null && current.type === projected.type && current.title === projected.title && current.body === projected.body && current.pinned === projected.pinned && JSON.stringify(current.basis) === JSON.stringify(projected.basis) && JSON.stringify(current.validity ?? null) === JSON.stringify(projected.validity)) return { incoming: projected, current, action: 'unchanged', canApply: false };
    const expiresAt = Date.now() + 10 * 60_000;
    const payload = Buffer.from(JSON.stringify({ version: 1, epoch: state.epoch, expiresAt, input })).toString('base64url');
    const previewToken = `${payload}.${createHmac('sha256', this.importSalt).update(payload).digest('hex')}`;
    return { incoming: projected, current, action: incoming.id === 'new' ? 'create' : 'update', canApply: true, previewToken, expiresAt: new Date(expiresAt).toISOString() };
  }
  applyImport(scope: MemoryScope, previewToken: string, operationId: string): Promise<MemoryPutResult> {
    z.string().uuid().parse(operationId);
    return this.authority.write('sqlite', async () => {
      let token: z.infer<typeof importTokenSchema>;
      try {
        if (previewToken.length > 600_000) throw new Error('Oversized import preview');
        const [payload, signature, extra] = previewToken.split('.');
        if (!payload || !signature || extra !== undefined || createHmac('sha256', this.importSalt).update(payload).digest('hex') !== signature) throw new Error('Invalid import preview');
        token = importTokenSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
        if (token.expiresAt <= Date.now() || token.epoch !== (await this.authority.read()).epoch) throw new Error('Import preview expired or authority changed');
      } catch { throw new MemoryDomainError('invalid_input', 'Memory import preview is invalid, expired or from a different authority state', 'Preview the unchanged Markdown again and review its current target before confirming.'); }
      const { candidate } = await this.importCandidate(scope, token.input);
      return this.sqlite.ingest({ ...candidate, mutation: { ...candidate.mutation, operationId } });
    });
  }
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
      const active: MemoryAuthorityState = { version: 1, epoch: state.epoch + 1, backend: 'sqlite', mode: 'active', migrationId: state.migrationId, migrationIssues: state.migrationIssues };
      await lease.publish(active);
      return active;
    });
  }
}
registerScopedService(LifecycleScope.App, IMemoryStore, MemoryAuthorityStore, ScopeActivation.OnDemand, 'memory');
registerScopedService(LifecycleScope.App, IMemoryAuthorityService, MemoryAuthorityService, ScopeActivation.OnDemand, 'memory');
