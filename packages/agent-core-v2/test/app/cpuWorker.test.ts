import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CpuWorkerPool } from '#/app/cpuWorker/host';
import { runCpuStream } from '#/app/cpuWorker/stream';
import { reduceContextTranscript } from '#/agent/contextMemory/contextTranscript';
import { estimateTokensForMessages } from '#/kosong/contract/tokens';
import type { WireContextProjection } from '#/agent/contextMemory/wireContextProjection';
import { deserialize } from 'node:v8';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { sealColdSegments } from '#/persistence/coldSegmentLog';
import { readWireContextProjection } from '#/persistence/wireContextRead';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { WireRecord } from '#/wire/record';
import type { FileLineRangeOperation } from '#/app/cpuWorker/tasks';
import type { WorkspacePathInventory } from '#/os/backends/node-local/workspacePathInventory';

const pools: CpuWorkerPool[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function pool(options: ConstructorParameters<typeof CpuWorkerPool>[1] = {}): Promise<CpuWorkerPool> {
  const dir = await mkdtemp(join(tmpdir(), 'cpu-pool-test-'));
  dirs.push(dir);
  const entry = join(dir, 'entry.mjs');
  await writeFile(entry, `import {parentPort,threadId} from 'node:worker_threads';
parentPort.on('message',({id,operation,cancellation})=>{
  if(operation.type==='crash')process.exit(17);
  if(operation.type==='spin')while(true){}
  if(operation.type==='coop'){
    const view=new Int32Array(cancellation);
    const deadline=Date.now()+operation.ms;
    const tick=()=>{
      if(Atomics.load(view,0)!==0){parentPort.postMessage({id,cancelled:true});return;}
      if(Date.now()>=deadline){parentPort.postMessage({id,result:threadId});return;}
      setTimeout(tick,2);
    };
    tick();
    return;
  }
  if(operation.type==='delay')setTimeout(()=>parentPort.postMessage({id,result:threadId}),operation.ms);
  else parentPort.postMessage({id,result:operation.bytes??operation});
});`);
  const value = new CpuWorkerPool(pathToFileURL(entry), options);
  pools.push(value);
  return value;
}

describe('CPU worker pool', () => {
  it('caps parallelism and transfers owned buffers without copying caller state', async () => {
    const workers = await pool({ maxWorkers: 2 });
    expect(workers.size).toBe(Math.max(1, Math.min(availableParallelism() - 1, 2)));
    const bytes = Uint8Array.from([0, 127, 255]).buffer;
    const result = workers.request<ArrayBuffer>({ bytes }, { transferList: [bytes] });
    expect(bytes.byteLength).toBe(0);
    expect([...new Uint8Array(await result)]).toEqual([0, 127, 255]);
    if (workers.size > 1) {
      const ids = await Promise.all([workers.request({type:'delay',ms:30}), workers.request({type:'delay',ms:30})]);
      expect(new Set(ids).size).toBe(2);
    }
  });

  it('bounds waiting count and bytes, and cancels a queued request without detaching it', async () => {
    const workers = await pool({ maxWorkers: 1, maxQueue: 1, maxQueuedBytes: 8 });
    const active = workers.request({type:'delay',ms:100});
    const controller = new AbortController();
    const bytes = new ArrayBuffer(8);
    const waiting = workers.request({bytes}, {transferList:[bytes], signal:controller.signal});
    const rejected = expect(waiting).rejects.toThrow('cancel waiting');
    await expect(workers.request({})).rejects.toMatchObject({code:'CPU_QUEUE_FULL'});
    controller.abort(new Error('cancel waiting'));
    await rejected;
    expect(bytes.byteLength).toBe(8);
    await expect(workers.request({}, {bytes:9})).rejects.toMatchObject({code:'CPU_QUEUE_FULL'});
    await active;
    await expect(workers.request('after')).resolves.toBe('after');
  });

  it('terminates uncooperative timeout work after grace watchdog and restarts for the queued task', async () => {
    const workers = await pool({ maxWorkers: 1, cancelGraceMs: 120 });
    const active = workers.request({type:'spin'}, {timeoutMs:100});
    const failure = expect(active).rejects.toMatchObject({code:'CPU_TIMEOUT'});
    const waiting = workers.request('survives timeout');
    await failure;
    await expect(waiting).resolves.toBe('survives timeout');
  });

  it('reuses the same warm worker on cooperative cancellation without terminating it', async () => {
    const workers = await pool({ maxWorkers: 1, cancelGraceMs: 5_000 });
    const firstThreadId = await workers.request<number>({ type: 'delay', ms: 5 });
    const controller = new AbortController();
    const active = workers.request<number>({ type: 'coop', ms: 2_000 }, { signal: controller.signal });
    const failure = expect(active).rejects.toThrow('cooperative cancel');
    const startedAt = Date.now();
    controller.abort(new Error('cooperative cancel'));
    await failure;
    expect(Date.now() - startedAt).toBeLessThan(200);
    const secondThreadId = await workers.request<number>({ type: 'delay', ms: 5 });
    expect(secondThreadId).toBe(firstThreadId);
  });

  it('detaches a slow cancelled worker past grace without mid-call terminate, serves replacement work, and retires cleanly on completion', async () => {
    const workers = await pool({ maxWorkers: 1, cancelGraceMs: 40 });
    const firstThreadId = await workers.request<number>({ type: 'delay', ms: 5 });
    const controller = new AbortController();
    const active = workers.request<number>({ type: 'delay', ms: 160 }, { signal: controller.signal });
    const cancelled = expect(active).rejects.toThrow('slow cancel');
    controller.abort(new Error('slow cancel'));
    await cancelled;
    const replacementThreadId = await workers.request<number>({ type: 'delay', ms: 5 });
    expect(replacementThreadId).not.toBe(firstThreadId);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    expect(workers.liveWorkerCount).toBe(1);
  });

  it('recovers from worker death and running cancellation without replaying failed work', async () => {
    const workers = await pool({ maxWorkers: 1, cancelGraceMs: 120 });
    await expect(workers.request({type:'crash'})).rejects.toMatchObject({code:'CPU_WORKER_EXIT'});
    await expect(workers.request('after crash')).resolves.toBe('after crash');
    const controller = new AbortController();
    const active = workers.request({type:'spin'}, {signal:controller.signal});
    const failure = expect(active).rejects.toThrow('cancel active');
    controller.abort(new Error('cancel active'));
    await failure;
    await expect(workers.request('after cancel')).resolves.toBe('after cancel');
    await workers.close();
    await expect(workers.request({})).rejects.toMatchObject({code:'CPU_POOL_CLOSED'});
  });

  it('scales surplus idle worker isolates back down to 1 warm worker after idle timeout without terminating active work', async () => {
    const workers = await pool({ maxWorkers: 3, idleTimeoutMs: 50 });
    expect(workers.liveWorkerCount).toBe(0);
    if (workers.size > 1) {
      const burstIds = await Promise.all(
        Array.from({ length: workers.size }, () => workers.request<number>({ type: 'delay', ms: 40 })),
      );
      expect(new Set(burstIds).size).toBe(workers.size);
      expect(workers.liveWorkerCount).toBe(workers.size);

      const longRunning = workers.request<number>({ type: 'delay', ms: 140 });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 90));
      expect(workers.liveWorkerCount).toBe(1);
      const survivorId = await longRunning;

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 90));
      expect(workers.liveWorkerCount).toBe(1);
      expect(await workers.request<number>({ type: 'delay', ms: 5 })).toBe(survivorId);

      const secondBurst = await Promise.all(
        Array.from({ length: workers.size }, () => workers.request<number>({ type: 'delay', ms: 35 })),
      );
      expect(new Set(secondBurst).size).toBe(workers.size);
    } else {
      await workers.request({ type: 'delay', ms: 10 });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 90));
      expect(workers.liveWorkerCount).toBe(1);
    }
  });

  it('caps concurrent low-priority work at max(1, floor(W/2)) and lets normal tasks run while low tasks saturate their cap', async () => {
    const requestedMaxWorkers = Math.min(4, Math.max(1, availableParallelism() - 1));
    const workers = await pool({ maxWorkers: requestedMaxWorkers });
    const expectedCap = workers.size > 1 ? Math.max(1, Math.floor(workers.size / 2)) : 1;
    expect(workers.maxLowConcurrency).toBe(expectedCap);

    if (workers.size > 1) {
      const lowIds = await Promise.all(
        Array.from({ length: expectedCap + 2 }, () => workers.request<number>({ type: 'delay', ms: 80 }, { priority: 'low' })),
      );
      expect(new Set(lowIds).size).toBeLessThanOrEqual(expectedCap);

      const activeLow = Array.from(
        { length: expectedCap + 2 },
        () => workers.request<number>({ type: 'delay', ms: 200 }, { priority: 'low' }),
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      const normalStartedAt = Date.now();
      const normalResult = await workers.request<number>({ type: 'delay', ms: 10 }, { priority: 'normal' });
      const normalElapsed = Date.now() - normalStartedAt;
      expect(typeof normalResult).toBe('number');
      expect(normalElapsed).toBeLessThan(160);
      await Promise.all(activeLow);
    }

    const single = await pool({ maxWorkers: 1 });
    expect(single.maxLowConcurrency).toBe(1);
    const order: string[] = [];
    const holder = single.request({ type: 'delay', ms: 60 }, { priority: 'low' });
    const lowQueued = single.request('low', { priority: 'low' }).then((v) => { order.push(String(v)); });
    const normalQueued = single.request('normal', { priority: 'normal' }).then((v) => { order.push(String(v)); });
    const highQueued = single.request('high', { priority: 'high' }).then((v) => { order.push(String(v)); });
    await Promise.all([holder, lowQueued, normalQueued, highQueued]);
    expect(order).toEqual(['high', 'normal', 'low']);
  });
});

