import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { Klient } from '@kiki/klient';
import { observePanelUsage, panelUsageRevision, subscribeUsageFreshness } from './usageFreshness';

function source() {
  let listener!: (value: { sessionId?: string; agentId?: string }) => void;
  let attached!: () => void;
  const ready = new Promise<void>((resolve) => { attached = resolve; });
  const dispose = vi.fn();
  const klient = { events: { on: vi.fn((_event, callback) => { listener = callback; return { ready, dispose }; }) } } as unknown as Pick<Klient, 'events'>;
  return { klient, attached, dispose, publish: (payload: { sessionId?: string; agentId?: string }) => listener(payload), emit: (sessionId = 'session-a') => { listener({ sessionId, agentId: 'main' }); } };
}

describe('usage query freshness', () => {
  it('keeps settled revisions agent-scoped across panel remounts and rechecks after reconnect', async () => {
    const queries = new QueryClient();
    const event = source();
    const changed = vi.fn();
    const other = vi.fn();
    const off = subscribeUsageFreshness(event.klient, queries);
    const stop = observePanelUsage(event.klient, 'session-a', changed);
    const stopOther = observePanelUsage(event.klient, 'session-b', other);
    event.attached();
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    event.publish({});
    expect(changed).not.toHaveBeenCalled();
    event.publish({ sessionId: 'session-a', agentId: 'child' });
    const first = panelUsageRevision(event.klient, 'session-a', 'child');
    expect(first).toBeDefined();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(panelUsageRevision(event.klient, 'session-a', 'main')).toBeUndefined();
    stop();
    event.publish({ sessionId: 'session-a', agentId: 'child' });
    const stopAgain = observePanelUsage(event.klient, 'session-a', changed);
    const remounted = panelUsageRevision(event.klient, 'session-a', 'child');
    expect(remounted).not.toBe(first);
    expect(changed).toHaveBeenCalledTimes(1);
    off();
    const offAgain = subscribeUsageFreshness(event.klient, queries);
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(1);
    expect(panelUsageRevision(event.klient, 'session-a', 'child')).not.toBe(remounted);
    expect(panelUsageRevision(event.klient, 'session-a', 'child')).toBe(panelUsageRevision(event.klient, 'session-a', 'main'));
    offAgain(); stopAgain(); stopOther(); queries.clear();
  });

  it('leaves scoped static catalogs and sibling metrics alone while refreshing the settled agent', async () => {
    const queries = new QueryClient();
    const query = { session_id: 'session-a', agent_id: 'main' };
    const catalogKey = ['agentCapabilities', query, 'local', 'scope-a', 'server-a', 'catalog'];
    const metricsKey = ['agentCapabilities', { ...query, metrics_only: true }, 'local', 'scope-a', 'server-a'];
    let finish!: (value: string) => void;
    let signal: AbortSignal | undefined;
    const catalog = new QueryObserver(queries, {
      queryKey: catalogKey,
      queryFn: (options) => { signal = options.signal; return new Promise<string>((resolve) => { finish = resolve; }); },
      staleTime: Infinity,
    });
    const stop = catalog.subscribe(() => {});
    const siblingKey = ['agentCapabilities', { ...query, agent_id: 'child', metrics_only: true }, 'local', 'scope-a', 'server-a'];
    queries.setQueryData(metricsKey, 1);
    queries.setQueryData(siblingKey, 2);
    const event = source();
    const off = subscribeUsageFreshness(event.klient, queries);
    event.emit();
    await vi.waitFor(() => expect(queries.getQueryState(metricsKey)?.isInvalidated).toBe(true));
    expect(queries.getQueryState(siblingKey)?.isInvalidated).toBe(false);
    expect(signal?.aborted).toBe(false);
    expect(queries.getQueryState(catalogKey)?.isInvalidated).toBe(false);
    finish('complete catalog');
    await vi.waitFor(() => expect(catalog.getCurrentResult().data).toBe('complete catalog'));
    off(); stop(); queries.clear();
  });
  it('invalidates parked reads and repairs missed events on reattachment without leaking into another scope', async () => {
    const queries = new QueryClient();
    const otherScope = new QueryClient();
    const key = ['usage-v2', { range: 'today' }];
    queries.setQueryData(key, 1);
    queries.setQueryData(['agentCapabilities', { session_id: 'session-a', agent_id: 'main' }], 1);
    queries.setQueryData(['agentCapabilities', { session_id: 'session-b', agent_id: 'main' }], 1);
    otherScope.setQueryData(key, 99);
    const event = source();
    const off = subscribeUsageFreshness(event.klient, queries);
    event.emit();
    await vi.waitFor(() => expect(queries.getQueryState(key)?.isInvalidated).toBe(true));
    expect(queries.getQueryState(['agentCapabilities', { session_id: 'session-b', agent_id: 'main' }])?.isInvalidated).toBe(false);
    expect(otherScope.getQueryState(key)?.isInvalidated).toBe(false);
    const read = vi.fn(async () => 2);
    const observer = new QueryObserver(queries, { queryKey: key, queryFn: read, staleTime: Infinity });
    const stop = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(2));
    event.attached();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    off(); stop(); queries.clear(); otherScope.clear();
  });

  it('lets a settled refresh finish during continuous usage events and then reads the newest total', async () => {
    const queries = new QueryClient();
    const key = ['usage-v2', { range: 'last_7_days' }];
    queries.setQueryData(key, 0);
    let finish!: (value: number) => void;
    const inFlight = new Promise<number>((resolve) => { finish = resolve; });
    let refreshSignal: AbortSignal | undefined;
    const read = vi.fn().mockImplementationOnce(({ signal }) => {
      refreshSignal = signal;
      return inFlight;
    }).mockResolvedValue(2);
    const observer = new QueryObserver(queries, { queryKey: key, queryFn: read, staleTime: Infinity });
    const stop = observer.subscribe(() => {});
    const event = source();
    const off = subscribeUsageFreshness(event.klient, queries);
    event.emit();
    await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(1); });
    for (let index = 0; index < 10; index++) event.emit(index % 2 === 0 ? 'session-a' : 'session-b');
    await Promise.resolve();
    expect(refreshSignal?.aborted).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    finish(1);
    await vi.waitFor(() => { expect(observer.getCurrentResult().data).toBe(2); });
    expect(read).toHaveBeenCalledTimes(2);
    off(); stop(); queries.clear();
  });

  it('cancels an older in-flight dashboard response before fetching a settled total', async () => {
    const queries = new QueryClient();
    const key = ['usage-v2-strip'];
    let finishOld!: (value: number) => void;
    const old = new Promise<number>((resolve) => { finishOld = resolve; });
    const read = vi.fn().mockReturnValueOnce(old).mockResolvedValue(2);
    const observer = new QueryObserver(queries, { queryKey: key, queryFn: read });
    const stop = observer.subscribe(() => {});
    const event = source();
    const off = subscribeUsageFreshness(event.klient, queries);
    event.emit();
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(2));
    finishOld(1);
    await Promise.resolve();
    expect(observer.getCurrentResult().data).toBe(2);
    off(); stop(); queries.clear();
  });
});
