import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { load } from 'js-yaml';
import { tokenize } from '@kiki/minidb';
import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IMemoryScopes, MEMORY_PERSONA_ID_PATTERN, MEMORY_WORKSPACE_ID_PATTERN, type MemoryScope } from './memoryScopes';
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
  readonly pending_action?: 'update' | 'archive';
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
export interface IMemoryStore {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<MemoryStoreChange>;
  list(scope: MemoryScope, includeInactive?: boolean): Promise<readonly MemoryEntry[]>;
  get(scope: MemoryScope, id: string): Promise<MemoryEntry | undefined>;
  put(input: MemoryMutation): Promise<{ entry: MemoryEntry; operationId: string }>;
  delete(scope: MemoryScope, id: string, expectedRevision: string, writer?: MemoryWriter): Promise<string>;
  journal(scope: MemoryScope, id?: string): Promise<readonly MemoryJournalRecord[]>;
  undo(scope: MemoryScope, operationId: string): Promise<MemoryEntry | undefined>;
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
    pending_action: meta['pending_action'] === 'update' || meta['pending_action'] === 'archive' ? meta['pending_action'] : undefined,
    revision: revision(raw),
  };
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

  private async serializedWrite<T>(base: string, action: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(base) ?? Promise.resolve();
    let done!: () => void;
    const current = new Promise<void>((resolve) => { done = resolve; });
    this.writeQueues.set(base, current);
    await previous;
    try {
      const lock = await this.storage.acquireLock(base, 'memory-write', {
        leaseMs: 30_000, waitForMs: 5_000, owner: { kind: 'memory-write', scope: base, pid: process.pid },
      });
      try {
        return await action();
      } finally {
        await lock.release();
        await this.rebuildCatalog(base);
      }
    } finally {
      done();
      if (this.writeQueues.get(base) === current) this.writeQueues.delete(base);
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

  async list(scope: MemoryScope, includeInactive = false): Promise<readonly MemoryEntry[]> {
    const base = await this.scopes.resolve(scope);
    const entries: MemoryEntry[] = [];
    for (const folder of ['entries', 'inbox'] as const) {
      for (const name of (await this.storage.list(`${base}/${folder}`)).slice(0, 1_000)) {
        if (!/^m_[a-zA-Z0-9_]+\.md$/.test(name)) continue;
        if ((await this.storage.size(base, `${folder}/${name}`) ?? 0) > 64 * 1024) continue;
        const key = `${folder}/${name}`;
        let bytes = await this.storage.read(base, key, { recoverMissing: false });
        if (bytes === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          bytes = await this.storage.read(base, key, { recoverMissing: false });
        }
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
    const scope = input.scope;
    const base = await this.scopes.resolve(scope);
    return this.serializedWrite(base, async () => {
      let target = input.id === undefined ? undefined : await this.raw(base, input.id);
      const candidate = target === undefined ? undefined : decode(target.text);
      let accepted: typeof target;
      if (candidate?.status === 'pending' && candidate.pending_action !== undefined && !input.pending) {
        if (input.action !== 'update' || candidate.revision !== input.expectedRevision || candidate.supersedes === undefined || candidate.supersedes_revision === undefined) throw new Error('Memory revision conflict');
        accepted = target;
        input = { ...input, action: candidate.pending_action, id: candidate.supersedes, expectedRevision: candidate.supersedes_revision };
        target = await this.raw(base, input.id!);
      }
      if (!input.reason.trim()) throw new Error('Memory reason is required');
      if (!TYPES.includes(input.type)) throw new Error('Invalid memory type');
      if (!input.title.trim() || input.title.length > 200 || !input.body.trim() || input.body.length > 1_500) throw new Error('Memory title or body length is invalid');
      const title = redactMemorySecrets(input.title.trim());
      const body = redactMemorySecrets(input.body.trim());
      const reason = redactMemorySecrets(input.reason.trim());
      const isCreate = input.action === 'create' || input.action === 'supersede';
      const isProposal = input.pending === true && candidate?.status !== 'pending' && (input.action === 'update' || input.action === 'archive');
      if (isCreate === (target !== undefined) && input.action !== 'supersede') throw new Error(isCreate ? 'Memory already exists' : 'Memory not found');
      if (!isCreate && (input.expectedRevision === undefined || revision(target!.text) !== input.expectedRevision)) throw new Error('Memory revision conflict');
      if (input.action === 'supersede' && (target === undefined || input.expectedRevision === undefined || revision(target.text) !== input.expectedRevision)) throw new Error('Memory revision conflict');
      if (isCreate) {
        const entries = await this.list(input.scope, true);
        if (entries.filter((entry) => entry.status === 'active').length >= 300) throw new Error('Memory scope is full; merge existing entries');
        if (input.action === 'create' && entries.some((entry) => entry.status === 'active' && entry.title.toLowerCase() === title.toLowerCase())) throw new Error('Similar memory already exists; update or supersede it');
      }
      const id = isCreate || isProposal ? `m_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}_${randomBytes(5).toString('hex')}` : input.id!;
      const now = new Date().toISOString();
      const old = target === undefined ? undefined : decode(target.text);
      const superseded = input.action === 'supersede' ? target : old?.supersedes !== undefined && !input.pending ? await this.raw(base, old.supersedes) : undefined;
      if (old?.supersedes !== undefined && !input.pending && (superseded === undefined || revision(superseded.text) !== old.supersedes_revision)) throw new Error('Memory revision conflict');
      const entry: Omit<MemoryEntry, 'revision'> = {
        id, type: input.type, title, body,
        status: input.pending ? 'pending' : input.action === 'archive' ? 'archived' : 'active',
        pinned: input.pinned ?? (isCreate ? false : old?.pinned) ?? false,
        created: isCreate || isProposal ? now : old?.created ?? now, updated: now,
        source: input.source, reason,
        supersedes: input.pending ? input.action === 'supersede' || isProposal ? input.id : old?.supersedes : undefined,
        supersedes_revision: input.pending ? input.action === 'supersede' || isProposal ? input.expectedRevision : old?.supersedes_revision : undefined,
        pending_action: isProposal ? input.action as 'update' | 'archive' : input.pending ? old?.pending_action : undefined,
      };
      const key = entryKey(id, entry.status === 'pending');
      const encoded = encode(entry);
      const op = randomUUID();
      if (superseded !== undefined && !input.pending) {
        const previous = decode(superseded.text);
        const oldEntry = { ...previous, revision: undefined, status: 'superseded' as const, superseded_by: id, updated: now };
        await this.commit(scope, base, superseded.key, superseded, encode(oldEntry), 'supersede_previous', previous.id, input.source.writer, op);
      }
      try {
        await this.commit(scope, base, key, isCreate || isProposal ? undefined : target, encoded, input.action, id, input.source.writer, op);
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
      return { entry: decode(encode(entry)), operationId: op };
    });
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

  async undo(scope: MemoryScope, operationId: string): Promise<MemoryEntry | undefined> {
    const base = await this.scopes.resolve(scope);
    return this.serializedWrite(base, async () => {
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
        await this.commit(scope, base, key, target, event.before ?? undefined, 'undo', event.id, 'user');
        if (target !== undefined && target.key !== key) await this.storage.delete(base, target.key);
      }
      const primary = events.find((event) => event.action !== 'supersede_previous') ?? events[0]!;
      return primary.before === null ? undefined : decode(primary.before);
    });
  }

  async search(scopes: readonly MemoryScope[], query: string, type?: MemoryType, includeInactive = false): Promise<readonly (MemoryEntry & { score: number; scope: MemoryScope })[]> {
    const normalized = query.toLowerCase().trim();
    if (!normalized || query.length > 200 || normalized.split(/\s+/).length > 10) return [];
    const terms = [...new Set(tokenize(normalized))];
    const lists = await Promise.all(scopes.map((scope) => this.list(scope, includeInactive)));
    const entries = lists.flatMap((list, index) => list.map((entry) => ({ ...entry, scope: scopes[index]! })))
      .filter((entry) => (type === undefined || entry.type === type) && (includeInactive || entry.status === 'active'));
    const hits = entries.map((entry) => {
      const title = entry.title.toLowerCase();
      const body = entry.body.toLowerCase();
      const matched = terms.filter((term) => title.includes(term) || body.includes(term));
      const titleHits = matched.filter((term) => title.includes(term)).length;
      return { ...entry, score: matched.length + titleHits / (terms.length + 1) };
    }).filter((entry) => entry.score > 0);
    const result = hits.length > 0 ? hits : entries.filter((entry) => entry.title.toLowerCase().includes(normalized))
      .map((entry) => ({ ...entry, score: 1 }));
    return result.toSorted((a, b) => b.score - a.score || b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id)).slice(0, 20);
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
      imported.push(await this.put({
        action: 'create',
        scope,
        type: 'reference',
        title: (entry.title ?? entry.name ?? `Lorebook entry ${index + 1}`).trim(),
        body: entry.content,
        reason: 'Imported from Character Card lorebook',
        source: { ...source, writer: 'import' },
        pinned: entry.constant === true,
      }));
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

  private async commit(scope: MemoryScope, base: string, key: string, before: { key: string; text: string } | undefined, after: string | undefined, action: string, id: string, writer: MemoryWriter, operationId: string = randomUUID()): Promise<string> {
    const safeBefore = before === undefined ? null : redactMemorySecrets(before.text);
    const beforeStatus = before === undefined ? undefined : decode(before.text).status;
    const afterStatus = after === undefined ? undefined : decode(after).status;
    const record: MemoryJournalRecord = { operationId, action, id, writer, at: new Date().toISOString(), before: safeBefore, beforeRevision: before === undefined ? null : revision(before.text), afterRevision: after === undefined ? null : revision(after) };
    await this.storage.append(base, 'journal.jsonl', encoder.encode(`${JSON.stringify(record)}\n`));
    if (after === undefined) await this.storage.delete(base, key);
    else await this.storage.write(base, key, encoder.encode(after), { atomic: true });
    this.changeEmitter.fire({ scope, id, operationId, beforeStatus, afterStatus });
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