function productionPool(): CpuWorkerPool {
  const workers = new CpuWorkerPool(new URL('../../src/app/cpuWorker/bootstrap.mjs', import.meta.url), { maxWorkers: 1 });
  pools.push(workers);
  return workers;
}

const flushedLogs = { flush: async () => {} } as IAppendLogStore;
const message = (text: string): WireRecord => ({ type: 'context.append_message', message: {
  role: 'user', content: [{ type: 'text', text }], toolCalls: [],
} });

describe('CPU wire projection', () => {
  it('preserves transcript, permission and plan across byte splits, CRLF, blank lines and a truncated tail', async () => {
    const records: WireRecord[] = [
      message('开头'),
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'step-1' } },
      { type: 'context.append_loop_event', event: { type: 'content.part', stepUuid: 'step-1', part: { type: 'text', text: 'answer' } } },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-1' } },
      { type: 'permission.set_mode', mode: 'yolo' },
      { type: 'plan_mode.enter', id: 'plan-1' },
      message('undo me'), { type: 'context.undo', count: 1 },
      message('后续'.repeat(300_000)),
    ];
    const bytes = Buffer.from(`\r\n${records.map((record) => JSON.stringify(record)).join('\r\n')}\r\n{"type":`);
    const workers = productionPool();
    const result = await runCpuStream<ArrayBuffer>(workers.request.bind(workers), { type: 'wire.context', scope: 'test', key: 'wire.jsonl' },
      async function* () {
        yield bytes.subarray(0, 9);
        yield bytes.subarray(9);
      });
    const transcript = reduceContextTranscript(records);
    const estimated = estimateTokensForMessages(transcript.logicalEntries);
    expect(deserialize(Buffer.from(result))).toEqual({ transcript, permissionMode: 'yolo', permissionConfigured: true,
      planActive: true, runtimeBinding: undefined, contextTokens: { measured: 0, estimated, 'measured+estimated': estimated } });
  });

  it('reads logical sealed bytes and reports the same corruption location as append-log replay', async () => {
    const workers = productionPool();
    const storage = new InMemoryStorageService();
    const records = [message('sealed'), { type: 'plan_mode.enter', id: 'p' }, { type: 'plan_mode.exit' }, message('tail')];
    const bytes = Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    await storage.write('test', 'wire.jsonl', bytes);
    await sealColdSegments(storage, 'test', 'wire.jsonl', bytes.length, { segmentBytes: 31 });
    const result = await readWireContextProjection(workers.request.bind(workers), flushedLogs, storage, 'test', 'wire.jsonl');
    const transcript = reduceContextTranscript(records);
    const estimated = estimateTokensForMessages(transcript.logicalEntries);
    expect(result).toEqual({ transcript, permissionMode: 'auto', permissionConfigured: false,
      planActive: false, runtimeBinding: undefined, contextTokens: { measured: 0, estimated, 'measured+estimated': estimated } });
    await storage.write('bad', 'wire.jsonl', Buffer.from(`${JSON.stringify(message('valid'))}\n\ninvalid\n`));
    await expect(readWireContextProjection(workers.request.bind(workers), flushedLogs, storage, 'bad', 'wire.jsonl'))
      .rejects.toMatchObject({ code: 'storage.corrupted', details: { scope: 'bad', key: 'wire.jsonl', lineNumber: 3 } });
    const missing = await readWireContextProjection(workers.request.bind(workers), flushedLogs, storage, 'missing', 'wire.jsonl');
    expect(missing.transcript.entries).toEqual([]);
  });

  it('cancels a pending flush without waiting for the shared flush to finish', async () => {
    const controller = new AbortController();
    let finish!: () => void;
    const logs = { flush: () => new Promise<void>((resolve) => { finish = resolve; }) } as IAppendLogStore;
    const workers = productionPool();
    const pending = readWireContextProjection(workers.request.bind(workers), logs, new InMemoryStorageService(), 'test', 'wire', controller.signal);
    const failure = expect(pending).rejects.toThrow('cancel flush');
    controller.abort(new Error('cancel flush'));
    await failure;
    finish();
  });

  it('aborts and closes a waiting byte source on worker timeout, then opens a replacement', async () => {
    const workers = productionPool();
    await workers.request({ type: 'image.decode', bytes: new ArrayBuffer(0), mimeType: 'image/png' });
    let closed = false;
    let sourceSignal: AbortSignal | undefined;
    const pending = runCpuStream<ArrayBuffer>((operation, options) => workers.request(operation, { ...options, timeoutMs: 100 }),
      { type: 'wire.context', scope: 'test', key: 'wire' }, async function* (signal) {
        sourceSignal = signal;
        try {
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
          });
          yield new Uint8Array();
        } finally { closed = true; }
      });
    await expect(pending).rejects.toMatchObject({ code: 'CPU_TIMEOUT' });
    expect(sourceSignal?.aborted).toBe(true);
    expect(closed).toBe(true);
    const result = await runCpuStream<ArrayBuffer>(workers.request.bind(workers), { type: 'wire.context', scope: 'test', key: 'wire' },
      async function* () { yield Buffer.from(JSON.stringify(message('replacement'))); });
    expect((deserialize(Buffer.from(result)) as WireContextProjection).transcript.entries).toHaveLength(1);
  }, 15_000);
});

