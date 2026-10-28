import type { Klient } from '@kiki/klient';
import type { QueryClient, Query } from '@tanstack/react-query';

function isUsageRead(query: Query, sessionId?: string): boolean {
  const [key, scope] = query.queryKey;
  if (key === 'usage-v2' || key === 'usage-v2-strip' || key === 'usage-v2-strip-session' || key === 'sessions') return true;
  if (key === 'session') return sessionId === undefined || scope === sessionId;
  if (key !== 'agentCapabilities' || query.queryKey.at(-1) === 'catalog') return false;
  return sessionId === undefined || (typeof scope === 'object' && scope !== null && 'session_id' in scope && scope.session_id === sessionId);
}

export function subscribeUsageFreshness(klient: Pick<Klient, 'events'>, queries: QueryClient): () => void {
  let active = true;
  let refreshing = false;
  const pending = new Set<string | undefined>();
  const drain = async () => {
    refreshing = true;
    try {
      while (pending.size > 0) {
        if (!active) return;
        const sessions = [...pending];
        pending.clear();
        const filters = { predicate: (query: Query) => sessions.some((sessionId) => isUsageRead(query, sessionId)) };
        await queries.cancelQueries(filters);
        if (active) await queries.invalidateQueries(filters, { cancelRefetch: false });
      }
    } finally { refreshing = false; }
  };
  const refresh = (sessionId?: string) => {
    pending.add(sessionId);
    if (!refreshing) void drain().catch(() => {});
  };
  const subscription = klient.events.on('usage.settled', ({ sessionId }) => {
    if (active) refresh(sessionId);
  });
  void subscription.ready.then(() => {
    if (active) refresh();
  }).catch(() => {});
  return () => { active = false; subscription.dispose(); };
}
