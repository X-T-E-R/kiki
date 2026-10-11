import type { Klient } from '@kiki/klient';
import type { QueryClient, Query } from '@tanstack/react-query';

function isUsageRead(query: Query, sessionId?: string): boolean {
  const [key, scope] = query.queryKey;
  if (key === 'usage-v2' || key === 'usage-v2-strip' || key === 'usage-v2-strip-session' || key === 'sessions') return true;
  if (key === 'session') return sessionId === undefined || scope === sessionId;
  if (key !== 'agentCapabilities') return false;
  return sessionId === undefined || (typeof scope === 'object' && scope !== null && 'session_id' in scope && scope.session_id === sessionId);
}

export function subscribeUsageFreshness(klient: Pick<Klient, 'events'>, queries: QueryClient): () => void {
  let active = true;
  const refresh = (sessionId?: string) => {
    const filters = { predicate: (query: Query) => isUsageRead(query, sessionId) };
    void queries.cancelQueries(filters).then(() => {
      if (active) return queries.invalidateQueries(filters);
    });
  };
  const subscription = klient.events.on('usage.settled', ({ sessionId }) => {
    if (active) refresh(sessionId);
  });
  void subscription.ready.then(() => {
    if (active) refresh();
  }).catch(() => {});
  return () => { active = false; subscription.dispose(); };
}
