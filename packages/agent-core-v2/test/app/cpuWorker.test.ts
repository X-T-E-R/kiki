import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CpuWorkerPool } from '#/app/cpuWorker/host';
import { runCpuStream } from '#/app/cpuWorker/stream';
import { reduceContextTranscript } from '#/agent/contextMemory/contextTranscript';
import type { WireContextProjection } from '#/agent/contextMemory/wireContextProjection';
import { deserialize } from 'node:v8';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { sealColdSegments } from '#/persistence/coldSegmentLog';
import { readWireContextProjection } from '#/persistence/wireContextRead';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { WireRecord } from '#/wire/record';

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
parentPort.on('message',({id,operation})=>{
  if(operation.type==='crash')process.exit(17);
  if(operation.type==='spin')while(true){}
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

  it('terminates uncooperative timeout work and restarts for the queued task', async () => {
    const workers = await pool({ maxWorkers: 1 });
    const active = workers.request({type:'spin'}, {timeoutMs:100});
    const failure = expect(active).rejects.toMatchObject({code:'CPU_TIMEOUT'});
    const waiting = workers.request('survives timeout');
    await failure;
    await expect(waiting).resolves.toBe('survives timeout');
  });

  it('recovers from worker death and running cancellation without replaying failed work', async () => {
    const workers = await pool({ maxWorkers: 1 });
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
    expect(deserialize(Buffer.from(result))).toEqual({ transcript: reduceContextTranscript(records), permissionMode: 'yolo', planActive: true });
  });

  it('reads logical sealed bytes and reports the same corruption location as append-log replay', async () => {
    const workers = productionPool();
    const storage = new InMemoryStorageService();
    const records = [message('sealed'), { type: 'plan_mode.enter', id: 'p' }, { type: 'plan_mode.exit' }, message('tail')];
    const bytes = Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    await storage.write('test', 'wire.jsonl', bytes);
    await sealColdSegments(storage, 'test', 'wire.jsonl', bytes.length, { segmentBytes: 31 });
    const result = await readWireContextProjection(workers.request.bind(workers), flushedLogs, storage, 'test', 'wire.jsonl');
    expect(result).toEqual({ transcript: reduceContextTranscript(records), permissionMode: 'auto', planActive: false });
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
