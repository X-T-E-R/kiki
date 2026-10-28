import { describe, expect, it } from 'vitest';

import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

const encoder = new TextEncoder();

describe('InMemoryStorageService — locks', () => {
  it('rejects cancelled acquisition without reserving a lock and releases a granted lock after cancellation', async () => {
    const svc = new InMemoryStorageService();
    const controller = new AbortController();
    controller.abort(new Error('cancel acquisition'));
    await expect(svc.acquireLock('scope', 'example.lock', { signal: controller.signal })).rejects.toThrow('cancel acquisition');
    const held = new AbortController();
    const lock = await svc.acquireLock('scope', 'example.lock', { signal: held.signal });
    held.abort();
    await lock.release();
    const next = await svc.acquireLock('scope', 'example.lock');
    await next.release();
  });
});

describe('InMemoryStorageService — mtime', () => {
  it('returns undefined for a missing key and the write time for an existing one', async () => {
    const svc = new InMemoryStorageService();
    expect(await svc.mtime('scope', 'missing.json')).toBeUndefined();

    const before = Date.now();
    await svc.write('scope', 'k.json', encoder.encode('{}'));
    const mtime = await svc.mtime('scope', 'k.json');
    expect(mtime).toBeGreaterThanOrEqual(before);
  });

  it('tracks writes, appends and deletions', async () => {
    const svc = new InMemoryStorageService();

    await svc.write('scope', 'k.json', encoder.encode('a'));
    const written = await svc.mtime('scope', 'k.json');
    expect(written).toBeDefined();

    await svc.append('scope', 'k.json', encoder.encode('b'));
    const appended = await svc.mtime('scope', 'k.json');
    expect(appended).toBeGreaterThanOrEqual(written ?? 0);

    await svc.delete('scope', 'k.json');
    expect(await svc.mtime('scope', 'k.json')).toBeUndefined();
  });
});
