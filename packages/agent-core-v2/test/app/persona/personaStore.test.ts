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
  failNextAvatarMetadataDelete = false;

  override async delete(scope: string, key: string) {
    if (scope === 'personas/lin-lan' && key === 'avatar.json' && this.failNextAvatarMetadataDelete) {
      this.failNextAvatarMetadataDelete = false;
      throw new Error('avatar metadata delete failed');
    }
    return super.delete(scope, key);
  }

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

  afterEach(async () => {
    await disposables.dispose();
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

  it('rejects oversized serialized writes before changing assets or memory', async () => {
    const original = await store.put({ ...definition, examples: 'original', extensions: { kept: true } });
    const write = vi.spyOn(storage, 'write');
    const remove = vi.spyOn(storage, 'delete');
    for (const patch of [
      { description: '界'.repeat(350_000) },
      { examples: '界'.repeat(90_000) },
      { extensions: { text: '界'.repeat(90_000) } },
    ]) {
      await expect(store.put({ ...definition, ...patch, expectedRevision: original.revision })).rejects.toThrow('size limit');
      expect(write).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(await store.get(definition.id)).toEqual(original);
      expect(await store.list()).toEqual([expect.objectContaining({ id: definition.id, revision: original.revision })]);
      expect((await store.exportCard(definition.id, 'json')).data.byteLength).toBeGreaterThan(0);
    }
    expect(importedLorebook).toEqual([]);
    expect(deletedPersonas).toEqual([]);
  });

  it('accepts the exact UTF-8 file boundary and keeps successful writes readable and exportable', async () => {
    const first = await store.put({ ...definition, description: 'x' });
    const overhead = (await storage.size('personas/lin-lan', 'persona.md'))! - 1;
    const snapshot = await store.put({ ...definition, description: 'x'.repeat(1024 * 1024 - overhead), examples: 'x'.repeat(256 * 1024) });
    expect(await storage.size('personas/lin-lan', 'persona.md')).toBe(1024 * 1024);
    expect(await store.get(definition.id)).toEqual(snapshot);
    expect((await store.list())[0]?.revision).toBe(snapshot.revision);
    expect((await store.exportCard(definition.id, 'json')).data.byteLength).toBeGreaterThan(0);
    await expect(store.put({ ...definition, description: `${snapshot.definition.description}x`, expectedRevision: snapshot.revision })).rejects.toThrow('size limit');
    expect((await store.get(definition.id))?.revision).not.toBe(first.revision);
  });

  it('rejects oversized imported persona, examples and extensions before asset or memory writes', async () => {
    const write = vi.spyOn(storage, 'write');
    const remove = vi.spyOn(storage, 'delete');
    for (const patch of [
      { description: 'x'.repeat(1024 * 1024) },
      { mes_example: 'x'.repeat(256 * 1024 + 1) },
      { extensions: { text: 'x'.repeat(256 * 1024) } },
    ]) {
      const card = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: {
        name: 'Guide', description: 'guide', ...patch,
        character_book: { entries: [{ comment: 'fact', content: 'value', constant: true }] },
      } });
      await expect(store.importCard({ data: card, format: 'json' }, { id: 'guide' })).rejects.toThrow('size limit');
      expect(write).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(await store.get('guide')).toBeUndefined();
    }
    expect(importedLorebook).toEqual([]);
    expect(deletedPersonas).toEqual([]);
  });

  it('repairs invalid or oversized definitions without parsing the old asset', async () => {
    await store.put(definition);
    await store.updateState(definition.id, { homeSessionId: 'owned-session' });
    for (const raw of ['invalid frontmatter', 'x'.repeat(1024 * 1024 + 1)]) {
      await storage.write('personas/lin-lan', 'persona.md', new TextEncoder().encode(raw));
      await expect(store.get(definition.id)).rejects.toThrow();
      const restored = await store.put({ ...definition, description: 'Recovered' });
      expect(await store.get(definition.id)).toEqual(restored);
      expect((await store.getState(definition.id)).homeSessionId).toBe('owned-session');
    }
    expect(deletedPersonas).toEqual([]);
  });

  it('deletes broken assets only after persona lifecycle and memory cleanup succeed', async () => {
    await store.put(definition);
    const order: string[] = [];
    store.setLifecycleHooks({ beforeArchive: async () => ({}), beforeDelete: async (id) => { order.push(`lifecycle:${id}`); } });
    store.setMemoryHooks({ importLorebook: async () => {}, deletePersonaNamespaces: async (id) => {
      order.push(`memory:${id}`);
      if (memoryFailure) throw new Error('memory unavailable');
      expect(await storage.size('personas/lin-lan', 'persona.md')).toBe(1024 * 1024 + 1);
      deletedPersonas.push(id);
    } });
    await storage.write('personas/lin-lan', 'persona.md', new TextEncoder().encode('x'.repeat(1024 * 1024 + 1)));
    memoryFailure = true;
    expect((await store.delete(definition.id)).memory.status).toBe('failed');
    expect(await storage.size('personas/lin-lan', 'persona.md')).toBe(1024 * 1024 + 1);
    memoryFailure = false;
    expect((await store.delete(definition.id)).memory.status).toBe('committed');
    expect(order).toEqual(['lifecycle:lin-lan', 'memory:lin-lan', 'lifecycle:lin-lan', 'memory:lin-lan']);
    expect(deletedPersonas).toEqual(['lin-lan']);
    expect(await storage.list('personas/lin-lan')).toEqual([]);
    expect(await store.list()).toEqual([]);
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
    expect(initialState).toEqual({ version: 1, archived: false, pinned: false, hidden: false });
    expect(await storage.size('personas/lin-lan', 'state.json')).toBeUndefined();
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

  it('stores avatar shape separately and removes only avatar files idempotently', async () => {
    const snapshot = await store.put({ ...definition, examples: 'example' });
    const state = await store.updateState('lin-lan', { pinned: true });
    let changes = 0;
    disposables.add(store.onDidChange(() => { changes++; }));
    const avatar = await store.putAvatar('lin-lan', { data: AVATAR, shape: 'circle' });
    expect(avatar).toMatchObject({ width: 1, height: 1, shape: 'circle' });
    expect(await store.getAvatar('lin-lan')).toEqual(avatar);
    expect((await store.list())[0]?.avatarShape).toBe('circle');
    expect(await store.deleteAvatar('lin-lan')).toBe(true);
    expect(await store.deleteAvatar('lin-lan')).toBe(false);
    expect(await store.getAvatar('lin-lan')).toBeUndefined();
    expect((await store.list())[0]?.avatarShape).toBeUndefined();
    expect(await storage.read('personas/lin-lan', 'avatar.json')).toBeUndefined();
    expect(await store.get('lin-lan')).toEqual(snapshot);
    expect(await store.getState('lin-lan')).toEqual(state);
    expect(deletedPersonas).toEqual([]);
    expect(changes).toBe(2);
  });

  it('rejects oversized and invalid avatars without replacing the saved image or shape', async () => {
    await store.put(definition);
    const original = await store.putAvatar('lin-lan', { data: AVATAR, shape: 'circle' });
    await expect(store.putAvatar('lin-lan', new Uint8Array(2 * 1024 * 1024 + 1))).rejects.toThrow('2 MiB');
    await expect(store.putAvatar('lin-lan', Uint8Array.of(1, 2, 3))).rejects.toThrow('not a PNG');
    await expect(store.putAvatar('lin-lan', { data: AVATAR, mimeType: 'image/jpeg' })).rejects.toThrow('MIME type');
    expect(await store.getAvatar('lin-lan')).toEqual(original);
    await store.putAvatar('lin-lan', AVATAR);
    expect((await store.getAvatar('lin-lan'))?.shape).toBeUndefined();
    expect(await storage.read('personas/lin-lan', 'avatar.json')).toBeUndefined();
    await expect(store.putAvatar('missing', AVATAR)).rejects.toThrow('Persona not found');
    await expect(store.deleteAvatar('missing')).rejects.toThrow('Persona not found');
  });

  it('restores the avatar and shape when deletion partially fails', async () => {
    await store.put(definition);
    const original = await store.putAvatar('lin-lan', { data: AVATAR, shape: 'circle' });
    (storage as FaultyPersonaStorage).failNextAvatarMetadataDelete = true;
    await expect(store.deleteAvatar('lin-lan')).rejects.toThrow('avatar metadata delete failed');
    expect(await store.getAvatar('lin-lan')).toEqual(original);
    expect(await store.deleteAvatar('lin-lan')).toBe(true);
  });

  it('duplicates assets without copying state or memory', async () => {
    await store.put({ ...definition, examples: 'example' });
    await store.updateState('lin-lan', { homeSessionId: 'session-1', pinned: true });
    await store.putAvatar('lin-lan', { data: AVATAR, shape: 'circle' });
    const duplicate = await store.duplicate('lin-lan', { id: 'lin-lan-copy' });
    expect(duplicate.definition.id).toBe('lin-lan-copy');
    expect(duplicate.definition.name).toBe('林岚 副本');
    expect(duplicate.examples).toBe('example');
    expect(await store.getAvatar('lin-lan-copy')).toMatchObject({ mimeType: 'image/png', shape: 'circle' });
    expect(await store.getState('lin-lan-copy')).toEqual({ version: 1, archived: false, pinned: false, hidden: false });
    expect(await storage.size('personas/lin-lan-copy', 'state.json')).toBeUndefined();
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
