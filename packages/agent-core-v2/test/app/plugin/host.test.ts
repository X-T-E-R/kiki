import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { Jimp } from 'jimp';

import { PluginHost } from '#/app/plugin/host';
import { parseManifest } from '#/app/plugin/manifest';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { ScopedMediaStore } from '#/agent/media/sessionMediaStoreService';
import { parseDaemonFileUrl } from '#/agent/media/mediaRef';
import { validateImageDataUrl } from '#/agent/media/image-compress';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

const fixture = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/plugin-host');

function readyHost(): Promise<PluginHost> {
  return parseManifest(fixture).then((manifest) => {
    expect(manifest.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    return new PluginHost('fixture-tool', join(fixture, 'entry.mjs'), manifest.manifest!.kiki!.tools!);
  });
}

async function attachmentStore() {
  const root = await mkdtemp(join(tmpdir(), 'plugin-output-'));
  const disposables = new DisposableStore();
  const storage = new FileStorageService(root);
  const ix = createServices(disposables, {
    strict: true,
    additionalServices: (reg) => {
      reg.defineInstance(IFileSystemStorageService, storage);
      reg.define(IAtomicDocumentStore, JsonAtomicDocumentStore);
    },
  });
  return {
    root,
    store: new ScopedMediaStore('media', storage, ix.get(IAtomicDocumentStore)),
    dispose: async () => { await disposables.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}

async function streamedBytes(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('plugin host lifecycle', () => {
  it('starts only on execute, forwards progress, and stops immediately', async () => {
    const host = await readyHost();
    const progress: unknown[] = [];
    try {
      expect(host.running).toBe(false);
      await expect(host.execute('fixture_echo', { value: 'hello' }, new AbortController().signal, (update) => progress.push(update)))
        .resolves.toEqual({ output: 'hello' });
      expect(progress).toContainEqual({ kind: 'progress', percent: 50, text: 'Halfway' });
      expect(host.running).toBe(true);
    } finally { host.stop(); }
    expect(host.running).toBe(false);
    await expect(host.execute('fixture_echo', {}, new AbortController().signal)).rejects.toThrow('unloaded');
  });

  it('passes a custom native cache path to its isolated child', async () => {
    vi.stubEnv('KIKI_CACHE_DIR', 'test-plugin-cache');
    const host = await readyHost();
    try {
      await expect(host.execute('fixture_echo', { cacheDir: true }, new AbortController().signal))
        .resolves.toEqual({ output: 'test-plugin-cache' });
    } finally { host.stop(); vi.unstubAllEnvs(); }
  });

  it('isolates a crashing child and lets another plugin keep running', async () => {
    const first = await readyHost();
    const second = await readyHost();
    try {
      await expect(first.execute('fixture_echo', { crash: true }, new AbortController().signal)).rejects.toThrow('exited');
      await expect(second.execute('fixture_echo', { value: 'alive' }, new AbortController().signal)).resolves.toEqual({ output: 'alive' });
    } finally { first.stop(); second.stop(); }
  });

  it('passes only the execution scope and accepts bounded image parts', async () => {
    const host = await readyHost();
    try {
      const result = await host.execute('fixture_echo', { context: true }, new AbortController().signal, undefined,
        { token: 'plugin-only' }, { workspaceRoot: fixture, approvedPaths: [fixture], imageIn: true });
      expect(typeof result.output).toBe('string');
      expect(JSON.parse(result.output as string)).toEqual({ workspaceRoot: fixture, approvedPaths: [fixture], imageIn: true, settings: { token: 'plugin-only' } });
      await expect(host.execute('fixture_echo', { image: true }, new AbortController().signal)).resolves.toMatchObject({ output: [
        { type: 'text', text: 'preview' }, { type: 'image_url', imageUrl: { url: 'data:image/png;base64,aGVsbG8=' } },
      ] });
      await expect(host.execute('fixture_echo', { invalidImage: true }, new AbortController().signal)).rejects.toThrow('invalid tool result');
    } finally { host.stop(); }
  });

  it('preserves medium mixed image parts independently of the text budget', async () => {
    const host = await readyHost();
    const attachment = await attachmentStore();
    const data = Buffer.alloc(160 * 160 * 4);
    let state = 0x12345678;
    for (let i = 0; i < data.length; i += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      data[i] = state & 255;
    }
    const png = await new Jimp({ width: 160, height: 160, data }).getBuffer('image/png');
    const url = `data:image/png;base64,${png.toString('base64')}`;
    expect(url.length).toBeGreaterThan(100_000);
    expect(url.length).toBeLessThan(512 * 1024);
    const image = { type: 'image_url', imageUrl: { url } } as const;
    const preview = { type: 'text', text: 'Neutral image preview' } as const;
    try {
      for (const output of [[preview, image], [preview, image, image]]) {
        await expect(host.execute('fixture_echo', { output }, new AbortController().signal)).resolves.toEqual({ output });
      }
      const smallPng = await new Jimp({ width: 8, height: 8, color: 0x4078c8ff }).getBuffer('image/png');
      const smallOutput = [preview, { type: 'image_url', imageUrl: { url: `data:image/png;base64,${smallPng.toString('base64')}` } }];
      await expect(host.execute('fixture_echo', { output: smallOutput }, new AbortController().signal)).resolves.toEqual({ output: smallOutput });
      const result = await host.execute('fixture_echo', { output: [preview, image, image, image, image] }, new AbortController().signal, undefined, {}, { attachmentStore: attachment.store });
      if (typeof result.output === 'string') throw new Error('Image parts were replaced by text');
      const images = result.output.filter((part) => part.type === 'image_url');
      expect(images).toHaveLength(4);
      for (const part of images) {
        const fileId = parseDaemonFileUrl(part.imageUrl.url)!.fileId;
        const file = (await attachment.store.open(fileId))!;
        expect(file.mediaType).toBe('image/png');
        const bytes = await streamedBytes(file.stream());
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(createHash('sha256').update(png).digest('hex'));
        const decoded = await Jimp.read(bytes);
        expect([decoded.width, decoded.height]).toEqual([160, 160]);
      }
      const mixed = await host.execute('fixture_echo', { output: [image, ...Array.from({ length: 3 }, () => ({ type: 'text', text: 'x'.repeat(40_000) }))] }, new AbortController().signal, undefined, {}, { attachmentStore: attachment.store });
      if (typeof mixed.output === 'string') throw new Error('Mixed image parts were replaced by text');
      expect(mixed.output.filter((part) => part.type === 'image_url')).toEqual([image]);
      const notice = mixed.output.find((part) => part.type === 'text');
      if (notice?.type !== 'text') throw new Error('Missing text attachment notice');
      const textId = parseDaemonFileUrl(/kimi-file:\/\/([^"\s]+)/.exec(notice.text)![0])!.fileId;
      const textFile = (await attachment.store.open(textId))!;
      const textParts = JSON.parse((await streamedBytes(textFile.stream())).toString()) as { text: string }[];
      expect(textParts.map((part) => part.text)).toEqual(Array.from({ length: 3 }, () => 'x'.repeat(40_000)));
    } finally { await host.stopAndWait(); await attachment.dispose(); }
  });

  it('streams a legal large output completely with a preview while a same-host small call finishes', async () => {
    const host = await readyHost();
    const attachment = await attachmentStore();
    const started = deferred();
    const release = deferred();
    const materialize = attachment.store.materialize.bind(attachment.store);
    vi.spyOn(attachment.store, 'materialize').mockImplementation(async (input) => {
      started.resolve();
      await release.promise;
      return materialize(input);
    });
    try {
      const large = host.execute('fixture_echo', { large: true }, new AbortController().signal, undefined, {}, { attachmentStore: attachment.store });
      await started.promise;
      await expect(host.execute('fixture_echo', { value: 'still alive' }, new AbortController().signal)).resolves.toEqual({ output: 'still alive' });
      release.resolve();
      const result = await large;
      expect(typeof result.output).toBe('string');
      const output = result.output as string;
      expect(output.length).toBeLessThanOrEqual(50_000);
      expect(result.truncated).toBe(true);
      const reference = /kimi-file:\/\/([^"\s]+)/.exec(output)![0];
      const fileId = parseDaemonFileUrl(reference)!.fileId;
      const file = (await attachment.store.open(fileId))!;
      expect(file.path).toBeDefined();
      expect(file.mediaType).toBe('text/plain');
      const hash = createHash('sha256');
      let size = 0;
      for await (const bytes of file.stream()) { hash.update(bytes); size += bytes.byteLength; }
      const expected = `${'x'.repeat(16 * 1024 * 1024)}😀tail`;
      expect(size).toBe(Buffer.byteLength(expected));
      expect(hash.digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'));
      expect((await streamedBytes(file.stream({ start: size - 8, end: size - 1 }))).toString()).toBe('😀tail');
    } finally { release.resolve(); await host.stopAndWait(); await attachment.dispose(); }
  });

  it('preserves a legal large image as a canonical readable and decodable image while the host stays usable', async () => {
    const host = await readyHost();
    const attachment = await attachmentStore();
    try {
      const large = host.execute('fixture_echo', { largeImage: true }, new AbortController().signal, undefined, {}, { attachmentStore: attachment.store });
      await expect(host.execute('fixture_echo', { value: 'small' }, new AbortController().signal)).resolves.toEqual({ output: 'small' });
      const result = await large;
      if (typeof result.output === 'string') throw new Error('Image output was not delivered');
      const part = result.output.find((item) => item.type === 'image_url');
      if (part?.type !== 'image_url') throw new Error('Missing image output');
      const fileId = parseDaemonFileUrl(part.imageUrl.url)!.fileId;
      const file = (await attachment.store.open(fileId))!;
      const bytes = await streamedBytes(file.stream());
      const checksum = result.output.find((item) => item.type === 'text' && item.text.startsWith('original_sha256:'));
      if (checksum?.type !== 'text') throw new Error('Missing original checksum');
      expect(`data:image/png;base64,${bytes.toString('base64')}`.length).toBeGreaterThan(12 * 1024 * 1024);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(checksum.text.slice('original_sha256: '.length));
      expect(file.mediaType).toBe('image/png');
      expect(await validateImageDataUrl(`data:image/png;base64,${bytes.toString('base64')}`)).not.toBeNull();
      const decoded = await Jimp.read(bytes);
      expect([decoded.width, decoded.height]).toEqual([1536, 1536]);
    } finally { await host.stopAndWait(); await attachment.dispose(); }
  });

  it('reports a large output storage failure only to that call and closes an interrupted reception', async () => {
    const host = await readyHost();
    const attachment = await attachmentStore();
    try {
      const failed = host.execute('fixture_echo', { large: true }, new AbortController().signal);
      await expect(failed).rejects.toThrow('Session attachment storage is unavailable');
      await expect(host.execute('fixture_echo', { value: 'small' }, new AbortController().signal)).resolves.toEqual({ output: 'small' });
      const abort = new AbortController();
      const materialize = attachment.store.materialize.bind(attachment.store);
      const save = vi.spyOn(attachment.store, 'materialize').mockImplementation(async (input) => {
        input.stream().once('data', () => { abort.abort(); });
        return materialize(input);
      });
      await expect(host.execute('fixture_echo', { large: true }, abort.signal, undefined, {}, { attachmentStore: attachment.store })).rejects.toThrow('cancelled');
      await expect(host.execute('fixture_echo', { value: 'after cancel' }, new AbortController().signal)).resolves.toEqual({ output: 'after cancel' });
      save.mockImplementation(async (input) => {
        const stream = input.stream() as Readable;
        stream.once('data', () => { stream.destroy(new Error('Attachment write failed')); });
        return materialize(input);
      });
      await expect(host.execute('fixture_echo', { large: true }, new AbortController().signal, undefined, {}, { attachmentStore: attachment.store })).rejects.toThrow('Attachment write failed');
      await expect(host.execute('fixture_echo', { value: 'after failure' }, new AbortController().signal)).resolves.toEqual({ output: 'after failure' });
      await host.stopAndWait();
      const entries = await readdir(join(attachment.root, 'media')).catch(() => [] as string[]);
      expect(entries).toEqual([]);
    } finally { await host.stopAndWait(); await attachment.dispose(); }
  });

  it('delivers cancel to the child', async () => {
    const host = await readyHost();
    const abort = new AbortController();
    try {
      const execution = host.execute('fixture_echo', { wait: true }, abort.signal);
      setTimeout(() => abort.abort(), 100);
      await expect(execution).rejects.toThrow('cancelled');
    } finally { host.stop(); }
  });
});
