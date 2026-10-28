import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IThreadTurnStore, ThreadTurnStore, type ThreadTurnPage } from '#/app/threadCommunication/threadTurnStore';
import { IAppendLogStore, AppendLogCorruptedError } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IQueryStore, type ColumnPageQuery } from '#/persistence/interface/queryStore';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { SqliteQueryStore } from '#/persistence/backends/sqlite/sqliteQueryStore';
import { drainQueryStoreDisposals } from '#/persistence/queryStoreDisposals';
import { ErrorCodes } from '#/errors';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';

const SCOPE = 'sessions/example/session/agents/main';
const KEY = 'wire.jsonl';
const prompt = (text = 'input') => ({ type: 'turn.prompt', input: [{ type: 'text', text }], origin: { kind: 'user' }, time: 10 });
const part = (turnId: number, text: string) => ({ type: 'context.append_loop_event', event: { type: 'content.part', turnId: String(turnId), part: { type: 'text', text } } });
const ended = (turnId: number) => ({ type: 'turn.ended', turnId, reason: 'completed', time: 20 });

describe('ThreadTurnStore', () => {
  let home: string;
  let ix: TestInstantiationService;
  let storage: IFileSystemStorageService;
  let logs: IAppendLogStore;
  let query: IQueryStore;
  let turns: IThreadTurnStore;

  function open(): void {
    ix = new TestInstantiationService();
    ix.stub(IBootstrapService, stubBootstrap(home));
    ix.stub(ILogService, stubLog());
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IQueryStore, new SyncDescriptor(SqliteQueryStore));
    ix.set(IThreadTurnStore, new SyncDescriptor(ThreadTurnStore));
    logs = ix.get(IAppendLogStore);
    query = ix.get(IQueryStore);
    turns = ix.get(IThreadTurnStore);
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'thread-turns-'));
    storage = new FileStorageService(home);
    open();
  });

  async function close(): Promise<void> {
    await logs.close();
    await query.close();
    await ix.dispose();
    await drainQueryStoreDisposals();
  }

  afterEach(async () => {
    await close();
    await storage.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function seed(records: readonly unknown[], scope = SCOPE): Promise<void> {
    for (const record of records) logs.append(scope, KEY, record);
    await logs.flush(scope, KEY);
  }

  async function ready(before = Number.MAX_SAFE_INTEGER, limit = 20, scope = SCOPE): Promise<ThreadTurnPage> {
    let page = await turns.read(scope, before, limit);
    let steps = 0;
    while (page.preparing) {
      expect(page.turns).toEqual([]);
      expect(page.hasMore).toBe(true);
      expect(++steps).toBeLessThan(100);
      page = await turns.read(scope, before, limit, page.source);
    }
    return page;
  }

  it('reads latest and earlier windows from the tail and reuses prepared windows', async () => {
    await seed(Array.from({ length: 1000 }, (_, id) => [{ ...prompt(`input-${id}`), turnId: id }, part(id, `output-${id}`), ended(id)]).flat());
    const info = vi.spyOn(ix.get(ILogService), 'info');
    const first = await ready(Number.MAX_SAFE_INTEGER, 3);
    const phases = info.mock.calls.find(([message]) => message === 'Thread history tail preparation slice')?.[1] as Record<string, number>;
    expect(phases).toEqual({
      records_count: 24,
      source_bytes: expect.any(Number), source_offset: expect.any(Number), source_watermark: expect.any(Number),
      duration_ms: expect.any(Number), scan_duration_ms: expect.any(Number),
      validation_duration_ms: expect.any(Number), projection_commit_duration_ms: expect.any(Number),
    });
    expect(phases['duration_ms']).toBe(phases['scan_duration_ms']! + phases['validation_duration_ms']! + phases['projection_commit_duration_ms']!);
    info.mockRestore();
    expect(first.turns.map((turn) => turn.turnId)).toEqual([997, 998, 999]);
    expect(first.turns[2]).toMatchObject({ input: 'input-999', output: 'output-999', startedAt: 10, endedAt: 20, reason: 'completed', origin: 'user' });
    const read = vi.spyOn(storage, 'readStream');
    const second = await turns.read(SCOPE, 997, 3, first.source);
    expect(second.turns.map((turn) => turn.turnId)).toEqual([994, 995, 996]);
    const ranges = read.mock.calls.filter(([, key]) => key === KEY).map(([, , range]) => range);
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every((range) => range !== undefined && range.end - range.start < 65_536)).toBe(true);
    expect(ranges.some((range) => range?.start === 0)).toBe(false);
    read.mockClear();
    expect((await turns.read(SCOPE, 997, 3, first.source)).turns).toEqual(second.turns);
    expect(read.mock.calls.filter(([, key]) => key === KEY).every(([, , range]) => range !== undefined && range.end - range.start < 1024)).toBe(true);
    read.mockRestore();
  });

  it('cancels the actual indexed turn page and leaves a later read usable', async () => {
    await seed([prompt(), part(0, 'output'), ended(0)]);
    const first = await ready();
    const controller = new AbortController();
    const select = query.pageByColumn.bind(query);
    const page = vi.spyOn(query, 'pageByColumn').mockImplementationOnce(<T>(collection: string, selection: ColumnPageQuery, signal?: AbortSignal) => {
      const reading = select<T>(collection, selection, signal);
      queueMicrotask(() => controller.abort());
      return reading;
    });
    await expect(turns.read(SCOPE, Number.MAX_SAFE_INTEGER, 20, first.source, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(page.mock.calls[0]?.[2]).toBe(controller.signal);
    expect((await turns.read(SCOPE, Number.MAX_SAFE_INTEGER, 20, first.source)).turns).toEqual(first.turns);
  });

  it('isolates latest and earlier turn pages across scopes with overlapping turn ids', async () => {
    const other = 'sessions/example/session/agents/other';
    await seed(Array.from({ length: 4 }, (_, id) => [prompt(`other input-${id}`), part(id, `other output-${id}`), ended(id)]).flat(), other);
    const otherFirst = await ready(Number.MAX_SAFE_INTEGER, 2, other);
    expect(otherFirst.turns.map((turn) => turn.turnId)).toEqual([2, 3]);

    await seed(Array.from({ length: 4 }, (_, id) => [prompt(`target input-${id}`), part(id, `target output-${id}`), ended(id)]).flat());
    const first = await ready(Number.MAX_SAFE_INTEGER, 2);
    expect(first.turns.map((turn) => [turn.turnId, turn.input, turn.output])).toEqual([
      [2, 'target input-2', 'target output-2'],
      [3, 'target input-3', 'target output-3'],
    ]);
    expect(first.hasMore).toBe(true);
    const second = await turns.read(SCOPE, 2, 2, first.source);
    expect(second.turns.map((turn) => [turn.turnId, turn.input, turn.output])).toEqual([
      [0, 'target input-0', 'target output-0'],
      [1, 'target input-1', 'target output-1'],
    ]);
    expect(second.hasMore).toBe(false);
    const otherSecond = await turns.read(other, 2, 2, otherFirst.source);
    expect(otherSecond.turns.map((turn) => [turn.turnId, turn.input, turn.output])).toEqual([
      [0, 'other input-0', 'other output-0'],
      [1, 'other input-1', 'other output-1'],
    ]);
    expect(otherSecond.hasMore).toBe(false);
    expect((await turns.read(other, Number.MAX_SAFE_INTEGER, 2, otherFirst.source)).turns).toEqual(otherFirst.turns);
  });

  it('resumes bounded preparation after cold reopen, pins append watermarks and invalidates rewrite cursors', async () => {
    await seed([{ ...prompt(), turnId: 0 }, ...Array.from({ length: 700 }, () => part(0, 'x'.repeat(16_000))), ended(0)]);
    const first = await turns.read(SCOPE, Number.MAX_SAFE_INTEGER, 2);
    expect(first).toMatchObject({ turns: [], preparing: true, hasMore: true });
    const collection = `thread-turns-v1:${Buffer.from(SCOPE).toString('base64url')}`;
    const checkpoint = await query.get<{ offset: number }>(collection, `tail:${first.source.watermark}`);
    expect(checkpoint!.offset).toBeLessThan(first.source.watermark);
    expect(first.source.watermark - checkpoint!.offset).toBeLessThanOrEqual(4 * 1024 * 1024 + 17_000);
    await close();
    open();
    await seed([{ ...prompt('new input'), turnId: 1 }, part(1, 'new output'), ended(1)]);
    let page = await turns.read(SCOPE, Number.MAX_SAFE_INTEGER, 2, first.source);
    while (page.preparing) page = await turns.read(SCOPE, Number.MAX_SAFE_INTEGER, 2, page.source);
    expect(page.turns.map((turn) => turn.turnId)).toEqual([0]);
    expect((await ready()).turns.map((turn) => turn.turnId)).toEqual([0, 1]);
    await logs.rewrite(SCOPE, KEY, [prompt('replacement'), ended(0)]);
    await expect(turns.read(SCOPE, Number.MAX_SAFE_INTEGER, 2, first.source)).rejects.toMatchObject({ code: ErrorCodes.THREAD_CURSOR_INVALID });
    expect((await ready()).turns[0]?.input).toBe('replacement');
  });

  it('returns every byte of a greater-than-10MiB turn through bounded text segments', async () => {
    const text = ('a'.repeat(4094) + '😀').repeat(2817);
    expect(Buffer.byteLength(text)).toBeGreaterThan(10 * 1024 * 1024);
    await seed([{ ...prompt(), turnId: 0 }, part(0, text), ended(0)]);
    const first = await turns.read(SCOPE, Number.MAX_SAFE_INTEGER, 1);
    expect(first.preparing).toBe(true);
    expect(first.turns).toEqual([]);
    let page = await turns.read(SCOPE, Number.MAX_SAFE_INTEGER, 1, first.source);
    let slices = 1;
    while (page.preparing) {
      expect(++slices).toBeLessThanOrEqual(5);
      page = await turns.read(SCOPE, Number.MAX_SAFE_INTEGER, 1, page.source);
    }
    const turn = page.turns[0]!;
    const pieces = [turn.output];
    let ref = turn.contentRefs?.find((value) => value.path[0] === 'output');
    expect(ref).toBeDefined();
    const read = vi.spyOn(storage, 'readStream');
    while (ref !== undefined) {
      const segment = await turns.content(SCOPE, ref);
      expect(typeof segment.value).toBe('string');
      const value = segment.value as string;
      expect(value.length).toBeLessThanOrEqual(16_384);
      expect(value.length).toBeGreaterThan(0);
      expect(/[\uD800-\uDBFF]$/u.test(value)).toBe(false);
      pieces.push(value);
      ref = segment.next;
    }
    expect(pieces.join('')).toBe(text);
    expect(read.mock.calls.filter(([, key]) => key === KEY).every(([, , range]) => range !== undefined && range.end - range.start < 1024)).toBe(true);
    read.mockRestore();
    await expect(turns.content('sessions/other/agents/main', turn.contentRefs![0]!)).rejects.toMatchObject({ code: ErrorCodes.THREAD_CURSOR_INVALID });
  }, 30_000);

  it('keeps sealed journals and complete turns available after cold reopen', async () => {
    await seed([prompt('sealed input'), part(0, 'sealed output'), ended(0)]);
    await logs.sealCold(SCOPE, KEY, (await storage.size(SCOPE, KEY))!);
    const first = await ready();
    await close();
    open();
    const next = await turns.read(SCOPE, Number.MAX_SAFE_INTEGER, 20, first.source);
    expect(next.turns).toEqual(first.turns);
  });

  it('does not publish unfinished turns, and resumes a torn trailing record when appended', async () => {
    await seed([prompt(), part(0, 'unfinished')]);
    expect((await ready()).turns).toEqual([]);
    const terminal = JSON.stringify(ended(0));
    await storage.append(SCOPE, KEY, Buffer.from(terminal.slice(0, 20)));
    expect((await ready()).turns).toEqual([]);
    await storage.append(SCOPE, KEY, Buffer.from(terminal.slice(20) + '\n'));
    expect((await ready()).turns[0]?.output).toBe('unfinished');
  });

  it('propagates read errors and cancellation without publishing a partial projection', async () => {
    await seed([prompt(), part(0, 'answer'), ended(0)]);
    const original = storage.readStream.bind(storage);
    storage.readStream = async function* (scope, key, range, options) {
      if (key === KEY && range?.start === 0) throw new Error('fixture I/O failed');
      yield* original(scope, key, range, options);
    };
    await expect(ready()).rejects.toThrow('fixture I/O failed');
    storage.readStream = original;
    const controller = new AbortController();
    storage.readStream = async function* (scope, key, range, options) {
      for await (const chunk of original(scope, key, range, options)) {
        if (key === KEY && range?.start === 0) controller.abort(new Error('fixture cancelled'));
        yield chunk;
      }
    };
    await expect(turns.read(SCOPE, Number.MAX_SAFE_INTEGER, 1, undefined, controller.signal)).rejects.toThrow('fixture cancelled');
    storage.readStream = original;
    expect((await ready()).turns[0]?.output).toBe('answer');
  });

  it('delivers a cold latest window without touching a large older prefix', async () => {
    await seed([
      ...Array.from({ length: 1000 }, () => ({ type: 'fixture.padding', text: 'x'.repeat(8000) })),
      ...Array.from({ length: 10 }, (_, id) => [{ ...prompt(`input-${id}`), turnId: id + 50 }, part(id + 50, `output-${id}`), ended(id + 50)]).flat(),
    ]);
    const read = vi.spyOn(storage, 'readStream');
    const first = await turns.read(SCOPE, Number.MAX_SAFE_INTEGER, 3);
    expect(first.preparing).toBe(false);
    expect(first.turns.map((turn) => turn.turnId)).toEqual([57, 58, 59]);
    expect(first.hasMore).toBe(true);
    const ranges = read.mock.calls.filter(([, key]) => key === KEY).map(([, , range]) => range);
    expect(ranges.every((range) => range !== undefined && range.start > 7_900_000)).toBe(true);
    expect(ranges.reduce((sum, range) => sum + (range!.end - range!.start + 1), 0)).toBeLessThan(400_000);
    await close();
    open();
    await seed([{ ...prompt('later'), turnId: 60 }, part(60, 'later output'), ended(60)]);
    const older = await turns.read(SCOPE, 57, 3, first.source);
    expect(older.turns.map((turn) => turn.turnId)).toEqual([54, 55, 56]);
    expect((await turns.read(SCOPE, Number.MAX_SAFE_INTEGER, 3)).turns.map((turn) => turn.turnId)).toEqual([58, 59, 60]);
    read.mockRestore();
  });

  it('retains implicit ids, cancellation gaps and explicit ids in tail windows', async () => {
    await seed([
      prompt('first'), part(0, 'zero'), ended(0),
      { type: 'turn.cancel', target: 'queued', turnId: 1 },
      prompt('after cancellation'), part(2, 'two'), ended(2),
      { ...prompt('explicit'), turnId: 10 }, part(10, 'ten'), ended(10),
    ]);
    const page = await ready();
    expect(page.turns.map((turn) => [turn.turnId, turn.input, turn.output])).toEqual([
      [0, 'first', 'zero'], [2, 'after cancellation', 'two'], [10, 'explicit', 'ten'],
    ]);
  });

  it('uses forward preparation for interleaved turns instead of pairing unrelated prompt and terminal records', async () => {
    await seed([
      { ...prompt('first'), turnId: 0 }, part(0, 'zero'),
      { ...prompt('second'), turnId: 1 }, part(1, 'one'), ended(0), ended(1),
    ]);
    const page = await ready();
    expect(page.turns.map((turn) => [turn.turnId, turn.input, turn.output])).toEqual([[0, 'first', 'zero'], [1, 'second', 'one']]);
  });

  it('rejects implicit interleaving and preserves earlier cursors after forward fallback and a new tail', async () => {
    await seed([prompt('first'), prompt('second'), part(0, 'zero'), ended(0)]);
    const page = await ready(Number.MAX_SAFE_INTEGER, 1);
    expect(page.turns.map((turn) => [turn.turnId, turn.input, turn.output])).toEqual([[0, 'first', 'zero']]);
    await seed([{ ...prompt('third'), turnId: 2 }, part(2, 'two'), ended(2)]);
    expect((await ready(Number.MAX_SAFE_INTEGER, 1)).turns.map((turn) => turn.turnId)).toEqual([2]);
    expect((await turns.read(SCOPE, Number.MAX_SAFE_INTEGER, 1, page.source)).turns).toEqual(page.turns);
  });

  it('does not infer prompt ids from a chain of interleaved legacy terminal records', async () => {
    await seed([
      prompt('first'), prompt('second'), part(0, 'zero'), ended(0),
      prompt('third'), part(1, 'one'), ended(1),
      prompt('fourth'), part(2, 'two'), ended(2),
    ]);
    const page = await ready(Number.MAX_SAFE_INTEGER, 1);
    expect(page.turns.map((turn) => [turn.turnId, turn.input, turn.output])).toEqual([[2, 'third', 'two']]);
    expect(page.hasMore).toBe(true);
    const older = await turns.read(SCOPE, 2, 2, page.source);
    expect(older.turns.map((turn) => [turn.turnId, turn.input, turn.output])).toEqual([[0, 'first', 'zero'], [1, 'second', 'one']]);
  });

  it('keeps only four tail checkpoints while older pinned cursors remain usable', async () => {
    const sources = [];
    for (let id = 0; id < 7; id++) {
      await seed([{ ...prompt(`input-${id}`), turnId: id }, part(id, `output-${id}`), ended(id)]);
      sources.push((await ready(Number.MAX_SAFE_INTEGER, 1)).source);
    }
    const collection = `thread-turns-v1:${Buffer.from(SCOPE).toString('base64url')}`;
    expect((await query.listKeys(collection)).filter((key) => key.startsWith('tail:'))).toHaveLength(4);
    const page = await turns.read(SCOPE, Number.MAX_SAFE_INTEGER, 1, sources[0]);
    expect(page.turns.map((turn) => turn.turnId)).toEqual([0]);
  });

  it('reports malformed complete records instead of returning an empty complete page', async () => {
    await storage.write(SCOPE, KEY, Buffer.from('{"type": invalid}\n'));
    await expect(ready()).rejects.toBeInstanceOf(AppendLogCorruptedError);
  });
});
