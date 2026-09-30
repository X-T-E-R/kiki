import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';

import { extractBinaryZip, installBinaryArchive, type BinaryArchiveProgress } from '#/os/backends/node-local/binaryArchive';
import { antigravityAuthSettings, antigravityCredentialEnvToRemove } from '#/os/backends/node-local/antigravitySettings';

const homes: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

async function fixture(entries: readonly { name: string; mode?: number }[], transform?: (buffer: Buffer) => Buffer) {
  const home = await mkdtemp(join(tmpdir(), 'agy-zip-'));
  homes.push(home);
  const zip = new ZipFile();
  for (const entry of entries) zip.addBuffer(Buffer.from('native-fixture'), entry.name, { mode: entry.mode });
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  const data = Buffer.concat(chunks);
  const archive = join(home, 'archive.zip');
  await writeFile(archive, transform?.(data) ?? data);
  const destination = join(home, 'unpacked');
  await mkdir(destination);
  return { home, archive, destination };
}

describe('Antigravity archive and settings boundary', () => {
  it('extracts the actual vendor entry family without losing its native sibling', async () => {
    const { archive, destination } = await fixture([{ name: 'agy_acp_server.exe' }, { name: 'localharness_external.exe' }, { name: 'nested/runtime.bin' }]);
    await extractBinaryZip(archive, destination);
    expect(await readFile(join(destination, 'agy_acp_server.exe'), 'utf8')).toBe('native-fixture');
    expect(await readFile(join(destination, 'localharness_external.exe'), 'utf8')).toBe('native-fixture');
  });

  it('rejects traversal, case aliases, symlinks, and encrypted ZIP entries', async () => {
    const traversal = await fixture([{ name: 'xx/outside' }], (buffer) => Buffer.from(buffer.toString('latin1').replaceAll('xx/outside', '../outside'), 'latin1'));
    await expect(extractBinaryZip(traversal.archive, traversal.destination)).rejects.toThrow();
    const alias = await fixture([{ name: 'Native.exe' }, { name: 'native.exe' }]);
    await expect(extractBinaryZip(alias.archive, alias.destination)).rejects.toThrow('Unsafe ZIP');
    const symlink = await fixture([{ name: 'native', mode: 0o120777 }]);
    await expect(extractBinaryZip(symlink.archive, symlink.destination)).rejects.toThrow('Unsafe ZIP');
    const encrypted = await fixture([{ name: 'native' }], (buffer) => {
      const data = Buffer.from(buffer);
      for (let i = 0; i < data.length - 10; i++) {
        const signature = data.readUInt32LE(i);
        if (signature === 0x04034b50) data.writeUInt16LE(data.readUInt16LE(i + 6) | 1, i + 6);
        if (signature === 0x02014b50) data.writeUInt16LE(data.readUInt16LE(i + 8) | 1, i + 8);
      }
      return data;
    });
    await expect(extractBinaryZip(encrypted.archive, encrypted.destination)).rejects.toThrow('Unsafe ZIP');
  });

  it('only changes auth.type and preserves enterprise and unrelated settings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agy-settings-'));
    homes.push(home);
    const directory = join(home, 'antigravity-acp');
    await mkdir(directory);
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ auth: { type: 'oauth-business', other: 'keep' }, gcp: { project: 'fixture', location: 'fixture' }, theme: 'dark' }));
    expect(await antigravityAuthSettings(home)).toBe('oauth-business');
    await antigravityAuthSettings(home, 'gemini-api-key');
    expect(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))).toEqual({ auth: { type: 'gemini-api-key', other: 'keep' }, gcp: { project: 'fixture', location: 'fixture' }, theme: 'dark' });
    expect(antigravityCredentialEnvToRemove('oauth-personal')).toContain('GEMINI_API_KEY');
    expect(antigravityCredentialEnvToRemove('gemini-api-key')).not.toContain('GEMINI_API_KEY');
    expect(antigravityCredentialEnvToRemove('agent-platform')).toEqual(['GEMINI_API_KEY']);
    await writeFile(join(directory, 'settings.json'), '[]');
    await expect(antigravityAuthSettings(home, 'oauth-personal')).rejects.toThrow('must be an object');
  });
});

describe('binary archive install progress', () => {
  async function zipBytes(names: readonly string[]): Promise<Buffer> {
    const zip = new ZipFile();
    for (const name of names) zip.addBuffer(Buffer.alloc(300_000, 7), name, { compress: false });
    zip.end();
    const chunks: Buffer[] = [];
    for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  function vendorResponse(data: Buffer): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < data.length; offset += 64 * 1024) controller.enqueue(data.subarray(offset, offset + 64 * 1024));
        controller.close();
      },
    });
    const response = new Response(body, { headers: { 'content-length': String(data.length) } });
    Object.defineProperty(response, 'url', { value: 'https://dl.google.com/fixture.zip' });
    return response;
  }

  it('reports download bytes up to the total, then extraction, in order', async () => {
    const data = await zipBytes(['agy_acp_server.exe', 'localharness_external.exe']);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(vendorResponse(data));
    const home = await mkdtemp(join(tmpdir(), 'agy-progress-'));
    homes.push(home);
    const stages: BinaryArchiveProgress[] = [];
    await installBinaryArchive({ url: 'https://dl.google.com/fixture.zip', directory: join(home, '1.2.1'),
      entry: 'agy_acp_server.exe', requiredSibling: 'localharness_external.exe', onProgress: (progress) => stages.push(progress) });
    const downloads = stages.filter((stage) => stage.stage === 'download');
    expect(downloads[0]).toEqual({ stage: 'download', receivedBytes: 0, totalBytes: data.length });
    expect(downloads.at(-1)).toEqual({ stage: 'download', receivedBytes: data.length, totalBytes: data.length });
    expect(downloads.length).toBeGreaterThan(2);
    expect(downloads.length).toBeLessThanOrEqual(102);
    const received = downloads.map((stage) => stage.receivedBytes);
    expect(received).toEqual([...received].sort((left, right) => left - right));
    expect(stages.at(-1)).toEqual({ stage: 'extract' });
    expect(stages.findIndex((stage) => stage.stage === 'extract')).toBe(stages.length - 1);
  });

  it('fails with a timeout when the download outlives its deadline', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(init.signal!.reason); });
    }));
    const home = await mkdtemp(join(tmpdir(), 'agy-timeout-'));
    homes.push(home);
    const stages: BinaryArchiveProgress[] = [];
    await expect(installBinaryArchive({ url: 'https://dl.google.com/fixture.zip', directory: join(home, '1.2.1'),
      entry: 'a', requiredSibling: 'b', timeoutMs: 20, onProgress: (progress) => stages.push(progress) }))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(stages).toEqual([]);
  });
});
