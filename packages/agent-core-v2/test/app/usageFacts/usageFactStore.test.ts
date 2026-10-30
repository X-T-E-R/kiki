import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IUsageFactStore, UsageFactStore, type UsageFactCheckpoint } from '#/app/usageFacts/usageFactStore';
import { normalizeUsageFact } from '#/agent/usage/usageFact';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IUsageReadModel } from '#/persistence/interface/usageReadModel';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { SqliteUsageReadModel } from '#/persistence/backends/sqlite/sqliteUsageReadModel';
import { drainQueryStoreDisposals } from '#/persistence/queryStoreDisposals';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';

const SCOPE = 'sessions/example/session/agents/main';
const KEY = 'wire.jsonl';
const DIRECTORY = `cache/usage-facts-v1/${createHash('sha256').update(SCOPE).digest('hex')}`;
const fact = (time = 1, known = true) => ({ type: 'usage.record', time, model: 'example', usageKnown: known, usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 } });
const checkpoint = (offset: number): UsageFactCheckpoint => ({ generation: 'legacy', offset, size: offset, mtimeMs: 1, boundaryHash: '', valid: true });

describe('UsageFactStore', () => {
  let home: string;
  let ix: TestInstantiationService;
  let storage: InMemoryStorageService;
  let facts: IUsageFactStore;
  let logs: IAppendLogStore;
  let model: IUsageReadModel;
  function open(): void {
    ix = new TestInstantiationService();
    ix.stub(IBootstrapService, stubBootstrap(home));
    ix.stub(ILogService, stubLog());
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IUsageReadModel, new SyncDescriptor(SqliteUsageReadModel));
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IUsageFactStore, new SyncDescriptor(UsageFactStore));
    model = ix.get(IUsageReadModel); facts = ix.get(IUsageFactStore); logs = ix.get(IAppendLogStore);
  }
  async function close(): Promise<void> { await ix.dispose(); await model.close(); await drainQueryStoreDisposals(); }
  async function journal(count: number): Promise<void> {
    await storage.write(DIRECTORY, 'facts.jsonl', Buffer.from(`${JSON.stringify({ version: 1, start: 0, checkpoint: checkpoint(count), records: Array.from({ length: count }, (_, index) => normalizeUsageFact(fact(index), 'main')!) })}\n`));
  }
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'usage-facts-')); storage = new InMemoryStorageService(); open(); });
  afterEach(async () => { await close(); await rm(home, { recursive: true, force: true, maxRetries: 5 }); });

  it('reads aligned checkpoint metadata without reading fact rows and rejects stale generation or journal length', async () => {
    logs.append(SCOPE, KEY, fact()); await logs.flush();
    const expected = (await facts.read(SCOPE)).checkpoint;
    const rows = vi.spyOn(model, 'read'), streams = vi.spyOn(storage, 'readStream');
    expect(await facts.checkpoint(SCOPE)).toEqual(expected);
    expect(rows).not.toHaveBeenCalled(); expect(streams).not.toHaveBeenCalled();
    await storage.append(DIRECTORY, 'facts.jsonl', Buffer.from(' '));
    expect(await facts.checkpoint(SCOPE)).toBeUndefined();
    await logs.rewrite(SCOPE, KEY, [fact(2)]);
    expect((await facts.checkpoint(SCOPE))?.generation).not.toBe(expected?.generation);
  });

  it('propagates checkpoint IO failures and cancels a stalled same-source read', async () => {
    logs.append(SCOPE, KEY, fact()); await logs.flush();
    await facts.checkpoint(SCOPE);
    vi.spyOn(logs, 'flush').mockRejectedValueOnce(new Error('checkpoint flush failed'));
    await expect(facts.checkpoint(SCOPE)).rejects.toThrow('checkpoint flush failed');
    vi.spyOn(storage, 'size').mockRejectedValueOnce(new Error('checkpoint stat failed'));
    await expect(facts.checkpoint(SCOPE)).rejects.toThrow('checkpoint stat failed');
    vi.spyOn(model, 'source').mockRejectedValueOnce(new Error('checkpoint head failed'));
    await expect(facts.checkpoint(SCOPE)).rejects.toThrow('checkpoint head failed');
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    vi.spyOn(logs, 'flush').mockImplementationOnce(async () => { enter(); await new Promise<void>((resolve) => { release = resolve; }); });
    const controller = new AbortController();
    const reading = expect(facts.checkpoint(SCOPE, controller.signal)).rejects.toThrow('checkpoint cancelled');
    await entered; controller.abort(new Error('checkpoint cancelled')); await reading; release();
  });

  it('keeps canonical appends moving while an earlier usage publication is blocked', async () => {
    let entered!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const apply = model.apply.bind(model);
    vi.spyOn(model, 'apply').mockImplementationOnce(async (page) => {
      entered();
      await blocked;
      return apply(page);
    });
    const owner = logs.acquire(SCOPE, KEY);
    let flushed = false;
    logs.append(SCOPE, KEY, fact(1));
    const first = logs.flush(SCOPE, KEY).then(() => { flushed = true; });
    await started;
    try {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(flushed).toBe(true);
      logs.append(SCOPE, KEY, fact(2));
      await logs.flush(SCOPE, KEY);
      const controller = new AbortController();
      const reading = facts.read(SCOPE, undefined, controller.signal);
      controller.abort(new Error('usage is still publishing'));
      await expect(reading).rejects.toThrow('usage is still publishing');
    } finally {
      release();
      await first;
      await owner.dispose();
    }
    expect((await facts.read(SCOPE)).records.map((row) => row.time)).toEqual([1, 2]);
  });

  it('drains accepted usage publication before disposing its reader dependency', async () => {
    let entered!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const apply = model.apply.bind(model);
    vi.spyOn(model, 'apply').mockImplementationOnce(async (page) => {
      entered();
      await blocked;
      return apply(page);
    });
    logs.append(SCOPE, KEY, fact(1));
    await logs.flush(SCOPE, KEY);
    await started;
    let disposed = false;
    const disposal = Promise.resolve(ix.dispose()).then(() => { disposed = true; });
    try {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(disposed).toBe(false);
    } finally {
      release();
      await disposal;
    }
    open();
    expect((await facts.read(SCOPE)).records.map((row) => row.time)).toEqual([1]);
  });

  it('writes known, missing and genuine zero occurrences and advances non-usage coverage without wire reads', async () => {
    const read = vi.spyOn(storage, 'readStream');
    const zero = { ...fact(3), usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } };
    for (const value of [fact(1), fact(2, false), zero, { type: 'message', time: 4, text: 'body'.repeat(10000) }]) logs.append(SCOPE, KEY, value);
    await logs.flush();
    const snapshot = await facts.read(SCOPE);
    expect(snapshot.checkpoint).toMatchObject({ generation: 'legacy', offset: await storage.size(SCOPE, KEY), valid: true });
    expect(snapshot.records.map((row) => row.usageKnown)).toEqual([true, false, true]);
    expect(snapshot.records[2]?.usage.output).toBe(0);
    expect((await facts.read(SCOPE, { startAt: 2, endAt: 3 })).records).toEqual([snapshot.records[1]]);
    logs.append(SCOPE, KEY, fact(5)); await logs.flush();
    const wire = (await storage.read(SCOPE, KEY))!;
    expect((await facts.read(SCOPE)).checkpoint?.boundaryHash).toBe(createHash('sha256').update(wire.slice(-4096)).digest('base64url'));
    expect(read.mock.calls.every(([, key]) => key !== KEY)).toBe(true);
  });

  it('atomically replaces a growing managed rewrite even when old boundary bytes are preserved', async () => {
    const padding = { type: 'message', time: 2, text: 'x'.repeat(5000) };
    logs.append(SCOPE, KEY, fact(1)); logs.append(SCOPE, KEY, padding); await logs.flush();
    const before = await facts.read(SCOPE);
    await logs.rewrite(SCOPE, KEY, [fact(9), padding, { type: 'message', time: 3 }]);
    const after = await facts.read(SCOPE);
    expect(after.checkpoint?.generation).not.toBe(before.checkpoint?.generation);
    expect(after.records.map((row) => row.time)).toEqual([9]);
    expect(after.checkpoint?.offset).toBe(await storage.size(SCOPE, KEY));
  });

  it('keeps canonical success and prior coverage after a derived append failure, then fills the missing prefix once', async () => {
    logs.append(SCOPE, KEY, fact(1)); await logs.flush();
    const first = await facts.read(SCOPE);
    const append = storage.append.bind(storage);
    const warnings = vi.spyOn(ix.get(ILogService), 'warn');
    storage.append = async (scope, key, bytes, options) => { if (key === 'facts.jsonl') throw new Error('derived disk unavailable'); await append(scope, key, bytes, options); };
    logs.append(SCOPE, KEY, fact(2)); await expect(logs.flush()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(warnings).toHaveBeenCalledWith('Usage projection pending; canonical source remains recoverable', expect.any(Error)));
    await logs.drainRetirements();
    expect(await storage.size(SCOPE, KEY)).toBeGreaterThan(first.checkpoint!.offset);
    storage.append = append;
    logs.append(SCOPE, KEY, fact(3)); await logs.flush();
    expect((await facts.read(SCOPE)).checkpoint).toEqual(first.checkpoint);
    const wire = (await storage.read(SCOPE, KEY))!;
    const next = { ...checkpoint(wire.length), mtimeMs: (await storage.mtime(SCOPE, KEY))!, boundaryHash: createHash('sha256').update(wire.slice(-4096)).digest('base64url') };
    const tail = [normalizeUsageFact(fact(2), 'main')!, normalizeUsageFact(fact(3), 'main')!];
    await facts.commit(SCOPE, first.checkpoint!.offset, next, tail);
    await facts.commit(SCOPE, first.checkpoint!.offset, next, tail);
    expect((await facts.read(SCOPE)).records.map((row) => row.time)).toEqual([1, 2, 3]);
  });

  it('reopens the typed index and rebuilds a lost database only from unchanged lightweight journals', async () => {
    logs.append(SCOPE, KEY, fact(1)); logs.append(SCOPE, KEY, fact(2, false)); await logs.flush();
    const expected = await facts.read(SCOPE);
    await close(); open();
    const read = vi.spyOn(storage, 'readStream');
    expect(await facts.read(SCOPE)).toEqual(expected); expect(read).not.toHaveBeenCalled();
    await close(); await rm(join(home, 'cache/usage-read-model-v2'), { recursive: true, force: true, maxRetries: 5 }); open();
    expect(await facts.read(SCOPE)).toEqual(expected);
    expect(read.mock.calls.length).toBeGreaterThan(0); expect(read.mock.calls.every(([, key]) => key === 'facts.jsonl')).toBe(true);
  });

  it('preserves duplicate ordinals without claiming coverage across a missing prefix', async () => {
    await storage.write(SCOPE, KEY, Buffer.from('{"type":"old"}\n'));
    logs.append(SCOPE, KEY, fact()); await logs.flush();
    expect(await facts.read(SCOPE)).toEqual({ records: [] });
    const normalized = normalizeUsageFact(fact(), 'main')!;
    await facts.commit(SCOPE, 0, checkpoint((await storage.size(SCOPE, KEY))!), [normalized, normalized]);
    expect((await facts.read(SCOPE)).records).toEqual([normalized, normalized]);
  });

  it('bounds range reads and retains unknown and out-of-range invalid facts', async () => {
    const records = Array.from({ length: 620 }, (_, index) => normalizeUsageFact(fact(index, index % 3 !== 0), 'main')!);
    records.push({ ...records[0]!, time: -1, invalid: true });
    await facts.commit(SCOPE, 0, { ...checkpoint(620), valid: false }, records);
    let cursor: string | undefined;
    const selected = [];
    for (let pass = 0; pass < 10; pass++) {
      const budget = { remainingRecords: 100 };
      const page = await facts.read(SCOPE, { startAt: 0, endAt: 1000 }, undefined, { budget, cursor });
      expect(page.records.length).toBeLessThanOrEqual(100); expect(budget.remainingRecords).toBeGreaterThanOrEqual(0);
      selected.push(...page.records); cursor = page.nextCursor;
      if (page.readComplete !== false) break;
      expect(cursor).toBeDefined();
    }
    expect(cursor).toBeUndefined(); expect(selected).toHaveLength(621);
    expect(selected.filter((row) => row.usageKnown === false)).toHaveLength(208);
    expect(selected.filter((row) => row.invalid)).toHaveLength(1);
  });

  it('freezes paged ordinals across backdated appends and rejects a rewritten generation', async () => {
    for (const value of [fact(1), fact(2, false), fact(3)]) logs.append(SCOPE, KEY, value);
    await logs.flush();
    const first = await facts.read(SCOPE, { startAt: 0, endAt: 10 }, undefined, { pageSize: 0 });
    expect(first.nextCursor).toBeDefined();
    logs.append(SCOPE, KEY, fact(0)); await logs.flush();
    const records = [...first.records]; let cursor = first.nextCursor;
    for (let pass = 0; cursor !== undefined && pass < 5; pass++) {
      const next = await facts.read(SCOPE, { startAt: 0, endAt: 10 }, undefined, { pageSize: 1, cursor });
      expect(next.records.length).toBeLessThanOrEqual(1); expect(next.checkpoint).toEqual(first.checkpoint);
      records.push(...next.records); cursor = next.nextCursor;
    }
    expect(cursor).toBeUndefined(); expect(records.map((record) => record.time)).toEqual([1, 2, 3]);
    expect((await facts.read(SCOPE)).records).toHaveLength(4);
    await logs.rewrite(SCOPE, KEY, [fact(9)]);
    await expect(facts.read(SCOPE, { startAt: 0, endAt: 10 }, undefined, { cursor: first.nextCursor })).rejects.toThrow('Usage fact cursor changed');
  });

  it('resumes journal import across fact budgets and restart without publishing an unfinished envelope', async () => {
    await journal(900);
    const first = await facts.summary(SCOPE, undefined, { budget: { remainingRecords: 100 } });
    expect(first).toEqual({ readComplete: false }); expect((await model.summary(SCOPE)).head?.checkpoint).toBeUndefined();
    const progress = await model.progress(SCOPE); expect(progress?.ordinal).toBeGreaterThan(0);
    await close(); open();
    let complete = false;
    for (let pass = 0; pass < 20; pass++) {
      const budget = { remainingRecords: 100 };
      const result = await facts.summary(SCOPE, undefined, { budget });
      expect(budget.remainingRecords).toBeGreaterThanOrEqual(0);
      if (result.readComplete !== false) { expect(result.totals?.records).toBe(900); complete = true; break; }
    }
    expect(complete).toBe(true); expect((await facts.read(SCOPE)).records).toHaveLength(900);
  });

  it('reconciles a publication whose acknowledgement was lost without counting a retry twice', async () => {
    const apply = model.apply.bind(model);
    vi.spyOn(model, 'apply').mockImplementationOnce(async (page) => { await apply(page); throw new Error('worker acknowledgement lost'); });
    logs.append(SCOPE, KEY, fact(1)); await expect(logs.flush()).resolves.toBeUndefined();
    expect((await facts.read(SCOPE)).records).toHaveLength(1);
    logs.append(SCOPE, KEY, fact(2)); await logs.flush();
    expect((await facts.read(SCOPE)).records.map((row) => row.time)).toEqual([1, 2]);
  });

  it('invalidates a damaged journal and lets canonical recovery replace it instead of trusting old coverage', async () => {
    logs.append(SCOPE, KEY, fact()); await logs.flush();
    await storage.append(DIRECTORY, 'facts.jsonl', Buffer.from('{broken}\n'));
    expect((await facts.summary(SCOPE)).checkpoint).toBeUndefined();
    expect((await model.summary(SCOPE)).totals).toBeUndefined();
    await facts.commit(SCOPE, 0, checkpoint(1), [normalizeUsageFact(fact(), 'main')!]);
    expect((await facts.read(SCOPE)).records).toHaveLength(1);
  });

  it('reserves a shared fact allowance before concurrent source reads', async () => {
    const scopes = [SCOPE, 'sessions/example/session/agents/child'];
    const records = Array.from({ length: 300 }, (_, index) => normalizeUsageFact(fact(index, false), 'main')!);
    for (const source of scopes) await facts.commit(source, 0, checkpoint(300), records);
    const budget = { remainingRecords: 350 };
    const pages = await Promise.all(scopes.map((source) => facts.read(source, undefined, undefined, { budget })));
    expect(pages.reduce((total, page) => total + page.records.length, 0)).toBe(350); expect(budget.remainingRecords).toBe(0);
  });

  it('passes read signals to the typed reader and leaves another read usable after cancellation', async () => {
    logs.append(SCOPE, KEY, fact()); await logs.flush();
    const controller = new AbortController();
    const read = vi.spyOn(model, 'read');
    expect((await facts.read(SCOPE, undefined, controller.signal)).records).toHaveLength(1);
    expect(read.mock.calls[0]?.[4]).toBe(controller.signal);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const source = model.source.bind(model);
    vi.spyOn(model, 'source').mockImplementationOnce(async (...args) => { enter(); await new Promise<void>((resolve) => { release = resolve; }); return source(...args); });
    const reading = facts.read(SCOPE, undefined, controller.signal);
    await entered; controller.abort(); await expect(reading).rejects.toMatchObject({ name: 'AbortError' }); release();
    expect((await facts.read(SCOPE)).records).toHaveLength(1);
  });
});
