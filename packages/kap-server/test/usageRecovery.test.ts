import { describe, expect, it } from 'vitest';
import { UsageReadAllowance } from '@kiki/agent-core-v2/agent/usage/usageWireFramer';
import type { IFileSystemStorageService } from '@kiki/agent-core-v2/persistence/interface/storage';
import { Scope, setScopeTopology } from '@kiki/agent-core-v2/_base/di/scope';
import { readUsageWireTail, UsageRecoveryPool, usageRecoveryPool, type WireLineContinuation } from '../src/usage/usageRecovery';

const fact = (time: number) => ({ type: 'usage.record', time, model: 'example', usageKnown: true, usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 0 } });

function sourceStorage(bytes: Uint8Array): IFileSystemStorageService {
  return { async *readStream(_scope: string, _key: string, range: { start: number; end: number }) { yield bytes.subarray(range.start, range.end + 1); } } as unknown as IFileSystemStorageService;
}

describe('bounded usage recovery lanes', () => {
  it('cold-starts the real pure source worker and uses identical framing with bounded transfers', async () => {
    const bytes = Buffer.from(JSON.stringify({ type: 'message', text: '示例🙂\\\n'.repeat(150_000) }) + '\n' + JSON.stringify(fact(1)) + '\n');
    const pool = new UsageRecoveryPool();
    const allowance = new UsageReadAllowance(Infinity, 2);
    const results: Awaited<ReturnType<typeof readUsageWireTail>>[] = [];
    try {
      await pool.run(['main', 'child'], async (id, worker, signal) => {
        results.push(await readUsageWireTail(sourceStorage(bytes), id, 0, bytes.length, allowance, Infinity, Date.now, id, signal, undefined, new Map(), 'same-prefix', worker));
      });
      expect(results).toHaveLength(2);
      expect(results.every((value) => value.complete && value.valid && value.offset === bytes.length)).toBe(true);
      expect(results.map((value) => value.records[0]?.usage.output)).toEqual([2, 2]);
      expect(allowance.counts()).toEqual({ raw: 4, facts: 2 });
      expect(pool.observation()?.startupMs).toBeGreaterThan(0);
      expect(pool.observation()?.peakInFlightBytes).toBeLessThanOrEqual(1 << 20);
      expect(pool.observation()?.worker?.heapUsed).toBeLessThan(128 << 20);
    } finally { pool.dispose(); await pool.closed(); }
  });

  it('returns a transferable giant-row continuation across separate worker lifetimes', async () => {
    const bytes = Buffer.from(JSON.stringify({ ...fact(1), body: 'x'.repeat(3 << 20) }) + '\n');
    const pool = new UsageRecoveryPool();
    const continuations = new Map<string, WireLineContinuation>();
    let offset = 0, complete = false, total = 0;
    try {
      for (let attempt = 0; attempt < 5 && !complete; attempt++) {
        const allowance = new UsageReadAllowance(Infinity, Infinity, 1 << 20);
        await pool.run(['empty', 'source'], async (id, worker, signal) => {
          if (id === 'empty') { await new Promise<void>((resolve) => { setImmediate(resolve); }); return; }
          const result = await readUsageWireTail(sourceStorage(bytes), id, offset, bytes.length, allowance, Infinity, Date.now, id, signal, undefined, continuations, 'fixed-prefix', worker);
          offset = result.offset; complete = result.complete; total += result.records.reduce((sum, value) => sum + value.usage.output, 0);
        });
      }
      expect(complete).toBe(true);
      expect(offset).toBe(bytes.length);
      expect(total).toBe(2);
      expect(continuations.size).toBe(0);
    } finally { pool.dispose(); await pool.closed(); }
  });

  it('shares raw and fact allowances across both lanes including invalid and unknown facts', async () => {
    const rows = [JSON.stringify({ type: 'message' }), JSON.stringify({ ...fact(1), usageKnown: false }), '{invalid}', JSON.stringify(fact(2))];
    const bytes = Buffer.from(Array.from({ length: 1000 }, () => rows.join('\n')).join('\n') + '\n');
    const pool = new UsageRecoveryPool();
    try {
      for (const [raw, facts] of [[7, Infinity], [Infinity, 5]] as const) {
        const allowance = new UsageReadAllowance(raw, facts);
        const results: Awaited<ReturnType<typeof readUsageWireTail>>[] = [];
        await pool.run(['main', 'child'], async (id, worker, signal) => {
          results.push(await readUsageWireTail(sourceStorage(bytes), id, 0, bytes.length, allowance, Infinity, Date.now, id, signal, undefined, new Map(), 'fixed', worker));
        });
        expect(allowance.counts().raw).toBeLessThanOrEqual(raw!);
        expect(allowance.counts().facts).toBeLessThanOrEqual(facts!);
        expect(allowance.counts()[Number.isFinite(raw) ? 'raw' : 'facts']).toBe(Number.isFinite(raw) ? raw : facts);
        expect(results.every((value) => !value.complete && value.incompleteReason === 'record_budget')).toBe(true);
        expect(results.some((value) => !value.valid)).toBe(true);
        expect(pool.observation()?.threadId).toBe(-1);
      }
    } finally { pool.dispose(); await pool.closed(); }
  });

  it('shares one App operation, cancels queued work, and awaits real worker exit on App disposal', async () => {
    setScopeTopology(['app', 'session', 'agent']);
    const app = Scope.createApp();
    const pool = usageRecoveryPool(app);
    expect(usageRecoveryPool(app)).toBe(pool);
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const running = pool.run(['main', 'worker'], async (_id, worker, signal) => {
      if (worker !== undefined) { await worker.begin(0, 'example', undefined, new UsageReadAllowance(Infinity).buffer, Infinity); resolveReady(); }
      await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true }); });
    });
    const settled = running.catch((error: unknown) => error);
    try {
      await ready;
      expect(pool.observation()?.threadId).toBeGreaterThan(0);
      const cancel = new AbortController();
      let queuedStarted = false;
      const queued = pool.run(['later'], async () => { queuedStarted = true; }, cancel.signal).catch((error: unknown) => error);
      cancel.abort(new DOMException('No waiter', 'AbortError'));
      expect(await queued).toMatchObject({ name: 'AbortError' });
      expect(queuedStarted).toBe(false);
      await app.dispose();
      expect(await settled).toMatchObject({ name: 'AbortError' });
      expect(pool.observation()?.threadId).toBe(-1);
      expect(pool.observation()?.inFlightBytes).toBe(0);
    } finally { await app.dispose(); await settled; }
  });
});
