import { describe, expect, it, vi } from 'vitest';

import { HarnessQuotaCache, HarnessQuotaService } from '#/app/plugin/harnessQuota';
import type { IPluginHostService } from '#/app/plugin/pluginHostService';
import {
  HARNESS_QUOTA_UNAVAILABLE_MESSAGE,
  harnessQuotaSourceDefinitionSchema,
  type HarnessQuotaReading,
  type PluginHarnessQuotaSnapshot,
} from '@kiki/protocol';

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
    expect(cache.snapshots([definition]).sources[0]?.error).toBe(HARNESS_QUOTA_UNAVAILABLE_MESSAGE);
    expect(cache.snapshots([definition]).sources[0]?.error).not.toContain('quota down');
    now += 2;
    await expect(cache.read(definition.id, 600_000, load)).rejects.toThrow('quota down');
    expect(calls).toBe(2);
    now += 600_001;
    const recovered = await cache.read(definition.id, 600_000, async () => [reading]);
    expect(recovered).toEqual([reading]);
    expect(cache.snapshots([definition]).sources[0]?.error).toBeUndefined();
  });

  it('forwards bounded declared quota actions, enforces account_id on account scope, and invalidates cached readings', async () => {
    expect(harnessQuotaSourceDefinitionSchema.safeParse({
      schemaVersion: 1,
      id: 'pool',
      label: 'Pool',
      engineIds: ['agy-cli'],
      actions: [
        { id: 'set_primary', label: '设为当前账号', scope: 'account' },
        { id: 'toggle_pause', label: '暂停此账号', scope: 'account' },
        { id: 'manage', label: '在插件中管理', scope: 'pool' },
      ],
    }).success).toBe(true);
    expect(harnessQuotaSourceDefinitionSchema.safeParse({
      schemaVersion: 1,
      id: 'pool',
      label: 'Pool',
      engineIds: ['agy-cli'],
      actions: [
        { id: 'set_primary', label: 'A', scope: 'account' },
        { id: 'set_primary', label: 'B', scope: 'account' },
      ],
    }).success).toBe(false);

    let readCount = 0;
    const performHarnessQuotaAction = vi.fn(async () => ({ ok: true, message: 'switched' }));
    const hosts = {
      attachQuotaCache: vi.fn(),
      listHarnessQuotaSources: vi.fn(async () => [{
        id: definition.id,
        label: definition.label,
        engineIds: ['agy-cli'],
        minRefreshIntervalMs: 300_000,
        actions: [
          { id: 'set_primary' as const, label: '设为当前账号', scope: 'account' as const },
          { id: 'manage' as const, label: '在插件中管理', scope: 'pool' as const },
        ],
      }]),
      readHarnessQuota: vi.fn(async () => {
        readCount += 1;
        return [reading];
      }),
      performHarnessQuotaAction,
    } as unknown as IPluginHostService;

    const service = new HarnessQuotaService(hosts);
    await service.read(definition.id);
    expect(readCount).toBe(1);
    expect((await service.cached()).sources[0]?.actions).toEqual([
      { id: 'set_primary', label: '设为当前账号', scope: 'account' },
      { id: 'manage', label: '在插件中管理', scope: 'pool' },
    ]);

    await expect(service.performAction(definition.id, 'toggle_pause', 'work')).rejects.toThrow('not declared');
    await expect(service.performAction(definition.id, 'set_primary', undefined)).rejects.toThrow('requires account_id');

    const result = await service.performAction(definition.id, 'set_primary', 'work');
    expect(result).toEqual({ ok: true, message: 'switched' });
    expect(performHarnessQuotaAction).toHaveBeenCalledWith(definition.id, 'set_primary', 'work', expect.any(AbortSignal));

    await service.read(definition.id);
    expect(readCount).toBe(2);

    let releaseSlowRead!: (value: readonly HarnessQuotaReading[]) => void;
    const slowReadPromise = new Promise<readonly HarnessQuotaReading[]>((resolve) => {
      releaseSlowRead = resolve;
    });
    const staleReading: HarnessQuotaReading = { ...reading, remaining: 10 };
    const freshReading: HarnessQuotaReading = { ...reading, remaining: 95 };
    let phase = 0;
    const raceHosts = {
      attachQuotaCache: vi.fn(),
      listHarnessQuotaSources: hosts.listHarnessQuotaSources,
      readHarnessQuota: vi.fn(async () => {
        phase += 1;
        if (phase === 1) return slowReadPromise;
        return [freshReading];
      }),
      performHarnessQuotaAction: vi.fn(async () => ({ ok: true, message: 'switched' })),
    } as unknown as IPluginHostService;
    const raceService = new HarnessQuotaService(raceHosts);
    const pendingOldRead = raceService.read(definition.id);
    await Promise.resolve();
    await raceService.performAction(definition.id, 'set_primary', 'work');
    releaseSlowRead([staleReading]);
    await pendingOldRead;
    expect((await raceService.cached()).sources[0]?.readings).toBeUndefined();
    expect(await raceService.read(definition.id)).toEqual([freshReading]);
  });
});
