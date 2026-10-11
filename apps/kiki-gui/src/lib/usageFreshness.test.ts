import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { Klient } from '@kiki/klient';
import { subscribeUsageFreshness } from './usageFreshness';

function source() {
  let listener!: (value: { sessionId: string; agentId: string }) => void;
  let attached!: () => void;
  const ready = new Promise<void>((resolve) => { attached = resolve; });
  const dispose = vi.fn();
  const klient = { events: { on: vi.fn((_event, callback) => { listener = callback; return { ready, dispose }; }) } } as unknown as Pick<Klient, 'events'>;
  return { klient, attached, dispose, emit: (sessionId = 'session-a') => { listener({ sessionId, agentId: 'main' }); } };
}

describe('usage query freshness', () => {
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
