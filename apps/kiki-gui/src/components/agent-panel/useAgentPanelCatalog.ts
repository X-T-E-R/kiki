import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { hashKey, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { AgentCapabilitiesQuery } from '@kiki/protocol';
import type { EventSubscription, Klient } from '@kiki/klient';
import { useOptionalConnection } from '../../state/connection';

type CatalogKey = readonly ['agentCapabilities', AgentCapabilitiesQuery | undefined, string, string, string, 'catalog'];
type CatalogWatch = { users: number; revision: number; ready: Promise<void>; subscriptions: EventSubscription[] };
const watches = new WeakMap<QueryClient, Map<string, CatalogWatch>>();

function catalogWatch(queries: QueryClient, key: CatalogKey): CatalogWatch {
  let entries = watches.get(queries);
  if (entries === undefined) { entries = new Map(); watches.set(queries, entries); }
  const identity = hashKey(key);
  let entry = entries.get(identity);
  if (entry === undefined) {
    entry = { users: 0, revision: 0, ready: Promise.resolve(), subscriptions: [] };
    entries.set(identity, entry);
  }
  return entry;
}

function invalidateCatalog(queries: QueryClient, key: CatalogKey, watch: CatalogWatch) {
  watch.revision++;
  void queries.invalidateQueries({ queryKey: key, exact: true }, { cancelRefetch: false });
}

function retainCatalog(klient: Klient, queries: QueryClient, key: CatalogKey, watch: CatalogWatch): () => void {
  if (watch.users++ === 0) {
    const invalidate = () => { invalidateCatalog(queries, key, watch); };
    watch.subscriptions = [
      klient.events.on('config.changed', invalidate),
      klient.events.on('kosong.models.changed', invalidate),
      klient.events.on('kosong.providers.changed', invalidate),
      klient.events.on('plugins.reloaded', invalidate),
    ];
    watch.ready = Promise.all(watch.subscriptions.map((subscription) => subscription.ready)).then(() => {});
    void watch.ready.catch(() => {});
  }
  return () => {
    if (--watch.users !== 0) return;
    for (const subscription of watch.subscriptions) subscription.dispose();
    watch.subscriptions = [];
    // A later mount cannot reuse facts whose invalidation channel was absent.
    watch.revision++;
    void queries.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' });
    queueMicrotask(() => {
      if (watch.users === 0 && watches.get(queries)?.get(hashKey(key)) === watch) watches.get(queries)?.delete(hashKey(key));
    });
  };
}

/** One scoped catalog read shared by the rail folds and their detail drawers. */
export function useAgentPanelCatalog(query: AgentCapabilitiesQuery | undefined, enabled = true, sourceRevision = '') {
  const connection = useOptionalConnection();
  const klient = connection?.klient;
  const queries = useQueryClient();
  const identity = hashKey([query]);
  const key = useMemo<CatalogKey>(() => ['agentCapabilities', query, connection?.spaceKey ?? '', connection?.scopeId ?? '',
    connection?.meta?.server_id ?? '', 'catalog'],
  [identity, connection?.spaceKey, connection?.scopeId, connection?.meta?.server_id]);
  const watch = useMemo(() => catalogWatch(queries, key), [queries, key]);
  useLayoutEffect(() => {
    if (klient === undefined || query === undefined) return;
    return retainCatalog(klient, queries, key, watch);
  }, [klient, queries, key, watch]);
  const previous = useRef({ key, sourceRevision, status: connection?.wsStatus });
  useEffect(() => {
    const old = previous.current;
    previous.current = { key, sourceRevision, status: connection?.wsStatus };
    if (old.key === key && (old.sourceRevision !== sourceRevision ||
      (connection?.wsStatus === 'open' && old.status !== 'open'))) invalidateCatalog(queries, key, watch);
  }, [queries, key, watch, sourceRevision, connection?.wsStatus]);
  const active = enabled && klient !== undefined && query !== undefined;
  const result = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      if (klient === undefined || query === undefined) throw new Error('Client or agent unavailable');
      await watch.ready;
      for (;;) {
        signal.throwIfAborted();
        const revision = watch.revision;
        const value = await klient.global.agentPanel.read(query, { signal });
        signal.throwIfAborted();
        if (revision === watch.revision) return value;
      }
    },
    enabled: active,
    subscribed: active,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const sessionId = query !== undefined && 'session_id' in query ? query.session_id : undefined;
  useEffect(() => {
    if (klient === undefined || sessionId === undefined || result.data?.live !== true) return;
    const subscription = klient.session(sessionId).events.on('skills.changed', () => { invalidateCatalog(queries, key, watch); });
    void subscription.ready.catch(() => {});
    return () => { subscription.dispose(); };
  }, [klient, sessionId, result.data?.live, queries, key, watch]);
  return result;
}
