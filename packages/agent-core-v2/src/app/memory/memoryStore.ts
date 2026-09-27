import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { load } from 'js-yaml';
import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IMemoryScopes, type MemoryScope } from './memoryScopes';
import { redactMemorySecrets } from './memorySafety';

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
  readonly revision: string;
}
export interface MemoryMutation {
  readonly action: 'create' | 'update' | 'supersede' | 'archive';
  readonly scope: MemoryScope;
  readonly type: MemoryType;
  readonly title: string;
  readonly body: string;
  readonly reason: string;
  readonly source: MemorySource;
  readonly id?: string;
  readonly expectedRevision?: string;
  readonly pinned?: boolean;
  readonly pending?: boolean;
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
export interface IMemoryStore {
  readonly _serviceBrand: undefined;
  list(scope: MemoryScope, includeInactive?: boolean): Promise<readonly MemoryEntry[]>;
  get(scope: MemoryScope, id: string): Promise<MemoryEntry | undefined>;
  put(input: MemoryMutation): Promise<{ entry: MemoryEntry; operationId: string }>;
  delete(scope: MemoryScope, id: string, expectedRevision: string, writer?: MemoryWriter): Promise<string>;
  journal(scope: MemoryScope, id?: string): Promise<readonly MemoryJournalRecord[]>;
  undo(scope: MemoryScope, operationId: string): Promise<MemoryEntry | undefined>;
  search(scopes: readonly MemoryScope[], query: string, type?: MemoryType, includeInactive?: boolean): Promise<readonly (MemoryEntry & { score: number; scope: MemoryScope })[]>;
}
export const IMemoryStore = createDecorator<IMemoryStore>('memoryStore');

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
    created: String(meta['created'] ?? ''), updated: String(meta['updated'] ?? ''),
    source: source && typeof source === 'object' && ['user', 'agent', 'consolidator', 'import'].includes(source.writer) ? source : { writer: 'import' },
    reason: redactMemorySecrets(String(meta['reason'] ?? '')),
    superseded_by: typeof meta['superseded_by'] === 'string' ? meta['superseded_by'] : undefined,
    supersedes: typeof meta['supersedes'] === 'string' ? meta['supersedes'] : undefined,
    supersedes_revision: typeof meta['supersedes_revision'] === 'string' ? meta['supersedes_revision'] : undefined,
    revision: revision(raw),
  };
}

export class MemoryStore implements IMemoryStore {
  declare readonly _serviceBrand: undefined;
  constructor(
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IMemoryScopes private readonly scopes: IMemoryScopes,
  ) {}

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

  async list(scope: MemoryScope, includeInactive = false): Promise<readonly MemoryEntry[]> {
    const base = await this.scopes.resolve(scope);
    const entries: MemoryEntry[] = [];
    for (const folder of ['entries', 'inbox']) {
      for (const name of (await this.storage.list(`${base}/${folder}`)).slice(0, 1_000)) {
        if (!/^m_[a-zA-Z0-9_]+\.md$/.test(name)) continue;
        if ((await this.storage.size(base, `${folder}/${name}`) ?? 0) > 64 * 1024) continue;
        const bytes = await this.storage.read(base, `${folder}/${name}`, { recoverMissing: false });
        if (bytes === undefined) continue;
        try {
          const entry = decode(decoder.decode(bytes));
          if (entry.id !== name.slice(0, -3)) continue;
          if (includeInactive || entry.status === 'active' || entry.status === 'pending') entries.push(entry);
        } catch {
          continue;
        }
      }
    }
    return entries.sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
  }

  async get(scope: MemoryScope, id: string): Promise<MemoryEntry | undefined> {
    const found = await this.raw(await this.scopes.resolve(scope), id);
    return found === undefined ? undefined : decode(found.text);
  }

