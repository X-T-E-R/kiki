import { describe, expect, it } from 'vitest';

import {
  ZipReadError,
  buildStoredZip,
  buildZipBuffer,
  isSafeZipEntryPath,
  readZipBuffer,
  readZipEntries,
} from '#/_base/node/zip';

describe('shared zip helpers', () => {
  it('round-trips stored and deflated zip buffers', async () => {
    const stored = buildStoredZip([
      { name: 'manifest.json', data: Buffer.from('{"ok":true}') },
      { name: 'assets/icon.bin', data: Buffer.from([1, 2, 3, 255]) },
    ]);
    const entries = readZipEntries(stored, {
      maxEntries: 10,
      maxTotalBytes: 1024,
      maxEntryBytes: () => 1024,
    });
    expect(entries.map((e) => e.name)).toEqual(['manifest.json', 'assets/icon.bin']);
    expect(entries[0]!.data.toString('utf8')).toBe('{"ok":true}');
    expect([...entries[1]!.data]).toEqual([1, 2, 3, 255]);

    const compressed = await buildZipBuffer([
      { name: 'card.json', data: new TextEncoder().encode('{"name":"test"}') },
      { name: 'assets/pic.png', data: Uint8Array.of(137, 80, 78, 71) },
    ]);
    const map = await readZipBuffer(compressed, { maxEntries: 10, maxUncompressedBytes: 1024 });
    expect(new TextDecoder().decode(map.get('card.json'))).toBe('{"name":"test"}');
    expect([...(map.get('assets/pic.png') ?? [])]).toEqual([137, 80, 78, 71]);
  });

  it('rejects Zip-Slip traversal paths and limit violations', async () => {
    expect(isSafeZipEntryPath('assets/a.png')).toBe(true);
    expect(isSafeZipEntryPath('../escape.png')).toBe(false);
    expect(isSafeZipEntryPath('a/../../escape.png')).toBe(false);
    expect(isSafeZipEntryPath('/etc/passwd')).toBe(false);
    expect(isSafeZipEntryPath('C:\\windows\\win.ini')).toBe(false);
    expect(isSafeZipEntryPath('bad\0name.txt')).toBe(false);

    const traversal = buildStoredZip([{ name: '../escape.txt', data: Buffer.from('x') }]);
    expect(() => readZipEntries(traversal, {
      maxEntries: 10,
      maxTotalBytes: 1024,
      maxEntryBytes: () => 1024,
    })).toThrow(ZipReadError);

    await expect(readZipBuffer(traversal, {
      maxEntries: 10,
      maxUncompressedBytes: 1024,
    })).rejects.toThrow(/unsafe path|invalid relative path/i);

    const large = buildStoredZip([{ name: 'big.txt', data: Buffer.alloc(64, 65) }]);
    expect(() => readZipEntries(large, {
      maxEntries: 10,
      maxTotalBytes: 32,
      maxEntryBytes: () => 1024,
    })).toThrow(/too large/);
    await expect(readZipBuffer(large, {
      maxEntries: 10,
      maxUncompressedBytes: 32,
    })).rejects.toThrow(/size limit/);
  });
});
