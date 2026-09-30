import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter, Event } from '#/_base/event';
import { createServices } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ILogService } from '#/_base/log/log';
import { IPersonaStore } from '#/app/persona/personaStore';
import { PersonaStore } from '#/app/persona/personaStoreService';
import type { PersonaDefinition } from '@kiki/agent-profiles/personaFile';
import { IMemoryStore } from '#/app/memory/memoryStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { ZipFile } from 'yazl';
import { fromBuffer as yauzlFromBuffer } from 'yauzl';

const AVATAR = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

async function makeCharx(entries: readonly (readonly [string, Uint8Array])[]): Promise<Uint8Array> {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const data = new Promise<Uint8Array>((resolve) => {
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Uint8Array.from(Buffer.concat(chunks))));
  });
  for (const [name, value] of entries) zip.addBuffer(Buffer.from(value), name);
  zip.end();
  return data;
}

async function readCharx(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = await new Promise<import('yauzl').ZipFile>((resolve, reject) => {
    yauzlFromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value!));
  });
  const entries = new Map<string, Uint8Array>();
  await new Promise<void>((resolve, reject) => {
    zip.readEntry();
    zip.on('entry', (entry) => zip.openReadStream(entry, (error, stream) => {
      if (error || stream === undefined) { reject(error ?? new Error('missing stream')); return; }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => { entries.set(entry.fileName, Uint8Array.from(Buffer.concat(chunks))); zip.readEntry(); });
    }));
    zip.on('end', () => resolve());
    zip.on('error', reject);
  });
  return entries;
}

class FaultyPersonaStorage extends InMemoryStorageService {
  injectWriteBetweenLock = false;
  failNextPersonaWrite = false;
  failRollbackOnPrimary = false;
  failRollback = false;

  override async acquireLock(scope: string, key: string, options = {}) {
    const lock = await super.acquireLock(scope, key, options);
    if (scope === 'personas/lin-lan' && key === 'persona-write' && this.injectWriteBetweenLock) {
      this.injectWriteBetweenLock = false;
      await super.write(scope, 'persona.md', new TextEncoder().encode('---\nname: 外部\n---\n外部\n'));
      this.failNextPersonaWrite = true;
    }
    return lock;
  }

  override async write(scope: string, key: string, data: Uint8Array, options = {}) {
    if (scope === 'personas/lin-lan' && key === 'persona.md' && this.failRollback) {
      this.failRollback = false;
      throw new Error('rollback write failed');
    }
    if (scope === 'personas/lin-lan' && key === 'persona.md' && this.failNextPersonaWrite) {
      this.failNextPersonaWrite = false;
      if (this.failRollbackOnPrimary) this.failRollback = true;
      throw new Error('primary write failed');
    }
    return super.write(scope, key, data, options);
  }
}

const definition: PersonaDefinition = {
  id: 'lin-lan',
  name: '林岚',
  title: '发布协调',
  job: '负责发布节奏',
  profile: 'agent',
  modelAlias: 'fast-model',
  delivery: 'message',
  memory: { shared: ['global', 'workspace'] },
  description: '你是林岚。\n\n先给结论。',
};