  async put(input: MemoryMutation): Promise<{ entry: MemoryEntry; operationId: string }> {
    const base = await this.scopes.resolve(input.scope);
    const lock = await this.storage.acquireLock(base, 'memory-write', { leaseMs: 30_000 });
    try {
      if (!input.reason.trim()) throw new Error('Memory reason is required');
      if (!TYPES.includes(input.type)) throw new Error('Invalid memory type');
      if (!input.title.trim() || input.title.length > 200 || !input.body.trim() || input.body.length > 1_500) throw new Error('Memory title or body length is invalid');
      const title = redactMemorySecrets(input.title.trim());
      const body = redactMemorySecrets(input.body.trim());
      const reason = redactMemorySecrets(input.reason.trim());
      const isCreate = input.action === 'create' || input.action === 'supersede';
      const target = input.id === undefined ? undefined : await this.raw(base, input.id);
      if (isCreate === (target !== undefined) && input.action !== 'supersede') throw new Error(isCreate ? 'Memory already exists' : 'Memory not found');
      if (!isCreate && (input.expectedRevision === undefined || revision(target!.text) !== input.expectedRevision)) throw new Error('Memory revision conflict');
      if (input.action === 'supersede' && (target === undefined || input.expectedRevision === undefined || revision(target.text) !== input.expectedRevision)) throw new Error('Memory revision conflict');
      if (isCreate) {
        const entries = await this.list(input.scope, true);
        if (entries.filter((entry) => entry.status === 'active').length >= 300) throw new Error('Memory scope is full; merge existing entries');
        if (input.action === 'create' && entries.some((entry) => entry.status === 'active' && entry.title.toLowerCase() === title.toLowerCase())) throw new Error('Similar memory already exists; update or supersede it');
      }
      const id = isCreate ? `m_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}_${randomBytes(5).toString('hex')}` : input.id!;
      const now = new Date().toISOString();
      const old = target === undefined ? undefined : decode(target.text);
      const superseded = input.action === 'supersede' ? target : old?.supersedes !== undefined && !input.pending ? await this.raw(base, old.supersedes) : undefined;
      if (old?.supersedes !== undefined && !input.pending && (superseded === undefined || revision(superseded.text) !== old.supersedes_revision)) throw new Error('Memory revision conflict');
      const entry: Omit<MemoryEntry, 'revision'> = {
        id, type: input.type, title, body,
        status: input.pending ? 'pending' : input.action === 'archive' ? 'archived' : 'active',
        pinned: input.pinned ?? (isCreate ? false : old?.pinned) ?? false,
        created: isCreate ? now : old?.created ?? now, updated: now,
        source: input.source, reason,
        supersedes: input.action === 'supersede' && input.pending ? input.id : undefined,
        supersedes_revision: input.action === 'supersede' && input.pending ? input.expectedRevision : undefined,
      };
      const key = entryKey(id, entry.status === 'pending');
      const encoded = encode(entry);
      const op = randomUUID();
      if (superseded !== undefined && !input.pending) {
        const previous = decode(superseded.text);
        const oldEntry = { ...previous, revision: undefined, status: 'superseded' as const, superseded_by: id, updated: now };
        await this.commit(base, superseded.key, superseded, encode(oldEntry), 'supersede_previous', previous.id, input.source.writer, op);
      }
      try {
        await this.commit(base, key, isCreate ? undefined : target, encoded, input.action, id, input.source.writer, op);
      } catch (error) {
        if (superseded !== undefined && !input.pending && (await this.raw(base, id))?.text !== encoded) {
          const current = await this.raw(base, superseded.key.slice(superseded.key.lastIndexOf('/') + 1, -3));
          if (current !== undefined && decode(current.text).superseded_by === id) {
            await this.commit(base, superseded.key, current, superseded.text, 'supersede_rollback', decode(superseded.text).id, input.source.writer);
            await this.rebuildCatalog(base);
          }
        }
        throw error;
      }
      if (!isCreate && target!.key !== key) await this.storage.delete(base, target!.key);
      await this.rebuildCatalog(base);
      return { entry: decode(encode(entry)), operationId: op };
    } finally {
      await lock.release();
    }
  }