describe('CPU file line ranges', () => {
  async function fixture(name: string, bytes: string | Buffer): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'cpu-file-range-'));
    dirs.push(dir);
    const path = join(dir, name);
    await writeFile(path, bytes);
    return path;
  }

  function read(workers: CpuWorkerPool, path: string, options: FileLineRangeOperation['options']): Promise<string[]> {
    return workers.request<string[]>({ type: 'file.lineRange', path, options } satisfies FileLineRangeOperation);
  }

  it('uses sparse checkpoints for repeated high-offset windows and invalidates them after a rewrite', async () => {
    const workers = productionPool();
    const lines = Array.from({ length: 6000 }, (_, index) => `${index}: ${'数据'.repeat(180)}\r\n`);
    const path = await fixture('large.txt', lines.join(''));
    for (const startLine of [4300, 5500, 4300]) {
      expect(await read(workers, path, { startLine, maxLines: 4 })).toEqual(lines.slice(startLine - 1, startLine + 3));
    }
    const changed = lines.map((line) => `rewritten ${line}`);
    await writeFile(path, changed.join(''));
    expect(await read(workers, path, { startLine: 4300, maxLines: 4 })).toEqual(changed.slice(4299, 4303));
    expect(await read(workers, path, { startLine: 8000, maxLines: 4 })).toEqual([]);
  });

  it('scans newline bytes without decoding skipped prefixes and preserves window terminators and BOMs', async () => {
    const workers = productionPool();
    const path = await fixture('window.txt', Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 0xff), Buffer.from('\r\n\uFEFF窗口\r\nlast')]));
    expect(await read(workers, path, { startLine: 2, maxLines: 2, errors: 'strict' })).toEqual(['\uFEFF窗口\r\n', 'last']);
    expect(await read(workers, path, { startLine: 2, maxLines: 0 })).toEqual([]);
    const utf16 = await fixture('utf16.txt', Buffer.from('\uFEFFfirst\r\n第二\nlast', 'utf16le'));
    expect(await read(workers, utf16, { startLine: 2, maxLines: 2, encoding: 'utf16le' })).toEqual(['第二\n', 'last']);
  });

  it('preserves decoder modes and coded filesystem failures across the worker boundary', async () => {
    const workers = productionPool();
    const path = await fixture('invalid.txt', Buffer.from([0x61, 0xff, 0x0a]));
    expect(await read(workers, path, { startLine: 1, maxLines: 1, errors: 'replace' })).toEqual(['a\uFFFD\n']);
    expect(await read(workers, path, { startLine: 1, maxLines: 1, errors: 'ignore' })).toEqual(['a\n']);
    await expect(read(workers, path, { startLine: 1, maxLines: 1, errors: 'strict' })).rejects.toMatchObject({ code: 'os.fs.unknown' });
    const missing = `${path}.missing`;
    await expect(read(workers, missing, { startLine: 1, maxLines: 1 })).rejects.toMatchObject({
      code: 'os.fs.not_found', details: { path: missing, op: 'read', errno: 'ENOENT' },
    });
  });

  it('keeps signal host-side, cancels active file work and serves the next request on a replacement', async () => {
    const workers = productionPool();
    const path = await fixture('cancel.txt', 'first\nsecond\n');
    const operation: FileLineRangeOperation = { type: 'file.lineRange', path, options: { startLine: 2, maxLines: 1 } };
    const aborted = new AbortController();
    const reason = new Error('cancel file range');
    aborted.abort(reason);
    await expect(workers.request(operation, { signal: aborted.signal })).rejects.toBe(reason);
    await read(workers, path, operation.options);
    const controller = new AbortController();
    const pending = workers.request(operation, { signal: controller.signal });
    const failure = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await failure;
    expect(await read(workers, path, operation.options)).toEqual(['second\n']);
    expect(operation.options).not.toHaveProperty('signal');
  }, 15_000);
});

