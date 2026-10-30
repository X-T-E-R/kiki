import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CpuWorkerPool } from '#/app/cpuWorker/host';

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
