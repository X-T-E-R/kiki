import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { FileErrors, IFileService } from '#/app/file/fileService';
import { FileServiceImpl } from '#/app/file/fileServiceImpl';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { BlobStoreService } from '#/persistence/backends/node-fs/blobStoreService';

function readable(data: string | Buffer): Readable {
  return Readable.from([typeof data === 'string' ? Buffer.from(data) : data]);
}

const textEncoder = new TextEncoder();

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

describe('FileServiceImpl', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let backend: InMemoryStorageService;

  beforeEach(() => {
    disposables = new DisposableStore();
    backend = new InMemoryStorageService();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IFileSystemStorageService, backend);
        reg.define(IBlobStore, BlobStoreService);
        reg.define(IFileService, FileServiceImpl);
      },
    });
  });

  afterEach(() => disposables.dispose());

  function store(): IFileService {
    return ix.get(IFileService);
  }

  it('saves a file and reads its bytes back', async () => {
    const meta = await store().save(readable('hello world'), 'hello.txt', {
      mimeType: 'text/plain',
    });

    expect(meta.name).toBe('hello.txt');
    expect(meta.media_type).toBe('text/plain');
    expect(meta.size).toBe(Buffer.byteLength('hello world'));
    expect(meta.id.startsWith('f_')).toBe(true);

    const { meta: got, stream } = await store().get(meta.id);
    expect(got).toEqual(meta);
    expect((await readAll(stream())).toString()).toBe('hello world');
  });

  it('honors the name override and records expires_at', async () => {
    const meta = await store().save(readable('data'), 'original.bin', {
      name: 'renamed.bin',
      mimeType: 'application/octet-stream',
      expiresInSec: 60,
    });

    expect(meta.name).toBe('renamed.bin');
    expect(meta.expires_at).toBeDefined();
    expect(Date.parse(meta.expires_at!)).toBeGreaterThan(Date.parse(meta.created_at));
  });

  it('removes an expired staging upload on access', async () => {
    const meta = await store().save(readable('temporary'), 'temporary.bin', {
      expiresInSec: -1,
    });

    await expect(store().get(meta.id)).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
    await vi.waitFor(async () => {
      expect(await backend.list('files')).not.toContain(meta.id);
    });
  });

  it('prunes expired uploads while loading a persisted index', async () => {
    const expired = await store().save(readable('old'), 'old.bin', { expiresInSec: 60 });
    const fresh = await store().save(readable('new'), 'new.bin');
    const rawIndex = await backend.read('file', 'index.json');
    const index = JSON.parse(new TextDecoder().decode(rawIndex)) as {
      files: Array<{ id: string; expires_at?: string }>;
    };
    index.files.find((file) => file.id === expired.id)!.expires_at = new Date(0).toISOString();
    await backend.write('file', 'index.json', textEncoder.encode(JSON.stringify(index)));

    const ix2 = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IFileSystemStorageService, backend);
        reg.define(IBlobStore, BlobStoreService);
        reg.define(IFileService, FileServiceImpl);
      },
    });
    const reloaded = ix2.get(IFileService);

    await expect(reloaded.get(expired.id)).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
    await expect(reloaded.get(fresh.id)).resolves.toMatchObject({ meta: { id: fresh.id } });
    await vi.waitFor(async () => {
      expect(await backend.list('files')).not.toContain(expired.id);
    });
  });

  it('does not await unrelated expired blob deletes during a valid get', async () => {
    const valid = await store().save(readable('valid'), 'valid.txt');
    const rawIndex = await backend.read('file', 'index.json');
    const index = JSON.parse(new TextDecoder().decode(rawIndex)) as { files: Array<Record<string, unknown>> };
    const expiredAt = new Date(0).toISOString();
    const blockedId = 'f_blocked';
    const unrelated = Array.from({ length: 1_000 }, (_, index) => `f_expired_${index}`);
    const expired = [blockedId, ...unrelated].map((id) => ({
      id,
      name: `${id}.txt`,
      media_type: 'text/plain',
      size: 1,
      created_at: expiredAt,
      expires_at: expiredAt,
    }));
    await Promise.all(expired.map((meta) => backend.write('files', meta.id, Buffer.from('x'))));
    index.files.push(...expired);
    await backend.write('file', 'index.json', textEncoder.encode(JSON.stringify(index)));

    const ix2 = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IFileSystemStorageService, backend);
        reg.define(IBlobStore, BlobStoreService);
        reg.define(IFileService, FileServiceImpl);
      },
    });
    const reloaded = ix2.get(IFileService);
    let release = (): void => {};
    let startedResolve = (): void => {};
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalDelete = BlobStoreService.prototype.delete;
    const deleteSpy = vi.spyOn(BlobStoreService.prototype, 'delete').mockImplementation(async function (this: BlobStoreService, scope, key) {
      if (scope === 'files' && key === blockedId) {
        startedResolve();
        await gate;
      }
      return originalDelete.call(this, scope, key);
    });
    try {
      await expect(reloaded.get(blockedId)).rejects.toMatchObject({ code: FileErrors.codes.FILE_NOT_FOUND });
      await started;
      await expect(reloaded.get(valid.id)).resolves.toMatchObject({ meta: { id: valid.id } });
      release();
      await vi.waitFor(async () => {
        expect(await backend.list('files')).not.toContain(unrelated.at(-1));
      }, { timeout: 5_000 });
    } finally {
      release();
      deleteSpy.mockRestore();
    }
  });

  it('retains expired metadata after a failed delete and retries it', async () => {
    const meta = await store().save(readable('temporary'), 'temporary.bin', { expiresInSec: -1 });
    const originalDelete = BlobStoreService.prototype.delete;
    let attempts = 0;
    let fail = true;
    const deleteSpy = vi.spyOn(BlobStoreService.prototype, 'delete').mockImplementation(async function (this: BlobStoreService, scope, key) {
      if (scope === 'files' && key === meta.id) {
        attempts += 1;
        if (fail) throw new Error('delete gated');
      }
      return originalDelete.call(this, scope, key);
    });
    try {
      await expect(store().get(meta.id)).rejects.toMatchObject({ code: FileErrors.codes.FILE_NOT_FOUND });
      await vi.waitFor(() => {
        expect(attempts).toBeGreaterThan(0);
      });
      expect(await backend.list('files')).toContain(meta.id);
      const persisted = JSON.parse(new TextDecoder().decode(await backend.read('file', 'index.json'))) as { files: Array<{ id: string }> };
      expect(persisted.files.some((file) => file.id === meta.id)).toBe(true);
      fail = false;
      await vi.waitFor(() => {
        expect(attempts).toBeGreaterThan(1);
      }, { timeout: 5_000 });
      await vi.waitFor(async () => {
        expect(await backend.list('files')).not.toContain(meta.id);
      }, { timeout: 5_000 });
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it('throws file.not_found for an unknown id on get', async () => {
    await expect(store().get('f_does_not_exist')).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
  });

  it('deletes a file and then reports not found', async () => {
    const meta = await store().save(readable('bye'), 'bye.txt');
    await store().delete(meta.id);

    await expect(store().get(meta.id)).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
  });

  it('throws file.not_found when deleting an unknown id', async () => {
    await expect(store().delete('f_missing')).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
  });

  it('treats traversal-looking file ids as not found', async () => {
    await expect(store().get('f_../outside')).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
    await expect(store().delete('f_../outside')).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
  });

  it('streams a multi-chunk upload and records the total size', async () => {
    const chunks = [Buffer.from('aaa'), Buffer.from('bbbb'), Buffer.from('cc')];
    const meta = await store().save(Readable.from(chunks), 'chunked.bin');

    expect(meta.size).toBe(9);
    const { stream } = await store().get(meta.id);
    expect((await readAll(stream())).toString()).toBe('aaabbbbcc');
  });

  it('keeps concurrent uploads visible in the persisted index', async () => {
    const metas = await Promise.all([
      store().save(readable('first'), 'first.txt'),
      store().save(readable('second'), 'second.txt'),
    ]);

    const ix2 = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IFileSystemStorageService, backend);
        reg.define(IBlobStore, BlobStoreService);
        reg.define(IFileService, FileServiceImpl);
      },
    });
    const reloaded = ix2.get(IFileService);
    for (const meta of metas) {
      await expect(reloaded.get(meta.id)).resolves.toMatchObject({ meta: { id: meta.id } });
    }
  });

  it('keeps concurrent save and delete changes in the persisted index', async () => {
    const first = await store().save(readable('first'), 'first.txt');
    const [, second] = await Promise.all([
      store().delete(first.id),
      store().save(readable('second'), 'second.txt'),
    ]);

    const ix2 = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IFileSystemStorageService, backend);
        reg.define(IBlobStore, BlobStoreService);
        reg.define(IFileService, FileServiceImpl);
      },
    });
    const reloaded = ix2.get(IFileService);
    await expect(reloaded.get(first.id)).rejects.toMatchObject({ code: FileErrors.codes.FILE_NOT_FOUND });
    await expect(reloaded.get(second.id)).resolves.toMatchObject({ meta: { id: second.id } });
  });

  it('cleans up the blob when the source stream fails mid-upload', async () => {
    const failing = Readable.from((async function* () {
      yield Buffer.from('partial');
      throw new Error('source exploded');
    })());

    await expect(store().save(failing, 'broken.bin')).rejects.toThrow('source exploded');
    expect(await backend.list('files')).toHaveLength(0);
  });

  it('prunes the index when the backing blob is missing', async () => {
    const meta = await store().save(readable('payload'), 'p.txt');
    await (backend as IFileSystemStorageService).delete('files', meta.id);

    await expect(store().get(meta.id)).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
    await expect(store().get(meta.id)).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
  });

  it('persists the index across instances sharing the backend', async () => {
    const meta = await store().save(readable('durable'), 'durable.txt');

    const ix2 = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IFileSystemStorageService, backend);
        reg.define(IBlobStore, BlobStoreService);
        reg.define(IFileService, FileServiceImpl);
      },
    });
    const reloaded = ix2.get(IFileService);
    const { meta: got, stream } = await reloaded.get(meta.id);
    expect(got.id).toBe(meta.id);
    expect((await readAll(stream())).toString()).toBe('durable');
  });

  it('checks blob presence by point size, including empty files', async () => {
    await backend.write('files', 'empty', new Uint8Array());
    const listSpy = vi.spyOn(backend, 'list');
    const blobs = new BlobStoreService(backend);

    await expect(blobs.has('files', 'empty')).resolves.toBe(true);
    await expect(blobs.has('files', 'missing')).resolves.toBe(false);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('opens ranged streams when the storage backend is file-backed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-file-service-'));
    try {
      const ix2 = createServices(disposables, {
        additionalServices: (reg) => {
          reg.defineInstance(IFileSystemStorageService, new FileStorageService(dir));
          reg.define(IBlobStore, BlobStoreService);
          reg.define(IFileService, FileServiceImpl);
        },
      });
      const service = ix2.get(IFileService);

      const meta = await service.save(readable('local bytes'), 'local.txt');
      const got = await service.get(meta.id);

      expect((await readAll(got.stream())).toString()).toBe('local bytes');
      expect((await readAll(got.stream({ start: 6, end: 10 }))).toString()).toBe('bytes');
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('skips invalid persisted index entries when loading the index', async () => {
    await backend.write('files', 'f_valid', Buffer.from('ok'));
    await backend.write('files', 'f_invalid', Buffer.from('bad'));
    await backend.write(
      'file',
      'index.json',
      textEncoder.encode(
        JSON.stringify({
          version: 1,
          files: [
            {
              id: 'f_valid',
              name: 'valid.txt',
              media_type: 'text/plain',
              size: 2,
              created_at: new Date(0).toISOString(),
            },
            {
              id: 'f_../outside',
              name: 'outside.txt',
              media_type: 'text/plain',
              size: 3,
              created_at: new Date(0).toISOString(),
            },
            { id: 'f_invalid' },
          ],
        }),
      ),
    );

    const { meta, stream } = await store().get('f_valid');
    expect(meta.name).toBe('valid.txt');
    expect((await readAll(stream())).toString()).toBe('ok');
    await expect(store().get('f_invalid')).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
    await expect(store().get('f_../outside')).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
  });
});
