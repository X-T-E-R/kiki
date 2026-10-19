import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { load } from 'js-yaml';
import { memoryQueryCursor, memoryQueryPage, memoryQueryRequest, rankMemoryEntries } from './memoryQuery';
import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { abortable } from '#/_base/utils/abort';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IMemoryScopes, MEMORY_PERSONA_ID_PATTERN, MEMORY_WORKSPACE_ID_PATTERN, type MemoryScope } from './memoryScopes';
import { redactMemorySecrets } from './memorySafety';
import { MemoryDomainError, memoryApplicability, normalizeMemoryBasis, normalizeMemoryValidity, type MemoryBasis, type MemoryValidity } from './memoryMetadata';
export * from './memoryMetadata';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = typeof TYPES[number];
export type MemoryStatus = 'active' | 'pending' | 'superseded' | 'archived';
export type MemoryWriter = 'user' | 'agent' | 'consolidator' | 'import';
export interface MemorySource {
  readonly writer: MemoryWriter;
  readonly session?: string;
  readonly turn?: number;
  readonly step?: string;
}
export interface MemoryEntry {
  readonly id: string;
  readonly type: MemoryType;
  readonly title: string;
  readonly body: string;
  readonly status: MemoryStatus;
  readonly pinned: boolean;
  readonly created: string;
  readonly updated: string;
  readonly source: MemorySource;
  readonly reason: string;
  readonly superseded_by?: string;
  readonly supersedes?: string;
  readonly supersedes_revision?: string;
  readonly pending_action?: 'update' | 'archive';
  readonly basis?: MemoryBasis;
  readonly validity?: MemoryValidity;
  readonly covered_by?: { readonly id: string; readonly revision: string };
  readonly revision: string;
}
export interface MemoryTarget {
  readonly scope: MemoryScope['kind'];
  readonly id: string;
  readonly expected_revision: string;
}
export interface MemoryMutation {
  readonly action: 'create' | 'update' | 'supersede' | 'archive';
  readonly scope: MemoryScope;
  readonly type?: MemoryType;
  readonly title?: string;
  readonly body?: string;
  readonly reason: string;
  readonly source: MemorySource;
  readonly id?: string;
  readonly expectedRevision?: string;
  readonly pinned?: boolean;
  readonly pending?: boolean;
  readonly basis?: MemoryBasis;
  readonly validity?: MemoryValidity | null;
  readonly covered_by?: { readonly id: string; readonly expected_revision: string };
  /** Cancels waiting and validation before journaling; a started commit finishes its catalog refresh. */
  readonly signal?: AbortSignal;
}
export interface MemoryPutResult {
  readonly entry: MemoryEntry;
  readonly operationId: string | null;
  readonly outcome: 'applied' | 'pending' | 'unchanged';
  readonly warnings?: readonly string[];
}
export interface MemoryQuery {
  readonly mode?: 'search' | 'list';
  readonly scope?: MemoryScope['kind'];
  readonly query?: string;
  readonly type?: MemoryType;
  readonly statuses?: readonly MemoryStatus[];
  readonly page_size?: number;
  readonly cursor?: string;
}
export interface MemoryQueryPage {
  readonly items: readonly (MemoryEntry & { readonly scope: MemoryScope; readonly score?: number })[];
  readonly mode: 'search' | 'list';
  readonly next_cursor: string | null;
  readonly coverage: { readonly scopes: readonly MemoryScope[]; readonly statuses: readonly MemoryStatus[]; readonly exhausted: boolean; readonly complete: boolean; readonly warnings: readonly string[] };
}
export interface MemoryJournalRecord {
  readonly operationId: string;
  readonly action: string;
  readonly id: string;
  readonly at: string;
  readonly writer: MemoryWriter;
  readonly before: string | null;
  readonly beforeRevision: string | null;
  readonly afterRevision: string | null;
}
export interface MemoryLorebookEntry {
  readonly name?: string;
  readonly title?: string;
  readonly content: string;
  readonly constant?: boolean;
}
export interface MemoryPersonaEntry extends MemoryEntry {
  readonly scope: MemoryScope;
}
export interface MemoryPersonaDeleteResult {
  readonly namespaceCount: number;
  readonly entryCount: number;
}
export interface MemoryStoreChange {
  readonly scope: MemoryScope;
  readonly id: string;
  readonly operationId: string;
  readonly beforeStatus?: MemoryStatus;
  readonly afterStatus?: MemoryStatus;
}
export interface MemoryInventory {
  readonly entries: readonly MemoryEntry[];
  readonly complete: boolean;
  readonly warnings: readonly string[];
  readonly fingerprint: string;
}
export interface IMemoryStore {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<MemoryStoreChange>;
  inventory(scope: MemoryScope): Promise<MemoryInventory>;
  list(scope: MemoryScope, includeInactive?: boolean): Promise<readonly MemoryEntry[]>;
  get(scope: MemoryScope, id: string): Promise<MemoryEntry | undefined>;
  put(input: MemoryMutation): Promise<MemoryPutResult>;
  query(scopes: readonly MemoryScope[], input: MemoryQuery, signal?: AbortSignal): Promise<MemoryQueryPage>;
  delete(scope: MemoryScope, id: string, expectedRevision: string, writer?: MemoryWriter): Promise<string>;
  journal(scope: MemoryScope, id?: string): Promise<readonly MemoryJournalRecord[]>;
  undo(scope: MemoryScope, operationId: string | null): Promise<MemoryEntry | undefined>;
  search(scopes: readonly MemoryScope[], query: string, type?: MemoryType, includeInactive?: boolean): Promise<readonly (MemoryEntry & { score: number; scope: MemoryScope })[]>;
  listPersonaEntries(personaId: string): Promise<readonly MemoryPersonaEntry[]>;
  deletePersonaNamespaces(personaId: string): Promise<MemoryPersonaDeleteResult>;
  importLorebook(scope: MemoryScope, entries: readonly MemoryLorebookEntry[], source?: Partial<MemorySource>): Promise<readonly { readonly entry: MemoryEntry; readonly operationId: string }[]>;
}
export const IMemoryStore = createDecorator<IMemoryStore>('memoryStore');

