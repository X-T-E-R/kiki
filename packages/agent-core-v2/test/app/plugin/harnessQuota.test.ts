import { describe, expect, it } from 'vitest';

import { HarnessQuotaCache } from '#/app/plugin/harnessQuota';
import type { HarnessQuotaReading, PluginHarnessQuotaSnapshot } from '@kiki/protocol';

const definition: PluginHarnessQuotaSnapshot = {
  id: 'plugin:fixture-quota/example', label: 'Fixture', engineIds: ['agy-cli'], minRefreshIntervalMs: 300_000,
};
const reading: HarnessQuotaReading = { accountId: 'work', unit: 'percent', remaining: 80 };

describe('harness quota cache', () => {
  it('shares one in-flight read, serves fresh readings inside the interval, and drops stale readings to unknown after TTL while keeping readAt', async () => {
    let now = 1_000_000;
    const cache = new HarnessQuotaCache(() => now);
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const load = async () => { calls += 1; await gate; return [reading]; };
    const first = cache.read(definition.id, 300_000, load);
    const second = cache.read(definition.id, 300_000, load);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([[reading], [reading]]);
    expect(calls).toBe(1);
    const firstReadIso = new Date(now).toISOString();
    now += 299_999;
    expect(cache.snapshots([definition]).sources[0]).toMatchObject({
      id: definition.id,
      readAt: firstReadIso,
      readings: [reading],
    });
    await cache.read(definition.id, 300_000, load);
    expect(calls).toBe(1);
    now += 2;
    const stale = cache.snapshots([definition]).sources[0];
    expect(stale?.id).toBe(definition.id);
    expect(stale?.readAt).toBe(firstReadIso);
    expect(stale?.readings).toBeUndefined();
    await cache.read(definition.id, 300_000, load);
    expect(calls).toBe(2);
    const cached = cache.snapshots([definition]);
    expect(cached.sources[0]?.readings).toEqual([reading]);
    expect(cached.sources[0]?.readAt).toBe(new Date(now).toISOString());
  });

  it('keeps an active shared flight alive when one reader aborts and cancels only when the last reader aborts', async () => {
    let now = 50_000;
    const cache = new HarnessQuotaCache(() => now);
    let aborted = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const load = async (signal: AbortSignal) => {
      signal.addEventListener('abort', () => { aborted += 1; }, { once: true });
      await gate;
      signal.throwIfAborted();
      return [reading];
    };
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = cache.read(definition.id, 300_000, load, firstAbort.signal);
    const second = cache.read(definition.id, 300_000, load, secondAbort.signal);
    firstAbort.abort(new DOMException('caller gone', 'AbortError'));
    await expect(first).rejects.toThrow();
    expect(aborted).toBe(0);
    release();
    await expect(second).resolves.toEqual([reading]);
    expect(cache.snapshots([definition]).sources[0]?.readings).toEqual([reading]);

    now += 300_001;
    let hangAborted = false;
    const never = new Promise<void>(() => undefined);
    const thirdAbort = new AbortController();
    const fourthAbort = new AbortController();
    const loadHang = async (signal: AbortSignal) => {
      signal.addEventListener('abort', () => { hangAborted = true; }, { once: true });
      await never;
      return [reading];
    };
    const third = cache.read(definition.id, 300_000, loadHang, thirdAbort.signal);
    const fourth = cache.read(definition.id, 300_000, loadHang, fourthAbort.signal);
    thirdAbort.abort();
    await expect(third).rejects.toThrow();
    expect(hangAborted).toBe(false);
    fourthAbort.abort();
    await expect(fourth).rejects.toThrow();
    expect(hangAborted).toBe(true);

    const recovered = await cache.read(definition.id, 300_000, async () => [reading]);
    expect(recovered).toEqual([reading]);
  });

  it('keeps a longer plugin interval and does not retry a cached failure inside it', async () => {
    let now = 5_000;
    const cache = new HarnessQuotaCache(() => now);
    let calls = 0;
    const load = async () => { calls += 1; throw new Error('quota down'); };
    await expect(cache.read(definition.id, 600_000, load)).rejects.toThrow('quota down');
    now += 599_999;
    await expect(cache.read(definition.id, 600_000, load)).rejects.toThrow('quota down');
    expect(calls).toBe(1);
    expect(cache.snapshots([definition]).sources[0]?.readings).toBeUndefined();
    expect(cache.snapshots([definition]).sources[0]?.error).toBe('quota down');
    now += 2;
    await expect(cache.read(definition.id, 600_000, load)).rejects.toThrow('quota down');
    expect(calls).toBe(2);
    now += 600_001;
    const recovered = await cache.read(definition.id, 600_000, async () => [reading]);
    expect(recovered).toEqual([reading]);
    expect(cache.snapshots([definition]).sources[0]?.error).toBeUndefined();
  });
});