  async delete(scope: MemoryScope, id: string, expectedRevision: string, writer: MemoryWriter = 'user'): Promise<string> {
    const base = await this.scopes.resolve(scope);
    const lock = await this.storage.acquireLock(base, 'memory-write', { leaseMs: 30_000 });
    try {
      const target = await this.raw(base, id);
      if (target === undefined || revision(target.text) !== expectedRevision) throw new Error('Memory revision conflict');
      const op = await this.commit(base, target.key, target, undefined, 'delete', id, writer);
      await this.rebuildCatalog(base);
      return op;
    } finally { await lock.release(); }
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

  async undo(scope: MemoryScope, operationId: string): Promise<MemoryEntry | undefined> {
    const base = await this.scopes.resolve(scope);
    const lock = await this.storage.acquireLock(base, 'memory-write', { leaseMs: 30_000 });
    try {
      const events = (await this.journal(scope)).filter((item) => item.operationId === operationId);
      if (events.length === 0) throw new Error('Memory operation not found');
      const targets = await Promise.all(events.map((event) => this.raw(base, event.id)));
      const currentRevisions = targets.map((target) => target === undefined ? null : revision(target.text));
      const hasSupersede = events.some((event) => event.action === 'supersede_previous');
      const changed = events.some((event, index) => currentRevisions[index] === event.afterRevision);
      if (!changed) throw new Error('Memory revision conflict');
      for (const [index, event] of events.entries()) {
        if (currentRevisions[index] === event.afterRevision) continue;
        if (!hasSupersede || currentRevisions[index] !== event.beforeRevision) throw new Error('Memory revision conflict');
      }
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index]!;
        if (currentRevisions[index] === event.beforeRevision) continue;
        const target = targets[index];
        const key = event.before === null ? target?.key ?? entryKey(event.id, false) : entryKey(event.id, decode(event.before).status === 'pending');
        await this.commit(base, key, target, event.before ?? undefined, 'undo', event.id, 'user');
        if (target !== undefined && target.key !== key) await this.storage.delete(base, target.key);
      }
      await this.rebuildCatalog(base);
      const primary = events.find((event) => event.action !== 'supersede_previous') ?? events[0]!;
      return primary.before === null ? undefined : decode(primary.before);
    } finally { await lock.release(); }
  }

  async search(scopes: readonly MemoryScope[], query: string, type?: MemoryType, includeInactive = false): Promise<readonly (MemoryEntry & { score: number; scope: MemoryScope })[]> {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length || terms.length > 10 || query.length > 200) return [];
    const lists = await Promise.all(scopes.map((scope) => this.list(scope, includeInactive)));
    return lists.flatMap((entries, index) => entries.map((entry) => ({ ...entry, scope: scopes[index]! })))
      .filter((entry) => (type === undefined || entry.type === type) && (includeInactive || entry.status === 'active'))
      .filter((entry) => terms.every((term) => entry.title.toLowerCase().includes(term) || entry.body.toLowerCase().includes(term)))
      .map((entry) => ({ ...entry, score: terms.reduce((sum, term) => sum + (entry.title.toLowerCase().includes(term) ? 2 : 0) + (entry.body.toLowerCase().includes(term) ? 1 : 0), 0) }))
      .sort((a, b) => b.score - a.score || b.updated.localeCompare(a.updated)).slice(0, 20);
  }

  private async commit(base: string, key: string, before: { key: string; text: string } | undefined, after: string | undefined, action: string, id: string, writer: MemoryWriter, operationId: string = randomUUID()): Promise<string> {
    const safeBefore = before === undefined ? null : redactMemorySecrets(before.text);
    const record: MemoryJournalRecord = { operationId, action, id, writer, at: new Date().toISOString(), before: safeBefore, beforeRevision: before === undefined ? null : revision(before.text), afterRevision: after === undefined ? null : revision(after) };
    await this.storage.append(base, 'journal.jsonl', encoder.encode(`${JSON.stringify(record)}\n`));
    if (after === undefined) await this.storage.delete(base, key);
    else await this.storage.write(base, key, encoder.encode(after), { atomic: true });
    return operationId;
  }

  private async rebuildCatalog(base: string): Promise<void> {
    const entries: MemoryEntry[] = [];
    for (const name of (await this.storage.list(`${base}/entries`)).slice(0, 1_000)) {
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
