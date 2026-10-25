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
import { SqliteQueryStore } from '#/persistence/backends/sqlite/sqliteQueryStore';
import { drainQueryStoreDisposals } from '#/persistence/queryStoreDisposals';
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
    ix.set(IQueryStore, new SyncDescriptor(SqliteQueryStore));
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

  it('bounds range pages and preserves unknown and out-of-range invalid facts across cursors', async () => {
    const records = Array.from({ length: 620 }, (_, index) => normalizeUsageFact(fact(index, index % 3 !== 0), 'main')!);
    records.push({ ...records[0]!, time: -1, invalid: true });
    await facts.commit(SCOPE, 0, { generation: 'legacy', offset: 620, size: 620, mtimeMs: 1, boundaryHash: '', valid: false }, records);
    await facts.summary(SCOPE);
    let cursor: string | undefined;
    const result = [];
    for (let pass = 0; pass < 10; pass++) {
      const allowance = pass % 2 === 0 ? 100 : 256;
      const budget = { remainingRecords: allowance };
      const snapshot = await facts.read(SCOPE, { startAt: 0, endAt: 1000 }, undefined, { budget, cursor });
      expect(snapshot.records.length).toBeLessThanOrEqual(allowance);
      expect(budget.remainingRecords).toBeGreaterThanOrEqual(0);
      result.push(...snapshot.records);
      cursor = snapshot.nextCursor;
      if (snapshot.readComplete !== false) break;
      expect(cursor).toBeDefined();
    }
    expect(cursor).toBeUndefined();
    expect(result).toHaveLength(621);
    expect(result.filter((row) => !row.invalid).map((row) => row.time).toSorted((a, b) => a - b)).toEqual(Array.from({ length: 620 }, (_, ordinal) => ordinal));
    expect(result.filter((row) => row.usageKnown === false)).toHaveLength(208);
    expect(result.filter((row) => row.invalid)).toHaveLength(1);
  });

  it('freezes paged range ordinals across backdated appends and rejects a rewritten generation', async () => {
    for (const value of [fact(1), fact(2, false), fact(3)]) logs.append(SCOPE, KEY, value);
    await logs.flush(SCOPE, KEY);
    const first = await facts.read(SCOPE, { startAt: 0, endAt: 10 }, undefined, { pageSize: 0 });
    expect(first.records).toHaveLength(0);
    expect(first.nextCursor).toBeDefined();
    logs.append(SCOPE, KEY, fact(0));
    await logs.flush(SCOPE, KEY);
    const records = [...first.records];
    let cursor = first.nextCursor;
    for (let pass = 0; cursor !== undefined && pass < 5; pass++) {
      const next = await facts.read(SCOPE, { startAt: 0, endAt: 10 }, undefined, { pageSize: 1, cursor });
      expect(next.records.length).toBeLessThanOrEqual(1);
      expect(next.checkpoint).toEqual(first.checkpoint);
      records.push(...next.records);
      cursor = next.nextCursor;
    }
    expect(cursor).toBeUndefined();
    expect(records.map((record) => record.time)).toEqual([1, 2, 3]);
    expect((await facts.read(SCOPE)).records).toHaveLength(4);
    await logs.rewrite(SCOPE, KEY, [fact(9)]);
    await expect(facts.read(SCOPE, { startAt: 0, endAt: 10 }, undefined, { cursor: first.nextCursor, pageSize: 1 })).rejects.toThrow('Usage fact cursor changed');
  });

  it('rebuilds the earlier query-view format from facts without changing the journal', async () => {
    logs.append(SCOPE, KEY, fact(1));
    await logs.flush(SCOPE, KEY);
    const expected = await facts.read(SCOPE);
    const head = await query.get<Record<string, unknown>>(COLLECTION, 'head');
    await query.put(COLLECTION, 'head', { ...head, version: 1 });
    const before = await storage.read(`cache/usage-facts-v1/${ID}`, 'facts.jsonl');
    const read = vi.spyOn(storage, 'readStream');
    expect(await facts.read(SCOPE)).toEqual(expected);
    expect(await query.get(COLLECTION, 'head')).toMatchObject({ version: 2 });
    expect(await storage.read(`cache/usage-facts-v1/${ID}`, 'facts.jsonl')).toEqual(before);
    expect(read.mock.calls.every(([, key]) => key === 'facts.jsonl')).toBe(true);
  });

  it('keeps the published rows stable through staging pauses and peer publication', async () => {
    const checkpoint = { generation: 'legacy', offset: 1, size: 1, mtimeMs: 1, boundaryHash: '', valid: true };
    const initial = normalizeUsageFact(fact(0), 'main')!;
    await facts.commit(SCOPE, 0, checkpoint, [initial]);
    const published = await facts.read(SCOPE);
    const records = Array.from({ length: 620 }, (_, index) => normalizeUsageFact(fact(index + 1), 'main')!);
    await facts.commit(SCOPE, 1, { ...checkpoint, offset: 621, size: 621 }, records);
    const partial = await facts.summary(SCOPE, undefined, { budget: { remainingRecords: 800 } });
    expect(partial.readComplete).toBe(false);
    const peer = new TestInstantiationService();
    peer.stub(IBootstrapService, stubBootstrap(home)); peer.stub(ILogService, stubLog()); peer.stub(IFileSystemStorageService, storage);
    peer.set(IQueryStore, new SyncDescriptor(SqliteQueryStore)); peer.set(IAppendLogStore, new SyncDescriptor(AppendLogStore)); peer.set(IUsageFactStore, new SyncDescriptor(UsageFactStore));
    try {
      const peerQuery = peer.get(IQueryStore);
      expect(await peerQuery.get(COLLECTION, 'head')).toMatchObject({ recordCount: 1, checkpoint: published.checkpoint });
      expect((await peerQuery.query(COLLECTION).where({ kind: 'fact' }).execute()).items).toEqual([expect.objectContaining({ ordinal: 0, time: 0 })]);
      expect((await peer.get(IUsageFactStore).read(SCOPE)).records).toEqual([initial, ...records]);
      expect((await facts.read(SCOPE)).records).toEqual([initial, ...records]);
      expect(await query.get(COLLECTION, 'head')).toMatchObject({ recordCount: 621, checkpoint: { offset: 621 } });
    } finally { await peer.dispose(); await drainQueryStoreDisposals(); }
  });

  it('resumes multi-page index construction within fact allowances without publishing its source checkpoint early', async () => {
    const records = Array.from({ length: 900 }, (_, index) => normalizeUsageFact(fact(index), 'main')!);
    await facts.commit(SCOPE, 0, { generation: 'legacy', offset: 900, size: 900, mtimeMs: 1, boundaryHash: '', valid: true }, records);
    const batch = vi.spyOn(query, 'batch');
    const read = vi.spyOn(storage, 'readStream');
    const keys = vi.spyOn(query, 'listKeys');
    let complete = false;
    for (let pass = 0; pass < 24; pass++) {
      const budget = { remainingRecords: 100 };
      const snapshot = await facts.read(SCOPE, undefined, undefined, { budget });
      expect(budget.remainingRecords).toBeGreaterThanOrEqual(0);
      expect(snapshot.records.length).toBeLessThanOrEqual(100);
      if (snapshot.checkpoint !== undefined) { complete = true; break; }
      expect(snapshot.readComplete).toBe(false);
      expect(await query.get(COLLECTION, 'head')).toBeUndefined();
    }
    expect(complete).toBe(true);
    expect(batch.mock.calls.every(([ops]) => ops.length <= 256)).toBe(true);
    expect(keys).not.toHaveBeenCalled();
    expect(read.mock.calls.some(([, , range]) => (range?.start ?? 0) > 0)).toBe(true);
    expect((await facts.read(SCOPE)).records).toEqual(records);
  });

  it('bounds summary index preparation while allowing an explicit unbounded settle to finish', async () => {
    const records = Array.from({ length: 20 }, (_, index) => normalizeUsageFact(fact(index), 'main')!);
    await facts.commit(SCOPE, 0, { generation: 'legacy', offset: 20, size: 20, mtimeMs: 1, boundaryHash: '', valid: true }, records);
    const budget = { remainingRecords: 3 };
    expect(await facts.summary(SCOPE, undefined, { budget })).toEqual({ readComplete: false });
    expect(budget.remainingRecords).toBe(0);
    expect(await query.get(COLLECTION, 'head')).toBeUndefined();
    const complete = await facts.summary(SCOPE);
    expect(complete.readComplete).not.toBe(false);
    expect(complete.checkpoint?.offset).toBe(20);
    expect(complete.totals?.records).toBe(20);
    expect(complete.totals?.usage.output).toBe(40);
  });

  it('shares one fact allowance across concurrent source reads', async () => {
    const records = Array.from({ length: 300 }, (_, index) => normalizeUsageFact(fact(index, false), 'main')!);
    const scopes = [SCOPE, 'sessions/example/session/agents/child'];
    for (const scope of scopes) {
      await facts.commit(scope, 0, { generation: 'legacy', offset: 300, size: 300, mtimeMs: 1, boundaryHash: '', valid: true }, records);
      await facts.summary(scope);
    }
    let entered = 0, release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const get = query.getMany.bind(query);
    vi.spyOn(query, 'getMany').mockImplementation(async <T>(collection: string, keys: readonly string[], signal?: AbortSignal) => {
      if (keys[0]?.startsWith('fact:') && ++entered <= 2) { if (entered === 2) release(); await gate; }
      return get<T>(collection, keys, signal);
    });
    const budget = { remainingRecords: 350 };
    const snapshots = await Promise.all(scopes.map((scope) => facts.read(scope, undefined, undefined, { budget })));
    expect(snapshots.reduce((total, snapshot) => total + snapshot.records.length, 0)).toBe(350);
    expect(snapshots.every((snapshot) => snapshot.readComplete === false)).toBe(true);
    expect(budget.remainingRecords).toBe(0);
  });

  it('passes the real read signal through staging, ordinal reads, verification and range queries', async () => {
    const controller = new AbortController();
    logs.append(SCOPE, KEY, fact());
    await logs.flush(SCOPE, KEY);
    const points = vi.spyOn(query, 'getMany');
    const executeSignals: Array<AbortSignal | undefined> = [];
    const select = query.query.bind(query);
    vi.spyOn(query, 'query').mockImplementation(<T>(collection: string) => {
      const selection = select<T>(collection);
      const execute = selection.execute.bind(selection);
      vi.spyOn(selection, 'execute').mockImplementation((signal) => { executeSignals.push(signal); return execute(signal); });
      return selection;
    });
    expect((await facts.read(SCOPE, undefined, controller.signal)).records).toHaveLength(1);
    expect(points.mock.calls.length).toBeGreaterThan(2);
    expect(points.mock.calls.every((args) => args[2] === controller.signal)).toBe(true);
    (Reflect.get(facts, 'verified') as Set<string>).clear();
    expect((await facts.read(SCOPE, { startAt: 0, endAt: 2 }, controller.signal)).records).toHaveLength(1);
    expect(executeSignals.length).toBeGreaterThanOrEqual(3);
    expect(executeSignals.every((signal) => signal === controller.signal)).toBe(true);
  });

  it('cancels a stalled index read promptly and leaves another read usable', async () => {
    logs.append(SCOPE, KEY, fact());
    await logs.flush(SCOPE, KEY);
    const expected = await facts.read(SCOPE);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const get = query.get.bind(query);
    vi.spyOn(query, 'get').mockImplementationOnce(async (collection, key) => { entered(); await gate; return get(collection, key); });
    const controller = new AbortController();
    const reading = facts.read(SCOPE, undefined, controller.signal);
    await started;
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    release();
    expect(await facts.read(SCOPE)).toEqual(expected);
  });
});
