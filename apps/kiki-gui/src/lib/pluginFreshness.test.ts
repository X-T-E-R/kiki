import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createKlientFromChannel, type KlientChannel } from '@kiki/klient';
import { expect, it, vi } from 'vitest';
import { subscribePluginFreshness } from './pluginFreshness';

it('re-reads another window on workspace change and apply without a plugin reload', async () => {
  const handlers = new Set<(event: unknown) => void>();
  const channel: KlientChannel = {
    call: async () => undefined,
    stream: async function* () {},
    listen: (_scope, source, handler, _error, ready) => {
      expect(source).toEqual({ kind: 'stream', name: 'events' });
      handlers.add(handler);
      queueMicrotask(() => { ready?.(); });
      return { dispose: () => { handlers.delete(handler); } };
    },
    close: async () => { handlers.clear(); },
  };
  const klient = createKlientFromChannel(channel);
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let server = { revision: 0, effective: true, apply_state: 'applied' };
  const read = vi.fn(async () => ({ ...server }));
  const observer = new QueryObserver(queries, { queryKey: ['plugin-usage', 'other-window-session'], queryFn: read, staleTime: Infinity });
  const unobserve = observer.subscribe(() => {});
  const off = subscribePluginFreshness(klient, queries);
  const witness = klient.events.on('plugins.changed', () => {});
  try {
    await witness.ready;
    await vi.waitFor(() => { expect(observer.getCurrentResult().data).toEqual(server); });
    const publish = () => { for (const handler of handlers) handler({ type: 'event.plugin.changed', payload: {} }); };
    server = { revision: 1, effective: false, apply_state: 'pending' };
    publish();
    await vi.waitFor(() => { expect(observer.getCurrentResult().data).toEqual(server); });
    server = { ...server, apply_state: 'applied' };
    publish();
    await vi.waitFor(() => { expect(observer.getCurrentResult().data).toEqual(server); });
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(3);
    off();
    const reads = read.mock.calls.length;
    publish();
    await Promise.resolve();
    expect(read.mock.calls).toHaveLength(reads);
  } finally { witness.dispose(); off(); unobserve(); queries.clear(); await klient.close(); }
});