describe('PersonaStore', () => {
  let disposables: DisposableStore;
  let storage: InMemoryStorageService;
  let store: IPersonaStore;
  let importedLorebook: unknown[];
  let deletedPersonas: string[];
  let memoryFailure: boolean;
  let logErrors: unknown[];
  let externalChange: Emitter<{ readonly path: string; readonly action: 'modified'; readonly kind: 'file' }>;

  beforeEach(() => {
    disposables = new DisposableStore();
    storage = new FaultyPersonaStorage();
    importedLorebook = [];
    deletedPersonas = [];
    memoryFailure = false;
    logErrors = [];
    externalChange = new Emitter();
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IFileSystemStorageService, storage);
        reg.definePartialInstance(IBootstrapService, { homeDir: '/kimi-test-home' });
        reg.definePartialInstance(ILogService, { error: (message: string, payload: unknown) => { logErrors.push({ message, payload }); }, warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => ({}) as never });
        reg.definePartialInstance(IHostFsWatchService, {
          watch: () => ({ ready: Promise.resolve(), onDidChange: externalChange.event, dispose: () => {} }),
        });
        reg.definePartialInstance(IMemoryStore, {
          importLorebook: async (_scope, entries) => {
            importedLorebook.push(...entries);
            return [];
          },
          deletePersonaNamespaces: async (id) => {
            if (memoryFailure) throw new Error('memory unavailable');
            deletedPersonas.push(id);
            return { namespaceCount: 1, entryCount: 2 };
          },
          listPersonaEntries: async (id) => [{
            id: 'm_20260929_abcdef1234',
            type: 'reference',
            title: 'Pinned fact',
            body: 'Remember this.',
            status: 'active',
            pinned: true,
            created: '2026-09-29T00:00:00.000Z',
            updated: '2026-09-29T00:00:00.000Z',
            source: { writer: 'import' },
            reason: 'test',
            revision: 'memory-revision',
            scope: { kind: 'persona', personaId: id },
          }],
        });
        reg.define(IPersonaStore, PersonaStore);
      },
    });
    store = ix.get(IPersonaStore);
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('serializes deletion against edits and honors flat create-only writes', async () => {
    const snapshot = await store.put(definition);
    await expect(store.put({ ...definition, createOnly: true })).rejects.toThrow('already exists');
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    store.setMemoryHooks({ importLorebook: async () => {}, deletePersonaNamespaces: async () => { entered(); await gate; } });
    const deletion = store.delete(definition.id, snapshot.revision);
    await started;
    const edit = store.put({ ...definition, description: 'Concurrent edit', expectedRevision: snapshot.revision });
    const rejected = expect(edit).rejects.toThrow('Storage is locked');
    release();
    expect((await deletion).memory.status).toBe('committed');
    await rejected;
    expect(await store.get(definition.id)).toBeUndefined();
  });

  it('takes the rollback snapshot under the persona lock', async () => {
    const faulty = storage as FaultyPersonaStorage;
    await store.put(definition);
    faulty.injectWriteBetweenLock = true;
    await expect(store.put({ ...definition, name: '更新' })).rejects.toThrow('primary write failed');
    expect((await store.get('lin-lan'))?.definition.name).toBe('外部');
  });

  it('reports rollback failure with the original error and logs inconsistency', async () => {
    const faulty = storage as FaultyPersonaStorage;
    await store.put(definition);
    faulty.failNextPersonaWrite = true;
    faulty.failRollbackOnPrimary = true;
    let error: Error | undefined;
    try {
      await store.put({ ...definition, name: '更新' });
    } catch (value) {
      if (value instanceof Error) error = value;
    }
    expect(error).toBeDefined();
    expect(error!.message).toContain('rollback also failed');
    expect(error!.cause).toBeInstanceOf(Error);
  });

  it('cleans partially imported memory and reports cleanup failure', async () => {
    store.setMemoryHooks({
      importLorebook: async () => { throw new Error('import failed'); },
      deletePersonaNamespaces: async () => { throw new Error('cleanup failed'); },
    });
    const card = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: {
      name: 'Cleanup Bot', description: 'Memory', character_book: { entries: [{ comment: 'fact', content: 'value', constant: true }] },
    } });
    let error: Error | undefined;
    try {
      await store.importCard({ data: card, format: 'json' }, { id: 'cleanup-bot' });
    } catch (value) {
      if (value instanceof Error) error = value;
    }
    expect(error?.message).toContain('memory cleanup failed');
    expect(error?.cause).toBeInstanceOf(Error);
    expect(logErrors).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('memory cleanup failed') })]));
  });

  it('stores revisions over persona.md and examples and separates state', async () => {
    const created = await store.put({ ...definition, examples: 'user: hi\nchar: hello' });
    expect(created.definition).toEqual(definition);
    expect(created.examples).toContain('hello');
    expect(created.revision).toHaveLength(64);
    expect(await store.get('lin-lan')).toEqual(created);
    expect(await store.list()).toEqual([
      expect.objectContaining({ id: 'lin-lan', name: '林岚', archived: false, revision: created.revision }),
    ]);

    await store.archive('lin-lan');
    expect(await store.list()).toEqual([]);
    expect(await store.list({ includeArchived: true })).toEqual([
      expect.objectContaining({ id: 'lin-lan', archived: true }),
    ]);
    expect(await store.get('lin-lan')).toEqual(created);
  });

  it('emits a catalog change after an external persona file edit', async () => {
    await store.put(definition);
    let changes = 0;
    disposables.add(store.onDidChange(() => { changes++; }));
    const raw = await storage.read('personas/lin-lan', 'persona.md');
    if (raw === undefined) throw new Error('persona file was not written');
    await storage.write('personas/lin-lan', 'persona.md', new TextEncoder().encode(new TextDecoder().decode(raw).replace('林岚', '外部林岚')), { atomic: true });
    externalChange.fire({ path: '/kimi-test-home/personas/lin-lan/persona.md', action: 'modified', kind: 'file' });
    await vi.waitFor(() => expect(changes).toBe(1), { timeout: 1_000 });
    expect((await store.get('lin-lan'))?.definition.name).toBe('外部林岚');
  });

  it('updates state without changing the frozen revision and preserves unknown fields', async () => {
    const created = await store.put(definition);
    const initialState = await store.getState('lin-lan');
    expect(initialState).toEqual({ version: 1, archived: false });
    const updated = await store.updateState('lin-lan', {
      homeSessionId: 'session-1',
      pinned: true,
      runtimeExtension: { owner: 'bot' },
    });
    expect(updated).toMatchObject({ version: 1, archived: false, homeSessionId: 'session-1', pinned: true });
    await store.archive('lin-lan');
    expect(await store.getState('lin-lan')).toMatchObject({
      archived: true,
      homeSessionId: 'session-1',
      pinned: true,
      runtimeExtension: { owner: 'bot' },
    });
    expect((await store.get('lin-lan'))?.revision).toBe(created.revision);
  });

  it('does not remove persona assets when memory deletion fails, allowing retry', async () => {
    await store.put(definition);
    memoryFailure = true;
    await expect(store.delete('lin-lan')).resolves.toEqual({ memory: { status: 'failed', error: 'memory unavailable' } });
    expect(await store.get('lin-lan')).toBeDefined();
    memoryFailure = false;
    await expect(store.delete('lin-lan')).resolves.toEqual({ memory: { status: 'committed' } });
    expect(await store.get('lin-lan')).toBeUndefined();
  });

  it('duplicates assets without copying state or memory', async () => {
    await store.put({ ...definition, examples: 'example' });
    await store.updateState('lin-lan', { homeSessionId: 'session-1', pinned: true });
    await store.putAvatar('lin-lan', AVATAR);
    const duplicate = await store.duplicate('lin-lan', { id: 'lin-lan-copy' });
    expect(duplicate.definition.id).toBe('lin-lan-copy');
    expect(duplicate.definition.name).toBe('林岚 副本');
    expect(duplicate.examples).toBe('example');
    expect((await store.getAvatar('lin-lan-copy'))?.mimeType).toBe('image/png');
    expect(await store.getState('lin-lan-copy')).toEqual({ version: 1, archived: false });
    expect(await store.list({ includeArchived: true })).toHaveLength(2);
    expect(importedLorebook).toEqual([]);
  });

  it('imports PNG identity, avatar, greeting and lorebook, then round-trips multiline body and extensions', async () => {
    const extensions = { vendor: { list: [true, null, 'unchanged'], nested: { mode: 'original' } } };
    const card = { spec: 'chara_card_v3', spec_version: '3.0', data: {
      name: 'Guide', nickname: 'Navigator', description: 'First line.\nSecond line.\n\n## Details\nKeep this too.',
      personality: 'Patient.\nPrecise.', scenario: 'At a desk.\nNear a window.',
      system_prompt: 'Play the guide.\nNever erase the capability rules.', first_mes: 'Where shall we begin?',
      mes_example: '{{char}}: Hello {{user}}.', post_history_instructions: 'Do not inject this.',
      extensions, character_book: { entries: [{ comment: 'Pinned fact', content: 'Remember this.', constant: true }] },
    } };
    const first = await store.importCard({ data: JSON.stringify(card), format: 'json' }, { id: 'guide' });
    await store.putAvatar('guide', AVATAR);
    const png = await store.exportCard('guide', 'png', { includeMemory: true });
    const preview = await store.previewImport({ data: png.data, format: 'png' });
    expect(preview.definition.name).toBe('Navigator');
    expect(preview.definition.description).toBe(first.snapshot.definition.description);
    expect(preview.definition.description).toContain('## Details\nKeep this too.');
    expect(preview.definition.greeting).toBe('Where shall we begin?');
    expect(preview.examples).toBe('Navigator: Hello user.');
    expect(preview.avatarMimeType).toBe('image/png');
    expect(preview.avatar?.data).toBeTypeOf('string');
    expect(preview.memoryEntries).toEqual([{ title: 'Pinned fact', body: 'Remember this.', pinned: true, type: 'reference' }]);
    expect(preview.extensions).toEqual(extensions);
    const imported = await store.importCard({ data: png.data, format: 'png' }, { id: 'guide-again' });
    expect(imported.memory).toEqual({ status: 'committed', count: 1 });
    expect(importedLorebook).toHaveLength(2);
    const second = await store.exportCard('guide-again', 'png', { includeMemory: true });
    const roundtrip = await store.previewImport({ data: second.data, format: 'png' });
    expect(roundtrip.definition).toEqual(preview.definition);
    expect(roundtrip.examples).toEqual(preview.examples);
    expect(roundtrip.extensions).toEqual(extensions);
    expect(roundtrip.memoryEntries).toEqual(preview.memoryEntries);
  });

  it('round-trips a CHARX archive with its avatar extension', async () => {
    await store.put(definition);
    await store.putAvatar('lin-lan', AVATAR);
    const exported = await store.exportCard('lin-lan', 'charx');
    expect(exported.extension).toBe('.charx');
    const preview = await store.previewImport({ data: exported.data, format: 'charx' });
    expect(preview.definition.name).toBe('林岚');
    expect(preview.avatarMimeType).toBe('image/png');
  });

  it('retains non-avatar CHARX binary assets across import and export', async () => {
    const card = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: {
      name: 'Asset Bot', description: 'Keeps assets', assets: [{ type: 'icon', uri: 'assets/avatar.png' }],
    } });
    const archive = await makeCharx([
      ['card.json', Buffer.from(card)],
      ['assets/avatar.png', Buffer.from(AVATAR)],
      ['assets/reference.bin', Buffer.from([0, 1, 2, 255])],
    ]);
    await store.importCard({ data: archive, format: 'charx' }, { id: 'asset-bot' });
    const exported = await store.exportCard('asset-bot', 'charx');
    const entries = await readCharx(exported.data);
    expect([...entries.get('assets/reference.bin') ?? []]).toEqual([0, 1, 2, 255]);
  });

  it('exports active persona memory only when requested', async () => {
    await store.put(definition);
    const exported = await store.exportCard('lin-lan', 'json', { includeMemory: true });
    expect(exported.memoryScopes).toEqual(['persona']);
    const preview = await store.previewImport({ data: exported.data, format: 'json' });
    expect(preview.memoryEntries).toEqual([
      expect.objectContaining({ title: 'Pinned fact', body: 'Remember this.', pinned: true }),
    ]);
  });

  it('imports lorebook entries and deletes persona memory on delete', async () => {
    const card = JSON.stringify({
      spec: 'chara_card_v3',
      data: {
        name: 'Memory Bot',
        description: 'A bot',
        character_book: {
          entries: [
            { comment: 'Pinned', content: 'Always remember this', constant: true },
            { comment: 'Reference', content: 'A fact', constant: false },
          ],
        },
      },
    });
    const result = await store.importCard({ data: card, format: 'json' });
    expect(result.memory).toEqual({ status: 'committed', count: 2 });
    expect(importedLorebook).toEqual([
      expect.objectContaining({ title: 'Pinned', content: 'Always remember this', constant: true }),
      expect.objectContaining({ title: 'Reference', content: 'A fact', constant: false }),
    ]);
    const snapshot = await store.get(result.snapshot.definition.id);
    const deleted = await store.delete(result.snapshot.definition.id, snapshot?.revision);
    expect(deleted.memory).toEqual({ status: 'committed' });
    expect(deletedPersonas).toEqual([result.snapshot.definition.id]);
  });
});
