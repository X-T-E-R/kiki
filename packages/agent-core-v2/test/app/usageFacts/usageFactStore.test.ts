import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IUsageFactStore, UsageFactStore } from '#/app/usageFacts/usageFactStore';
import { normalizeUsageFact } from '#/agent/usage/usageFact';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IQueryStore } from '#/persistence/interface/queryStore';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { MiniDbQueryStore, drainQueryStoreDisposals } from '#/persistence/backends/minidb/miniDbQueryStore';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';

const SCOPE = 'sessions/example/session/agents/main';
const KEY = 'wire.jsonl';
const ID = createHash('sha256').update(SCOPE).digest('hex');
const COLLECTION = `usage-facts-v1:${ID}`;
const fact = (time = 1, known = true) => ({ type: 'usage.record', time, model: 'example', usageKnown: known, usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 } });

describe('UsageFactStore', () => {
  let home: string;
  let ix: TestInstantiationService;
  let storage: InMemoryStorageService;
  let facts: IUsageFactStore;
  let logs: IAppendLogStore;
  let query: IQueryStore;

  function open(): void {
    ix = new TestInstantiationService();
    ix.stub(IBootstrapService, stubBootstrap(home));
    ix.stub(ILogService, stubLog());
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IQueryStore, new SyncDescriptor(MiniDbQueryStore));
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IUsageFactStore, new SyncDescriptor(UsageFactStore));
    facts = ix.get(IUsageFactStore);
    logs = ix.get(IAppendLogStore);
    query = ix.get(IQueryStore);
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'usage-facts-'));
    storage = new InMemoryStorageService();
    open();
  });
  afterEach(async () => {
    await query.close();
    await ix.dispose();
    await drainQueryStoreDisposals();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('writes known, missing and zero facts after canonical success; non-usage advances coverage without wire reads', async () => {
    const read = vi.spyOn(storage, 'readStream');
    const zero = { ...fact(3), usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } };
    for (const value of [fact(1), fact(2, false), zero, { type: 'message', time: 4, text: 'body'.repeat(10000) }]) logs.append(SCOPE, KEY, value);
    await logs.flush(SCOPE, KEY);
    const snapshot = await facts.read(SCOPE);
    expect(snapshot.checkpoint).toMatchObject({ generation: 'legacy', offset: await storage.size(SCOPE, KEY), valid: true });
    expect(snapshot.records).toHaveLength(3);
    expect(snapshot.records.map((row) => row.usageKnown)).toEqual([true, false, true]);
    expect(snapshot.records[2]?.usage.output).toBe(0);
    expect(read.mock.calls.every(([, key]) => key !== KEY)).toBe(true);
    expect((await facts.read(SCOPE, { startAt: 2, endAt: 3 })).records).toEqual([snapshot.records[1]]);
    logs.append(SCOPE, KEY, fact(5));
    await logs.flush(SCOPE, KEY);
    const appended = await facts.read(SCOPE);
    const wire = (await storage.read(SCOPE, KEY))!;
    expect(appended.checkpoint?.boundaryHash).toBe(createHash('sha256').update(wire.slice(-4096)).digest('base64url'));
    expect(read.mock.calls.every(([, key]) => key !== KEY)).toBe(true);
  });

  it('invalidates a growing managed rewrite even when its old boundary bytes are preserved', async () => {
    const padding = { type: 'message', time: 2, text: 'x'.repeat(5000) };
    logs.append(SCOPE, KEY, fact(1));
    logs.append(SCOPE, KEY, padding);
    await logs.flush(SCOPE, KEY);
    const before = await facts.read(SCOPE);
    await logs.rewrite(SCOPE, KEY, [fact(9), padding, { type: 'message', time: 3 }]);
    const after = await facts.read(SCOPE);
    expect(after.checkpoint?.generation).not.toBe(before.checkpoint?.generation);
    expect(after.records.map((row) => row.time)).toEqual([9]);
    expect(after.checkpoint?.offset).toBe(await storage.size(SCOPE, KEY));
  });

  it('keeps canonical success and the previous coverage when a fact append fails', async () => {
    logs.append(SCOPE, KEY, fact(1));
    await logs.flush(SCOPE, KEY);
    const first = await facts.read(SCOPE);
    const append = storage.append.bind(storage);
    storage.append = async (scope, key, bytes, options) => {
      if (key === 'facts.jsonl') throw new Error('derived disk unavailable');
      await append(scope, key, bytes, options);
    };
    logs.append(SCOPE, KEY, fact(2));
    await expect(logs.flush(SCOPE, KEY)).resolves.toBeUndefined();
    expect(await storage.size(SCOPE, KEY)).toBeGreaterThan(first.checkpoint!.offset);
    expect(JSON.parse(new TextDecoder().decode(await storage.read(`cache/usage-facts-v1/${ID}`, 'facts.jsonl')).trim()).checkpoint.offset).toBe(first.checkpoint!.offset);
    await logs.drainRetirements();
    storage.append = append;
    logs.append(SCOPE, KEY, fact(3));
    await logs.flush(SCOPE, KEY);
    expect((await facts.read(SCOPE)).checkpoint).toEqual(first.checkpoint);
    const wire = (await storage.read(SCOPE, KEY))!;
    await facts.commit(SCOPE, first.checkpoint!.offset, { generation: 'legacy', offset: wire.length, size: wire.length, mtimeMs: (await storage.mtime(SCOPE, KEY))!, boundaryHash: createHash('sha256').update(wire.slice(-4096)).digest('base64url'), valid: true }, [normalizeUsageFact(fact(2), 'main')!, normalizeUsageFact(fact(3), 'main')!]);
    const recovered = await facts.read(SCOPE);
    expect(recovered.records.map((row) => row.time)).toEqual([1, 2, 3]);
    expect(recovered.checkpoint?.offset).toBe(wire.length);
  });

  it('reopens the real disk query index and rebuilds a lost index only from lightweight facts', async () => {
    logs.append(SCOPE, KEY, fact(1));
    logs.append(SCOPE, KEY, fact(2, false));
    await logs.flush(SCOPE, KEY);
    const expected = await facts.read(SCOPE);
    await query.close();
    await ix.dispose();
    await drainQueryStoreDisposals();
    open();
    const read = vi.spyOn(storage, 'readStream');
    expect(await facts.read(SCOPE)).toEqual(expected);
    expect(read).not.toHaveBeenCalled();
    await query.dropCollection(COLLECTION);
    expect(await facts.read(SCOPE)).toEqual(expected);
    expect(read.mock.calls.every(([, key]) => key === 'facts.jsonl')).toBe(true);
  });

  it('rebuilds an index whose published head survived without all of its fact rows', async () => {
    logs.append(SCOPE, KEY, fact());
    await logs.flush(SCOPE, KEY);
    const expected = await facts.read(SCOPE);
    const key = (await query.listKeys(COLLECTION)).find((key) => key !== 'head')!;
    await query.delete(COLLECTION, key);
    await query.close();
    await ix.dispose();
    await drainQueryStoreDisposals();
    open();
    expect(await facts.read(SCOPE)).toEqual(expected);
  });

  it('keeps duplicate baseline usages by ordinal and never claims coverage across a missing prefix', async () => {
    await storage.write(SCOPE, KEY, Buffer.from('{"type":"old"}\n'));
    logs.append(SCOPE, KEY, fact());
    await logs.flush(SCOPE, KEY);
    expect(await facts.read(SCOPE)).toEqual({ records: [] });
    const normalized = normalizeUsageFact(fact(), 'main')!;
    await facts.commit(SCOPE, 0, { generation: 'legacy', offset: (await storage.size(SCOPE, KEY))!, size: (await storage.size(SCOPE, KEY))!, mtimeMs: (await storage.mtime(SCOPE, KEY))!, boundaryHash: '', valid: true }, [normalized, normalized]);
    expect((await facts.read(SCOPE)).records).toEqual([normalized, normalized]);
  });
});