describe('CPU cooperative abort stress regression', () => {
  it('survives 90 rapid concurrent abort cycles across workspacePathInventory and workspaceTrigramStore without crashing or locking SQLite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpu-abort-stress-'));
    dirs.push(root);
    const repo = join(root, 'repo');
    const dbPath = join(root, 'cache', 'trigram.sqlite');
    await mkdir(repo, { recursive: true });
    for (let dirIdx = 0; dirIdx < 20; dirIdx += 1) {
      const sub = join(repo, `dir-${dirIdx}`);
      await mkdir(sub, { recursive: true });
      await Promise.all(
        Array.from({ length: 20 }, (_, fileIdx) =>
          writeFile(
            join(sub, `file-${fileIdx}.ts`),
            dirIdx === 7 && fileIdx === 13
              ? 'export const goldenStressNeedle = "ok";\n'
              : `export const item_${dirIdx}_${fileIdx} = "${'payload-'.repeat(32)}";\n`,
          )),
      );
    }

    const workers = new CpuWorkerPool(new URL('../../src/app/cpuWorker/bootstrap.mjs', import.meta.url), {
      maxWorkers: Math.min(2, Math.max(1, availableParallelism() - 1)),
    });
    pools.push(workers);

    const baseline = await workers.request<WorkspacePathInventory>({ type: 'workspace.paths', root: repo, limit: 10_000 });
    expect(baseline.overflow).toBe(false);
    const fileEntries = baseline.entries.filter((entry) => entry.kind === 'file');
    expect(fileEntries.length).toBe(400);

    await workers.request({ type: 'workspace.trigram.begin', path: dbPath, epoch: 'stress-epoch', owner: 'stress-test-owner' });

    const iterations = 90;
    for (let i = 0; i < iterations; i += 1) {
      const invController = new AbortController();
      const triController = new AbortController();
      const invDelayMs = 1 + (i % 10);
      const triDelayMs = 1 + ((i * 7) % 10);
      const invTimer = setTimeout(() => { invController.abort(new Error(`abort-inv-${i}`)); }, invDelayMs);
      const triTimer = setTimeout(() => { triController.abort(new Error(`abort-tri-${i}`)); }, triDelayMs);
      const invPromise = workers.request<WorkspacePathInventory>(
        { type: 'workspace.paths', root: repo, limit: 10_000 },
        { signal: invController.signal },
      );
      const triPromise = workers.request<boolean | undefined>(
        { type: 'workspace.trigram.update', path: dbPath, epoch: 'stress-epoch', root: repo, entries: fileEntries },
        { signal: triController.signal },
      );
      await Promise.allSettled([invPromise, triPromise]);
      clearTimeout(invTimer);
      clearTimeout(triTimer);
    }

    const afterInventory = await workers.request<WorkspacePathInventory>({ type: 'workspace.paths', root: repo, limit: 10_000 });
    expect(afterInventory.overflow).toBe(false);
    expect(afterInventory.entries.filter((entry) => entry.kind === 'file').length).toBe(400);

    await workers.request({ type: 'workspace.trigram.begin', path: dbPath, epoch: 'final-epoch', owner: 'stress-test-owner' });
    expect(await workers.request<boolean | undefined>({
      type: 'workspace.trigram.update',
      path: dbPath,
      epoch: 'final-epoch',
      root: repo,
      entries: fileEntries,
    })).toBe(true);
    expect(await workers.request<boolean | undefined>({ type: 'workspace.trigram.finish', path: dbPath, epoch: 'final-epoch' })).toBe(true);
    const candidates = await workers.request<readonly string[] | undefined>({
      type: 'workspace.trigram.query',
      path: dbPath,
      epoch: 'final-epoch',
      literal: 'goldenStressNeedle',
      insensitive: false,
      limit: 50,
    });
    expect(candidates).toContain('dir-7/file-13.ts');

    await workers.close();
  }, 60_000);
});

