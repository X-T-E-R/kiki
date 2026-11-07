import { describe, expect, it } from 'vitest';

import { HarnessQuotaCache } from '#/app/plugin/harnessQuota';
import type { HarnessQuotaReading, PluginHarnessQuotaSnapshot } from '@kiki/protocol';

const definition: PluginHarnessQuotaSnapshot = {
  id: 'plugin:fixture-quota/example', label: 'Fixture', engineIds: ['agy-cli'], minRefreshIntervalMs: 300_000,
};
const reading: HarnessQuotaReading = { accountId: 'work', unit: 'percent', remaining: 80 };

describe('harness quota cache', () => {
  it('shares one in-flight read and then serves the cache for five minutes', async () => {
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
    now += 299_999;
    await cache.read(definition.id, 300_000, load);
    expect(calls).toBe(1);
    now += 2;
    await cache.read(definition.id, 300_000, load);
    expect(calls).toBe(2);
    const cached = cache.snapshots([definition]);
    expect(cached.sources[0]?.readings).toEqual([reading]);
    expect(cached.sources[0]?.readAt).toBe(new Date(now).toISOString());
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
    now += 2;
    await expect(cache.read(definition.id, 600_000, load)).rejects.toThrow('quota down');
    expect(calls).toBe(2);
  });
});
