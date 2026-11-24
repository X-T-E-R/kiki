import { createHash } from 'node:crypto';
import { access, chmod, constants, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { ContentAddressedStoreService } from '#/persistence/backends/node-fs/contentAddressedStoreService';
import { StorageErrors } from '#/persistence/interface/storage';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('ContentAddressedStoreService', () => {
  it('stores raw bytes under blobs/v2, deduplicates concurrent puts, and streams in <=64 KiB chunks with Range', async () => {
    const homeDir = await makeTempDir('kiki-cas-home-');
    const storage = new FileStorageService(homeDir);
    const cas = new ContentAddressedStoreService(storage);
    try {
      const payload = Buffer.alloc(200 * 1024);
      for (let i = 0; i < payload.byteLength; i += 1) payload[i] = (i * 31) & 0xff;
      const expectedSha = createHash('sha256').update(payload).digest('hex');

      const results = await Promise.all([
        cas.putBytes(payload),
        cas.putStream(Readable.from([payload.subarray(0, 70_000), payload.subarray(70_000)])),
        cas.putBytes(payload),
      ]);

      for (const r of results) {
        expect(r.sha256).toBe(expectedSha);
        expect(r.bytes).toBe(payload.byteLength);
      }
      expect(results.some((r) => r.deduplicated)).toBe(true);

      const casPath = cas.objectPath(expectedSha)!;
      expect(casPath.replaceAll('\\', '/')).toContain(`/blobs/v2/${expectedSha.slice(0, 2)}/${expectedSha}`);

      const chunks: Buffer[] = [];
      for await (const chunk of cas.getStream(expectedSha, { start: 1000, end: 139_999 })) {
        expect(chunk.byteLength).toBeLessThanOrEqual(64 * 1024);
        chunks.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks)).toEqual(payload.subarray(1000, 140_000));
    } finally {
      await storage.close();
    }
  });

  it('never hard-links user workspace source files and keeps source writable and isolated', async () => {
    const homeDir = await makeTempDir('kiki-cas-home-');
    const wsDir = await makeTempDir('kiki-cas-ws-');
    const storage = new FileStorageService(homeDir);
    const cas = new ContentAddressedStoreService(storage);
    try {
      const srcPath = join(wsDir, 'user-clip.bin');
      const original = Buffer.alloc(128 * 1024, 0x41);
      await writeFile(srcPath, original);
      const srcBefore = await stat(srcPath, { bigint: true });

      const put = await cas.putFromFile(srcPath);
      const srcAfter = await stat(srcPath, { bigint: true });
      const casStat = await stat(cas.objectPath(put.sha256)!, { bigint: true });

      expect(srcAfter.ino).toBe(srcBefore.ino);
      expect(casStat.ino).not.toBe(srcAfter.ino);
      await expect(access(srcPath, constants.W_OK)).resolves.toBeUndefined();

      await writeFile(srcPath, Buffer.alloc(128 * 1024, 0x5a));
      const readBack: Buffer[] = [];
      for await (const chunk of cas.getStream(put.sha256)) readBack.push(Buffer.from(chunk));
      expect(Buffer.concat(readBack)).toEqual(original);
    } finally {
      await storage.close();
    }
  });

  it('links managed aliases to 1 physical inode, survives sibling deletion, and rejects corrupted EEXIST target', async () => {
    const homeDir = await makeTempDir('kiki-cas-alias-');
    const storage = new FileStorageService(homeDir);
    const cas = new ContentAddressedStoreService(storage);
    try {
      const payload = Buffer.from('canonical zero-copy content payload for alias link test');
      const put = await cas.putBytes(payload);
      const casPath = cas.objectPath(put.sha256)!;
      const casIno = (await stat(casPath, { bigint: true })).ino;

      const aliasPaths: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const linkedPath = await cas.linkAlias(put.sha256, `agents/child-${i}/blobs`, put.sha256);
        expect(linkedPath).toBeDefined();
        const p = storage.pathFor(`agents/child-${i}/blobs`, put.sha256)!;
        aliasPaths.push(p);
        const info = await stat(p, { bigint: true });
        expect(info.ino).toBe(casIno);
      }

      const targetDir = join(homeDir, 'attachments-direct');
      await mkdir(targetDir, { recursive: true });
      const directPath = join(targetDir, 'f_1-test.bin');
      await cas.linkAliasToPath(put.sha256, directPath);
      expect((await lstat(directPath, { bigint: true })).ino).toBe(casIno);

      for (let i = 0; i < 9; i += 1) {
        await storage.delete(`agents/child-${i}/blobs`, put.sha256);
      }
      expect(await readFile(aliasPaths[9]!)).toEqual(payload);
      expect(await cas.removeUnreferenced(put.sha256)).toBe(false);

      await storage.delete('agents/child-9/blobs', put.sha256);
      await rm(directPath);
      expect(await cas.removeUnreferenced(put.sha256)).toBe(true);
      expect(await cas.has(put.sha256)).toBe(false);

      const corruptedSha = createHash('sha256').update(payload).digest('hex');
      const firstPut = await cas.putBytes(payload);
      expect(firstPut.sha256).toBe(corruptedSha);
      const blobPath = cas.objectPath(corruptedSha)!;
      await chmod(blobPath, 0o600);
      await writeFile(blobPath, Buffer.from('corrupted bytes of different content'));
      await expect(cas.putBytes(payload)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
    } finally {
      await storage.close();
    }
  });
});