describe('CPU worker image operations', () => {
  const ONE_BY_ONE_PNG = Uint8Array.from(
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  );

  it('executes image.crop, image.normalizeAvatar, image.dimensions, and image.toPng in the worker and honors AbortSignal', async () => {
    const { cropImageForModel, normalizeAvatarImage, readAvatarDimensions, encodeImageAsPng } = await import('#/agent/media/image-compress');
    const workers = productionPool();
    const cpuWorker = {
      _serviceBrand: undefined,
      request: <T>(operation: unknown, options?: Parameters<CpuWorkerPool['request']>[1]) =>
        workers.request<T>(operation, options),
    };

    const cropped = await cropImageForModel(
      ONE_BY_ONE_PNG,
      'image/png',
      { x: 0, y: 0, width: 1, height: 1 },
      { cpuWorker },
    );
    expect(cropped.ok).toBe(true);
    if (cropped.ok) {
      expect(cropped.width).toBe(1);
      expect(cropped.height).toBe(1);
    }

    const normalized = await normalizeAvatarImage(ONE_BY_ONE_PNG, 'image/png', { cpuWorker });
    expect(normalized).toMatchObject({ width: 1, height: 1, mimeType: 'image/png', extension: 'png' });

    const dims = await readAvatarDimensions(ONE_BY_ONE_PNG, 'image/png', { cpuWorker });
    expect(dims).toEqual({ width: 1, height: 1 });

    const png = await encodeImageAsPng(ONE_BY_ONE_PNG, 'image/png', { cpuWorker });
    expect(png.byteLength).toBeGreaterThan(8);

    const aborted = new AbortController();
    aborted.abort(new Error('cancelled-before-crop'));
    const abortedCrop = await cropImageForModel(
      ONE_BY_ONE_PNG,
      'image/png',
      { x: 0, y: 0, width: 1, height: 1 },
      { cpuWorker, signal: aborted.signal },
    );
    expect(abortedCrop.ok).toBe(false);
    await expect(
      normalizeAvatarImage(ONE_BY_ONE_PNG, 'image/png', { cpuWorker, signal: aborted.signal }),
    ).rejects.toThrow('cancelled-before-crop');
  }, 30_000);

  it('routes tiny images through registered CPU pool and never falls back to main thread on worker rejection', async () => {
    const {
      compressImageForModel,
      cropImageForModel,
    } = await import('#/agent/media/image-compress');
    const { registerCpuPool } = await import('#/app/cpuWorker/runtime');
    const { CpuWorkerError } = await import('#/app/cpuWorker/host');

    const calls: string[] = [];
    const failingPool = {
      request: async <T>(operation: unknown): Promise<T> => {
        const type = (operation as { type?: string }).type ?? 'unknown';
        calls.push(type);
        throw new CpuWorkerError('CPU_TIMEOUT', 'simulated worker timeout');
      },
      close: async () => {},
    } as unknown as CpuWorkerPool;
    const registration = registerCpuPool(failingPool);
    try {
      const compressed = await compressImageForModel(ONE_BY_ONE_PNG, 'image/png', {
        maxEdge: 1,
        byteBudget: 10,
      });
      expect(calls).toEqual(['image.compress']);
      expect(compressed.changed).toBe(false);
      expect(compressed.data).toBe(ONE_BY_ONE_PNG);

      const cropped = await cropImageForModel(
        ONE_BY_ONE_PNG,
        'image/png',
        { x: 0, y: 0, width: 1, height: 1 },
      );
      expect(calls).toEqual(['image.compress', 'image.crop']);
      expect(cropped.ok).toBe(false);
      if (!cropped.ok) {
        expect(cropped.error).toContain('Failed to decode the image for cropping');
        expect(cropped.error).toContain('simulated worker timeout');
      }
    } finally {
      await registration.dispose();
    }
  });

  it('applies backpressure instead of terminating oldest detached worker on soft cancel storm and awaits retiring exits in close', async () => {
    const workers = await pool({ maxWorkers: 1, cancelGraceMs: 25, timeoutMs: 10_000 });
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const ac3 = new AbortController();

    const p1 = workers.request<number>({ type: 'delay', ms: 180 }, { signal: ac1.signal });
    await new Promise((resolve) => setTimeout(resolve, 15));
    ac1.abort(new Error('cancel-1'));
    await expect(p1).rejects.toThrow('cancel-1');

    const p2 = workers.request<number>({ type: 'delay', ms: 180 }, { signal: ac2.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    ac2.abort(new Error('cancel-2'));
    await expect(p2).rejects.toThrow('cancel-2');

    const p3 = workers.request<number>({ type: 'delay', ms: 180 }, { signal: ac3.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const detachedBeforeStorm = [...(workers as unknown as { detachedDraining: Array<{ worker: { terminate: () => Promise<number> } }> }).detachedDraining];
    expect(detachedBeforeStorm.length).toBe(2);

    let terminatedMidFlight = 0;
    for (const entry of detachedBeforeStorm) {
      const origTerminate = entry.worker.terminate.bind(entry.worker);
      entry.worker.terminate = () => {
        terminatedMidFlight += 1;
        return origTerminate();
      };
    }

    ac3.abort(new Error('cancel-3'));
    await expect(p3).rejects.toThrow('cancel-3');
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(terminatedMidFlight).toBe(0);

    const p4 = workers.request<number>({ type: 'echo', bytes: 7 });
    expect(await p4).toBe(7);

    await workers.close();
    expect((workers as unknown as { retiringExits: Set<Promise<void>> }).retiringExits.size).toBe(0);
  }, 15_000);

  it('hard-terminates a wedged detached worker at its request timeout deadline instead of leaking it', async () => {
    const workers = await pool({ maxWorkers: 1, cancelGraceMs: 25, timeoutMs: 180 });
    const ac = new AbortController();
    const stuck = workers.request<number>({ type: 'spin' }, { signal: ac.signal, timeoutMs: 180 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    ac.abort(new Error('cancel-spin'));
    await expect(stuck).rejects.toThrow('cancel-spin');

    await vi.waitFor(() => {
      const detached = (workers as unknown as { detachedDraining: unknown[] }).detachedDraining;
      expect(detached.length).toBe(1);
    }, { timeout: 2_000 });

    await vi.waitFor(() => {
      const detached = (workers as unknown as { detachedDraining: unknown[] }).detachedDraining;
      expect(detached.length).toBe(0);
    }, { timeout: 2_000 });

    await expect(workers.request<number>({ type: 'echo', bytes: 9 })).resolves.toBe(9);
  });

  it('retires a booting warmup worker that never reports ready so pump does not deadlock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cpu-pool-boot-stall-'));
    dirs.push(dir);
    const entry = join(dir, 'stall-boot.mjs');
    await writeFile(
      entry,
      `import { parentPort, workerData } from 'node:worker_threads';
setInterval(() => {}, 1000);
parentPort.on('message', ({ id, operation }) => {
  parentPort.postMessage({ id, result: operation });
});`,
    );
    const workers = new CpuWorkerPool(pathToFileURL(entry), {
      maxWorkers: 2,
      warmWorkers: 0,
      bootTimeoutMs: 60,
      closeTimeoutMs: 250,
    });
    pools.push(workers);
    workers.warm(1);
    expect(workers.liveWorkerCount).toBe(1);
    await vi.waitFor(() => {
      expect(workers.liveWorkerCount).toBe(0);
    }, { timeout: 2_000 });
    await expect(workers.request<string>('recovered-after-boot-stall')).resolves.toBe('recovered-after-boot-stall');
    await workers.close();
  });

  it('retires a bloated warm worker whose retained heapTotalBytes exceeds maxRetainedHeapBytes and keeps healthy warm workers alive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cpu-pool-heap-retire-'));
    dirs.push(dir);
    const entry = join(dir, 'heap-entry.mjs');
    await writeFile(
      entry,
      `import { parentPort, threadId } from 'node:worker_threads';
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', ({ id, operation }) => {
  parentPort.postMessage({ id, result: threadId, heapTotalBytes: operation.heapTotalBytes });
});`,
    );
    const workers = new CpuWorkerPool(pathToFileURL(entry), {
      maxWorkers: 1,
      warmWorkers: 1,
      maxRetainedHeapBytes: 100 * 1024 * 1024,
    });
    pools.push(workers);

    const firstId = await workers.request<number>({ heapTotalBytes: 24 * 1024 * 1024 });
    const reusedId = await workers.request<number>({ heapTotalBytes: 48 * 1024 * 1024 });
    expect(reusedId).toBe(firstId);
    expect(workers.liveWorkerCount).toBe(1);

    const bloatedId = await workers.request<number>({ heapTotalBytes: 256 * 1024 * 1024 });
    expect(bloatedId).toBe(firstId);
    await vi.waitFor(() => {
      expect(workers.liveWorkerCount).toBe(0);
    }, { timeout: 2_000 });

    const replacementId = await workers.request<number>({ heapTotalBytes: 24 * 1024 * 1024 });
    expect(replacementId).not.toBe(firstId);
    expect(workers.liveWorkerCount).toBe(1);
    await workers.close();
  });
});