function assertPersonaId(personaId: string): void {
  if (!MEMORY_PERSONA_ID_PATTERN.test(personaId)) throw new Error('Invalid persona id');
}

function revision(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
function entryKey(id: string, pending: boolean): string {
  if (!/^m_[a-zA-Z0-9_]+$/.test(id)) throw new Error('Invalid memory id');
  return `${pending ? 'inbox' : 'entries'}/${id}.md`;
}
function encode(entry: Omit<MemoryEntry, 'revision'>): string {
  const { body, ...meta } = entry;
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n${body}\n`;
}
function metadataText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) return String(value);
  throw new Error('Invalid memory metadata');
}
function decode(raw: string): MemoryEntry {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (match === null) throw new Error('Invalid memory frontmatter');
  const meta = load(match[1]!) as Record<string, unknown>;
  if (meta === null || typeof meta !== 'object' || typeof meta['id'] !== 'string' || !/^m_[a-zA-Z0-9_]+$/.test(meta['id']) || !TYPES.includes(meta['type'] as MemoryType) || typeof meta['title'] !== 'string' || !['active', 'pending', 'superseded', 'archived'].includes(meta['status'] as string)) throw new Error('Invalid memory metadata');
  const body = match[2]!.replace(/\r?\n$/, '');
  const source = meta['source'] as MemorySource;
  return {
    id: meta['id'], type: meta['type'] as MemoryType, title: redactMemorySecrets(meta['title']),
    body: redactMemorySecrets(body),
    status: meta['status'] as MemoryStatus, pinned: meta['pinned'] === true,
    created: metadataText(meta['created']), updated: metadataText(meta['updated']),
    source: source && typeof source === 'object' && ['user', 'agent', 'consolidator', 'import'].includes(source.writer) ? source : { writer: 'import' },
    reason: redactMemorySecrets(metadataText(meta['reason'])),
    superseded_by: typeof meta['superseded_by'] === 'string' ? meta['superseded_by'] : undefined,
    supersedes: typeof meta['supersedes'] === 'string' ? meta['supersedes'] : undefined,
    supersedes_revision: typeof meta['supersedes_revision'] === 'string' ? meta['supersedes_revision'] : undefined,
    pending_action: meta['pending_action'] === 'update' || meta['pending_action'] === 'archive' ? meta['pending_action'] : undefined,
    basis: normalizeMemoryBasis(meta['basis']),
    validity: normalizeMemoryValidity(meta['validity']),
    covered_by: meta['covered_by'] !== undefined ? decodeCoveredBy(meta['covered_by']) : undefined,
    revision: revision(raw),
  };
}

function decodeCoveredBy(value: unknown): { id: string; revision: string } {
  const covered = value as Record<string, unknown>;
  if (covered === null || typeof covered !== 'object' || typeof covered['id'] !== 'string' || !/^m_[a-zA-Z0-9_]+$/.test(covered['id']) || typeof covered['revision'] !== 'string') throw new Error('Invalid covered memory metadata');
  return { id: covered['id'], revision: covered['revision'] };
}
function mutableEqual(a: MemoryEntry, b: Omit<MemoryEntry, 'revision'>): boolean {
  return a.type === b.type && a.title === b.title && a.body === b.body && a.pinned === b.pinned && a.status === b.status
    && JSON.stringify(a.basis) === JSON.stringify(b.basis) && JSON.stringify(a.validity) === JSON.stringify(b.validity)
    && JSON.stringify(a.covered_by) === JSON.stringify(b.covered_by);
}

export class MemoryStore extends Disposable implements IMemoryStore {
  declare readonly _serviceBrand: undefined;
  private readonly changeEmitter = this._register(new Emitter<MemoryStoreChange>());
  readonly onDidChange = this.changeEmitter.event;
  private readonly writeQueues = new Map<string, Promise<void>>();
  constructor(
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IMemoryScopes private readonly scopes: IMemoryScopes,
  ) { super(); }

  private async serializedWrite<T>(base: string, action: () => Promise<T>, changesActive = true, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const previous = this.writeQueues.get(base) ?? Promise.resolve();
    let done!: () => void;
    const released = new Promise<void>((resolve) => { done = resolve; });
    const current = previous.then(() => released);
    this.writeQueues.set(base, current);
    void current.then(() => {
      if (this.writeQueues.get(base) === current) this.writeQueues.delete(base);
    });
    try {
      await (signal === undefined ? previous : abortable(previous, signal));
      signal?.throwIfAborted();
      const lock = await this.storage.acquireLock(base, 'memory-write', {
        leaseMs: 30_000, waitForMs: 5_000, owner: { kind: 'memory-write', scope: base, pid: process.pid },
      });
      try {
        signal?.throwIfAborted();
        const before = await this.storage.size(base, 'journal.jsonl');
        try {
          return await action();
        } finally {
          if (changesActive && await this.storage.size(base, 'journal.jsonl') !== before) await this.rebuildCatalog(base);
        }
      } finally { await lock.release(); }
    } finally {
      done();
    }
  }

  private async raw(scope: string, id: string): Promise<{ key: string; text: string } | undefined> {
    const active = entryKey(id, false);
    if ((await this.storage.size(scope, active) ?? 0) > 64 * 1024) throw new Error('Memory entry too large');
    const bytes = await this.storage.read(scope, active, { recoverMissing: false });
    if (bytes !== undefined) return { key: active, text: decoder.decode(bytes) };
    const pending = entryKey(id, true);
    if ((await this.storage.size(scope, pending) ?? 0) > 64 * 1024) throw new Error('Memory entry too large');
    const inbox = await this.storage.read(scope, pending, { recoverMissing: false });
    return inbox === undefined ? undefined : { key: pending, text: decoder.decode(inbox) };
  }

  async inventory(scope: MemoryScope): Promise<MemoryInventory> {
    const base = await this.scopes.resolve(scope);
    const entries: MemoryEntry[] = [];
    const fingerprint = createHash('sha256');
    let skipped = 0;
    let totalBytes = 0;
    let visited = 0;
    for (const folder of ['entries', 'inbox'] as const) {
      const names = (await this.storage.list(`${base}/${folder}`)).filter((name) => /^m_[a-zA-Z0-9_]+\.md$/.test(name)).toSorted();
      fingerprint.update(JSON.stringify([folder, names]));
      for (let offset = 0; offset < names.length; offset += 16) {
        if (visited >= 10_000 || totalBytes >= 16 * 1024 * 1024) { skipped += names.length - offset; fingerprint.update('inventory_budget'); break; }
        const stats = await Promise.all(names.slice(offset, offset + 16).map(async (name) => {
          const key = `${folder}/${name}`;
          try { return { name, key, size: await this.storage.size(base, key) }; }
          catch { return { name, key, size: undefined }; }
        }));
        const accepted = stats.filter(({ key, size }) => {
          fingerprint.update(JSON.stringify([key, size]));
          if (++visited > 10_000 || size === undefined || size > 64 * 1024 || (totalBytes += size) > 16 * 1024 * 1024) { skipped++; return false; }
          return true;
        });
        const records = await Promise.all(accepted.map(async ({ name, key }) => {
          try {
            let bytes = await this.storage.read(base, key, { recoverMissing: false });
            if (bytes === undefined) {
              await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
              bytes = await this.storage.read(base, key, { recoverMissing: false });
            }
            return { name, key, bytes };
          } catch { return { name, key, bytes: undefined }; }
        }));
        for (const { name, key, bytes } of records) {
          if (bytes === undefined) { skipped++; fingerprint.update(`unavailable:${key}`); continue; }
          fingerprint.update(bytes);
          try {
            const entry = decode(decoder.decode(bytes));
            if (entry.id !== name.slice(0, -3)) { skipped++; continue; }
            entries.push(entry);
          } catch { skipped++; }
        }
      }
    }
    return { entries, complete: skipped === 0, warnings: skipped === 0 ? [] : [`${skipped} memory records were skipped (unavailable, invalid, oversized, or inventory budget exceeded).`], fingerprint: fingerprint.digest('hex') };
  }

  async list(scope: MemoryScope, includeInactive = false): Promise<readonly MemoryEntry[]> {
    const inventory = await this.inventory(scope);
    if (inventory.warnings.length > 0) throw new MemoryDomainError('storage_unavailable', inventory.warnings.join(' '), 'Use the paged query coverage to inspect the partial inventory and repair storage before maintenance.');
    return inventory.entries.filter((entry) => includeInactive || entry.status === 'active' || entry.status === 'pending')
      .toSorted((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
  }

  async get(scope: MemoryScope, id: string): Promise<MemoryEntry | undefined> {
    const found = await this.raw(await this.scopes.resolve(scope), id);
    return found === undefined ? undefined : decode(found.text);
  }

  async put(input: MemoryMutation): Promise<MemoryPutResult> {
    const scope = input.scope;
    const base = await this.scopes.resolve(scope);
    return this.serializedWrite(base, async () => {
      let target = input.id === undefined ? undefined : await this.raw(base, input.id);
      const candidate = target === undefined ? undefined : decode(target.text);
      let accepted: typeof target;
      if (input.action !== 'create' && !input.expectedRevision) throw new MemoryDomainError('missing_revision', 'Memory revision is required', 'Read the complete target and copy its latest revision.');
      if (input.action === 'create' && (input.id !== undefined || input.expectedRevision !== undefined)) throw new MemoryDomainError('invalid_input', 'Create does not accept an existing target', 'Use update with the existing target.');
      if (candidate?.status === 'pending' && input.action !== 'update') throw new MemoryDomainError('inactive_target', 'A proposal is not an active replacement target', 'Inspect or edit the proposal; approve or discard it through user review.');
      if (candidate?.status === 'pending' && !input.pending) {
        if (input.source.writer !== 'user') throw new MemoryDomainError('inactive_target', 'A pending proposal requires user review', 'Inspect the proposal with include_pending=true; use the existing review management path.');
        if (input.action !== 'update' || candidate.revision !== input.expectedRevision) throw new MemoryDomainError('revision_conflict', 'Memory revision conflict', 'Read the latest proposal before reviewing.');
        if (candidate.pending_action !== undefined) {
          if (candidate.supersedes === undefined || candidate.supersedes_revision === undefined) throw new MemoryDomainError('inactive_target', 'Proposal target is unavailable', 'Inspect the proposal before reviewing.');
          accepted = target;
          const proposalChanged = input.type !== candidate.type || redactMemorySecrets(input.title?.trim() ?? '') !== candidate.title || redactMemorySecrets(input.body?.trim() ?? '') !== candidate.body;
          input = { ...input, action: candidate.pending_action, id: candidate.supersedes, expectedRevision: candidate.supersedes_revision,
            basis: input.basis ?? (proposalChanged && candidate.basis !== undefined ? { kind: 'unknown', note: 'content changed without refreshed attribution' } : candidate.basis), validity: input.validity === undefined ? candidate.validity ?? null : input.validity,
            covered_by: candidate.covered_by === undefined ? undefined : { id: candidate.covered_by.id, expected_revision: candidate.covered_by.revision } };
          target = await this.raw(base, input.id!);
        }
      }
      const old = target === undefined ? undefined : decode(target.text);
      if (input.action !== 'create' && old === undefined) throw new MemoryDomainError('not_found', 'Memory not found', 'Locate the target in visible scopes; do not create a duplicate.');
      if (input.action !== 'create' && old!.revision !== input.expectedRevision) throw new MemoryDomainError('revision_conflict', 'Memory revision conflict', 'Read the latest target and reconcile its conditions before retrying.');
      if (!input.reason.trim()) throw new Error('Memory reason is required');
      const archive = input.action === 'archive' || (candidate?.pending_action === 'archive' && input.pending === true);
      const preserved = archive && candidate?.pending_action === 'archive' && candidate.supersedes !== undefined ? await this.get(scope, candidate.supersedes) : old;
      const type = archive ? preserved?.type : input.type;
      const title = archive ? preserved?.title : input.title === undefined ? undefined : redactMemorySecrets(input.title.trim());
      const body = archive ? preserved?.body : input.body === undefined ? undefined : redactMemorySecrets(input.body.trim());
      if (type === undefined || !TYPES.includes(type)) throw new Error('Invalid memory type');
      if (title === undefined || !title.trim() || title.length > 200 || body === undefined || !body.trim() || body.length > 1_500) throw new Error('Memory title or body length is invalid');
      const reason = redactMemorySecrets(input.reason.trim());
      const isCreate = input.action === 'create' || input.action === 'supersede';
      const isProposal = input.pending === true && candidate?.status !== 'pending' && (input.action === 'update' || input.action === 'archive');
      const contentChanged = old !== undefined && (old.type !== type || old.title !== title || old.body !== body);
      const warnings: string[] = [];
      if (archive && ((input.type !== undefined && input.type !== type) || (input.title !== undefined && input.title !== title) || (input.body !== undefined && input.body !== body))) warnings.push('ignored_archive_content');
      const basis = archive ? preserved?.basis : input.basis !== undefined ? normalizeMemoryBasis(input.basis) : !isCreate && contentChanged && old?.basis !== undefined
        ? { kind: 'unknown' as const, note: 'content changed without refreshed attribution' } : isCreate ? undefined : old?.basis;
      if (!archive && contentChanged && basis?.kind === 'unknown' && basis.note === 'content changed without refreshed attribution') warnings.push('content changed without refreshed attribution');
      const validity = archive ? preserved?.validity : input.validity === undefined ? isCreate ? undefined : old?.validity : normalizeMemoryValidity(input.validity);
      if (input.covered_by !== undefined && !archive) throw new MemoryDomainError('invalid_input', 'covered_by is only accepted for archive', 'Remove covered_by from this action.');
      const dependency = input.covered_by ?? (archive && candidate?.covered_by !== undefined ? { id: candidate.covered_by.id, expected_revision: candidate.covered_by.revision } : undefined);
      const checkDependency = async (): Promise<void> => {
        if (dependency === undefined) return;
        const covered = dependency.id === input.id ? undefined : await this.get(scope, dependency.id);
        if (covered === undefined || covered.status !== 'active' || covered.revision !== dependency.expected_revision || memoryApplicability(covered) === 'expired') throw new MemoryDomainError('covered_target_changed', 'Covered memory target changed or is not active in this scope', 'Read the retained same-scope active entry, check its conditions and validity, then retry with its latest revision.');
      };
      await checkDependency();
      const covered_by = dependency === undefined ? archive ? preserved?.covered_by : undefined : { id: dependency.id, revision: dependency.expected_revision };
      const id = isCreate || isProposal ? `m_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}_${randomBytes(5).toString('hex')}` : input.id!;
      const now = new Date().toISOString();
      const superseded = input.action === 'supersede' ? target : old?.status === 'pending' && old.supersedes !== undefined && !input.pending ? await this.raw(base, old.supersedes) : undefined;
      if (old?.status === 'pending' && old.supersedes !== undefined && !input.pending && (superseded === undefined || revision(superseded.text) !== old.supersedes_revision)) throw new MemoryDomainError('revision_conflict', 'Memory revision conflict', 'Read the predecessor before approving the proposal.');
      const entry: Omit<MemoryEntry, 'revision'> = {
        id, type, title, body, basis, validity, covered_by,
        status: input.pending ? 'pending' : input.action === 'archive' ? 'archived' : 'active',
        pinned: archive ? preserved?.pinned ?? false : input.pinned ?? (isCreate ? false : old?.pinned) ?? false,
        created: isCreate || isProposal ? now : old?.created ?? now, updated: now,
        source: input.source, reason,
        supersedes: input.pending ? input.action === 'supersede' || isProposal ? input.id : old?.supersedes : old?.status === 'pending' ? undefined : old?.supersedes,
        supersedes_revision: input.pending ? input.action === 'supersede' || isProposal ? input.expectedRevision : old?.supersedes_revision : undefined,
        superseded_by: input.action === 'archive' ? old?.superseded_by : undefined,
        pending_action: isProposal ? input.action as 'update' | 'archive' : input.pending ? old?.pending_action : undefined,
      };
      if (!isCreate && accepted === undefined && old !== undefined && mutableEqual(old, isProposal ? { ...entry, status: input.action === 'archive' ? 'archived' : 'active' } : entry)) return { entry: old, operationId: null, outcome: 'unchanged', warnings };
      if (input.pending && candidate?.status !== 'pending') {
        const duplicate = (await this.list(scope, true)).find((item) => item.status === 'pending' && item.supersedes === entry.supersedes && item.supersedes_revision === entry.supersedes_revision && item.pending_action === entry.pending_action && mutableEqual(item, entry));
        if (duplicate !== undefined) return { entry: duplicate, operationId: null, outcome: 'pending', warnings };
      }
      if (isCreate || entry.status === 'active') {
        let count = 0;
        let duplicateTitle = false;
        let cursor: string | undefined;
        do {
          const page = await this.queryChunk([scope], cursor === undefined ? { mode: 'list', statuses: ['active'] } : { cursor }, true, input.signal);
          if (!page.coverage.complete) throw new MemoryDomainError('storage_unavailable', page.coverage.warnings.join(' '), 'Repair unreadable memory records before changing active capacity.');
          count += page.items.length;
          duplicateTitle ||= page.items.some((item) => item.title.toLowerCase() === title.toLowerCase());
          cursor = page.next_cursor ?? undefined;
        } while (cursor !== undefined);
        const removed = new Set<string>();
        if (old?.status === 'active' && old.id === entry.id) removed.add(old.id);
        if (superseded !== undefined && !input.pending && decode(superseded.text).status === 'active') removed.add(decode(superseded.text).id);
        const finalCount = count - removed.size + Number(entry.status === 'active');
        if (finalCount > this.activeCapacity) throw new Error('Memory scope is full; merge existing entries');
        if (input.action === 'create' && duplicateTitle) throw new MemoryDomainError('duplicate_title', 'Similar memory already exists; update or supersede it', 'Search this title in the owning scope and read the existing target.');
      }
      await checkDependency();
      input.signal?.throwIfAborted();
      const key = entryKey(id, entry.status === 'pending');
      const encoded = encode(entry);
      const op = randomUUID();
      if (superseded !== undefined && !input.pending) {
        const previous = decode(superseded.text);
        const oldEntry = { ...previous, revision: undefined, status: 'superseded' as const, superseded_by: id, updated: now };
        await this.commit(scope, base, superseded.key, superseded, encode(oldEntry), 'supersede_previous', previous.id, input.source.writer, op);
      }
      try {
        await this.commit(scope, base, key, isCreate || isProposal ? undefined : target, encoded, input.action, id, input.source.writer, op, archive && !input.pending ? checkDependency : undefined);
      } catch (error) {
        if (superseded !== undefined && !input.pending && (await this.raw(base, id))?.text !== encoded) {
          const current = await this.raw(base, superseded.key.slice(superseded.key.lastIndexOf('/') + 1, -3));
          if (current !== undefined && decode(current.text).superseded_by === id) {
            await this.commit(scope, base, superseded.key, current, superseded.text, 'supersede_rollback', decode(superseded.text).id, input.source.writer);
          }
        }
        throw error;
      }
      if (!isCreate && !isProposal && target!.key !== key) await this.storage.delete(base, target!.key);
      if (accepted !== undefined) await this.commit(scope, base, accepted.key, accepted, undefined, 'accept_proposal', candidate!.id, input.source.writer, op);
      return { entry: decode(encoded), operationId: op, outcome: entry.status === 'pending' ? 'pending' : 'applied', warnings };
    }, input.pending !== true, input.signal);
  }

  async delete(scope: MemoryScope, id: string, expectedRevision: string, writer: MemoryWriter = 'user'): Promise<string> {
    const base = await this.scopes.resolve(scope);
    return this.serializedWrite(base, async () => {
      const target = await this.raw(base, id);
      if (target === undefined || revision(target.text) !== expectedRevision) throw new Error('Memory revision conflict');
      return this.commit(scope, base, target.key, target, undefined, 'delete', id, writer);
    });
  }

  async journal(scope: MemoryScope, id?: string): Promise<readonly MemoryJournalRecord[]> {
    const base = await this.scopes.resolve(scope);
    const bytes = await this.storage.read(base, 'journal.jsonl', { recoverMissing: false });
    if (bytes === undefined) return [];
    return decoder.decode(bytes).split('\n').filter(Boolean).flatMap((line) => {
      try {
        const event = JSON.parse(line) as MemoryJournalRecord;
        return id === undefined || event.id === id ? [event] : [];
      } catch { return []; }
    });
  }

  async undo(scope: MemoryScope, operationId: string | null): Promise<MemoryEntry | undefined> {
    const base = await this.scopes.resolve(scope);
    return this.serializedWrite(base, async () => {
      const events = (await this.journal(scope)).filter((item) => item.operationId === operationId);
      if (events.length === 0) throw new Error('Memory operation not found');
      const targets = await Promise.all(events.map((event) => this.raw(base, event.id)));
      const currentRevisions = targets.map((target) => target === undefined ? null : revision(target.text));
      const recoverablePartial = events.some((event) => event.action === 'supersede_previous' || event.action === 'accept_proposal');
      const changed = events.some((event, index) => currentRevisions[index] === event.afterRevision);
      if (!changed) throw new Error('Memory revision conflict');
      for (const [index, event] of events.entries()) {
        if (currentRevisions[index] === event.afterRevision) continue;
        if (!recoverablePartial || currentRevisions[index] !== event.beforeRevision) throw new Error('Memory revision conflict');
      }
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index]!;
        if (currentRevisions[index] === event.beforeRevision) continue;
        const target = targets[index];
        const key = event.before === null ? target?.key ?? entryKey(event.id, false) : entryKey(event.id, decode(event.before).status === 'pending');
        await this.commit(scope, base, key, target, event.before ?? undefined, 'undo', event.id, 'user');
        if (target !== undefined && target.key !== key) await this.storage.delete(base, target.key);
      }
      const primary = events.find((event) => event.action !== 'supersede_previous') ?? events[0]!;
      return primary.before === null ? undefined : decode(primary.before);
    });
  }

  private readonly cursorSalt = randomUUID();
  private readonly queryBudget = { records: 10_000, bytes: 16 * 1024 * 1024 };
  private readonly activeCapacity = 300;

  async query(scopes: readonly MemoryScope[], input: MemoryQuery, signal?: AbortSignal): Promise<MemoryQueryPage> {
    return this.queryChunk(scopes, input, false, signal);
  }

  private async queryChunk(scopes: readonly MemoryScope[], input: MemoryQuery, wholeChunk: boolean, signal?: AbortSignal): Promise<MemoryQueryPage> {
    signal?.throwIfAborted();
    const parsed = memoryQueryRequest(scopes, input, this.cursorSalt);
    const { request, position } = parsed;
    const sources: { scope: MemoryScope; base: string; key: string }[] = [];
    const directoryProof: unknown[] = [];
    const directoryChecks: (() => Promise<unknown>)[] = [];
    for (const scope of scopes) {
      if (request.scope !== undefined && scope.kind !== request.scope) continue;
      const base = await this.scopes.resolve(scope);
      const statuses = request.statuses ?? ['active'];
      const folders = statuses.every((status) => status === 'pending') ? ['inbox'] : statuses.includes('pending') ? ['entries', 'inbox'] : ['entries'];
      for (const folder of folders) {
        const proof = async () => [scope, folder, (await this.storage.list(`${base}/${folder}`)).filter((name) => /^m_[a-zA-Z0-9_]+\.md$/.test(name)).toSorted(), await this.storage.mtime(base, folder)] as const;
        const current = await proof();
        directoryProof.push(current);
        directoryChecks.push(proof);
        for (const name of current[2]) sources.push({ scope, base, key: `${folder}/${name}` });
      }
      const proof = async () => [scope, await this.storage.mtime(base, 'journal.jsonl'), await this.storage.size(base, 'journal.jsonl')];
      directoryProof.push(await proof());
      directoryChecks.push(proof);
    }
    const namesFingerprint = revision(JSON.stringify(directoryProof));
    const invalidated = (): never => { throw new MemoryDomainError('cursor_invalidated', 'Memory source changed during pagination', 'Restart the original query and reconcile scope plus ID across pages.'); };
    if (position.namesFingerprint !== undefined && position.namesFingerprint !== namesFingerprint) invalidated();
    position.namesFingerprint = namesFingerprint;
    const readBytes = async (base: string, key: string, charge: (bytes: number) => void): Promise<Uint8Array> => {
      const parts: Uint8Array[] = [];
      let length = 0;
      for await (const part of this.storage.readStream(base, key, { start: 0, end: 64 * 1024 }, { recoverMissing: false, chunkBytes: 64 * 1024, signal })) {
        signal?.throwIfAborted();
        charge(part.byteLength);
        length += part.byteLength;
        if (length > 64 * 1024) throw new Error('Memory entry too large');
        parts.push(part);
      }
      return Buffer.concat(parts);
    };
    let validationHash = position.validationHash;
    let validationEnd = position.validationOffset;
    let validationBytes = 0;
    const validated = new Map<number, { bytes: Uint8Array; size: number; mtime: number }>();
    while (validationEnd < sources.length && validationEnd - position.validationOffset < this.queryBudget.records) {
      signal?.throwIfAborted();
      const { base, key } = sources[validationEnd]!;
      const size = await this.storage.size(base, key).catch(() => undefined);
      if (size !== undefined && size <= 64 * 1024 && validationBytes + size > this.queryBudget.bytes && validationEnd > position.validationOffset) break;
      const beforeMtime = await this.storage.mtime(base, key).catch(() => undefined);
      let contentHash: string | undefined;
      let bytes: Uint8Array | undefined;
      if (size !== undefined && size <= 64 * 1024) {
        try {
          bytes = await readBytes(base, key, (count) => { validationBytes += count; });
          contentHash = createHash('sha256').update(bytes).digest('hex');
        } catch { contentHash = 'unavailable'; }
      }
      const mtime = await this.storage.mtime(base, key).catch(() => undefined);
      if (bytes !== undefined && beforeMtime !== mtime) invalidated();
      if (bytes !== undefined && size !== undefined && mtime !== undefined && validationEnd >= position.sourceOffset && validationEnd - position.sourceOffset < this.queryBudget.records) validated.set(validationEnd, { bytes, size, mtime });
      validationHash = revision(JSON.stringify([validationHash, key, size, mtime, contentHash]));
      validationEnd++;
    }
    signal?.throwIfAborted();
    if (validationEnd < sources.length) {
      const warnings = position.skipped === 0 ? [] : [`${position.skipped} memory records were skipped (unavailable, invalid, or oversized).`];
      return { items: [], mode: request.mode ?? 'search', next_cursor: memoryQueryCursor(scopes, request, { ...position, validationOffset: validationEnd, validationHash }, this.cursorSalt), coverage: { scopes: scopes.filter((scope) => request.scope === undefined || scope.kind === request.scope), statuses: request.statuses ?? ['active'], exhausted: false, complete: position.skipped === 0, warnings } };
    }
    if (position.fingerprint !== undefined && position.fingerprint !== validationHash) invalidated();
    position.fingerprint = validationHash;
    const entries: (MemoryEntry & { scope: MemoryScope })[] = [];
    let bytesRead = 0;
    let skipped = 0;
    let nextSourceOffset = position.sourceOffset;
    let chunkHash = '';
    let reused = false;
    while (nextSourceOffset < sources.length && nextSourceOffset - position.sourceOffset < this.queryBudget.records) {
      signal?.throwIfAborted();
      const { base, key, scope } = sources[nextSourceOffset]!;
      const cached = validated.get(nextSourceOffset);
      const size = await this.storage.size(base, key).catch(() => undefined);
      if (cached !== undefined && (size !== cached.size || await this.storage.mtime(base, key).catch(() => undefined) !== cached.mtime)) invalidated();
      if (size !== undefined && size <= 64 * 1024 && bytesRead + size > this.queryBudget.bytes && nextSourceOffset > position.sourceOffset) break;
      nextSourceOffset++;
      if (size === undefined || size > 64 * 1024) { skipped++; chunkHash = revision(JSON.stringify([chunkHash, key, size])); continue; }
      try {
        const bytes = cached?.bytes ?? await readBytes(base, key, (count) => { bytesRead += count; });
        if (cached !== undefined) { bytesRead += bytes.byteLength; reused = true; }
        const text = decoder.decode(bytes);
        chunkHash = revision(JSON.stringify([chunkHash, key, revision(text)]));
        const entry = decode(text);
        if (entry.id !== key.slice(key.lastIndexOf('/') + 1, -3)) throw new Error('Memory identity mismatch');
        entries.push({ ...entry, scope });
      } catch { skipped++; }
    }
    if (reused) {
      const currentProof: unknown[] = [];
      for (const check of directoryChecks) currentProof.push(await check());
      if (revision(JSON.stringify(currentProof)) !== namesFingerprint) invalidated();
    }
    if (position.chunkHash !== undefined && position.chunkHash !== chunkHash) invalidated();
    position.chunkHash = chunkHash;
    signal?.throwIfAborted();
    return memoryQueryPage(scopes, parsed, entries, nextSourceOffset, sources.length, skipped, this.cursorSalt, wholeChunk);
  }

  async search(scopes: readonly MemoryScope[], query: string, type?: MemoryType, includeInactive = false): Promise<readonly (MemoryEntry & { score: number; scope: MemoryScope })[]> {
    const lists = await Promise.all(scopes.map((scope) => this.list(scope, includeInactive)));
    const entries = lists.flatMap((list, index) => list.map((entry) => ({ ...entry, scope: scopes[index]! })))
      .filter((entry) => includeInactive || entry.status === 'active');
    return rankMemoryEntries(entries, query, type);
  }

  async listPersonaEntries(personaId: string): Promise<readonly MemoryPersonaEntry[]> {
    assertPersonaId(personaId);
    const scopes = await this.personaScopes(personaId);
    const lists = await Promise.all(scopes.map(async (scope) => (await this.list(scope, true)).map((entry) => ({ ...entry, scope }))));
    return lists.flat().sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
  }

  async deletePersonaNamespaces(personaId: string): Promise<MemoryPersonaDeleteResult> {
    assertPersonaId(personaId);
    let namespaceCount = 0;
    let entryCount = 0;
    for (const scope of await this.personaScopes(personaId)) {
      const base = await this.scopes.resolve(scope);
      const lock = await this.storage.acquireLock(base, 'memory-write', { leaseMs: 30_000 });
      let changed = false;
      try {
        for (const folder of ['entries', 'inbox'] as const) {
          for (const name of await this.storage.list(`${base}/${folder}`)) {
            if (!/^m_[a-zA-Z0-9_]+\.md$/.test(name)) continue;
            const bytes = await this.storage.read(base, `${folder}/${name}`, { recoverMissing: false });
            let beforeStatus: MemoryStatus | undefined;
            try { beforeStatus = bytes === undefined ? undefined : decode(decoder.decode(bytes)).status; }
            catch { beforeStatus = folder === 'inbox' ? 'pending' : 'active'; }
            await this.storage.delete(base, `${folder}/${name}`);
            this.changeEmitter.fire({ scope, id: name.slice(0, -3), operationId: randomUUID(), beforeStatus });
            entryCount++;
            changed = true;
          }
        }
        for (const key of ['MEMORY.md', 'journal.jsonl'] as const) {
          if (await this.storage.size(base, key) === undefined) continue;
          await this.storage.delete(base, key);
          changed = true;
        }
      } finally {
        await lock.release();
      }
      if (changed) namespaceCount++;
    }
    return { namespaceCount, entryCount };
  }

  async importLorebook(
    scope: MemoryScope,
    entries: readonly MemoryLorebookEntry[],
    source: Partial<MemorySource> = {},
  ): Promise<readonly { readonly entry: MemoryEntry; readonly operationId: string }[]> {
    const imported: { readonly entry: MemoryEntry; readonly operationId: string }[] = [];
    for (const [index, entry] of entries.entries()) {
      const saved = await this.put({
        action: 'create', scope, type: 'reference',
        title: (entry.title ?? entry.name ?? `Lorebook entry ${index + 1}`).trim(),
        body: entry.content, reason: 'Imported from Character Card lorebook',
        source: { ...source, writer: 'import' }, pinned: entry.constant === true,
      });
      if (saved.operationId === null) throw new Error('Import did not create a memory operation');
      imported.push({ entry: saved.entry, operationId: saved.operationId });
    }
    return imported;
  }

  private async personaScopes(personaId: string): Promise<readonly MemoryScope[]> {
    const workspaceIds = new Set<string>();
    if (this.scopes.listWorkspaceIds !== undefined) {
      for (const workspaceId of await this.scopes.listWorkspaceIds()) {
        if (MEMORY_WORKSPACE_ID_PATTERN.test(workspaceId)) workspaceIds.add(workspaceId);
      }
    }
    for (const workspaceId of await this.storage.list('memory/workspaces')) {
      if (MEMORY_WORKSPACE_ID_PATTERN.test(workspaceId)) workspaceIds.add(workspaceId);
    }
    return [
      { kind: 'persona', personaId },
      ...[...workspaceIds].sort().map((workspaceId) => ({ kind: 'persona_workspace', workspaceId, personaId } as const)),
    ];
  }

  private async commit(scope: MemoryScope, base: string, key: string, before: { key: string; text: string } | undefined, after: string | undefined, action: string, id: string, writer: MemoryWriter, operationId: string = randomUUID(), beforeWrite?: () => Promise<void>): Promise<string> {
    const safeBefore = before === undefined ? null : redactMemorySecrets(before.text);
    const beforeStatus = before === undefined ? undefined : decode(before.text).status;
    const afterStatus = after === undefined ? undefined : decode(after).status;
    const record: MemoryJournalRecord = { operationId, action, id, writer, at: new Date().toISOString(), before: safeBefore, beforeRevision: before === undefined ? null : revision(before.text), afterRevision: after === undefined ? null : revision(after) };
    await this.storage.append(base, 'journal.jsonl', encoder.encode(`${JSON.stringify(record)}\n`));
    if (beforeWrite !== undefined) await beforeWrite();
    if (after === undefined) await this.storage.delete(base, key);
    else await this.storage.write(base, key, encoder.encode(after), { atomic: true });
    this.changeEmitter.fire({ scope, id, operationId, beforeStatus, afterStatus });
    return operationId;
  }

  private async rebuildCatalog(base: string): Promise<void> {
    const entries: MemoryEntry[] = [];
    for (const name of (await this.storage.list(`${base}/entries`)).toSorted()) {
      if (!/^m_[a-zA-Z0-9_]+\.md$/.test(name)) continue;
      if ((await this.storage.size(base, `entries/${name}`) ?? 0) > 64 * 1024) continue;
      const raw = await this.storage.read(base, `entries/${name}`, { recoverMissing: false });
      if (raw !== undefined) { try { entries.push(decode(decoder.decode(raw))); } catch { continue; } }
    }
    const catalog = entries.filter((entry) => entry.status === 'active').sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated.localeCompare(a.updated))
      .map((entry) => `- [${entry.id}] ${entry.title.replaceAll('\n', ' ')} (${entry.type}${entry.pinned ? ', pinned' : ''})`).join('\n');
    await this.storage.write(base, 'MEMORY.md', encoder.encode(`# Memory\n\n${catalog}\n`), { atomic: true });
  }
}

registerScopedService(LifecycleScope.App, IMemoryStore, MemoryStore, ScopeActivation.OnDemand, 'memory');
