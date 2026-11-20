import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useConnection } from '../state/connection';

const ACTIVE_POLL_MS = 1000;
const IDLE_BACKGROUND_POLL_MS = 30_000;

/**
 * The shared governance snapshot. `enabled` lets a consumer mount the poll
 * only while its indicator can be visible (e.g. the composer only while the
 * session works); `background` (used by the sidebar badge) polls every 1s
 * while requests are active or queued and backs off to a quiet 30s heartbeat
 * when idle over an open socket, waking immediately on `session.workChanged`.
 */
export function useRequestGovernance(options?: {
  readonly enabled?: boolean;
  readonly background?: boolean;
}) {
  const { client, klient, scopeId, wsStatus } = useConnection();
  const queryClient = useQueryClient();
  const available = typeof client.getRequestGovernance === 'function';
  const enabled = available && (options?.enabled ?? true);
  const background = options?.background === true;
  const query = useQuery({
    queryKey: ['request-governance', scopeId],
    queryFn: () => client.getRequestGovernance(),
    refetchInterval: (q) => {
      if (!background) return ACTIVE_POLL_MS;
      const data = q.state.data;
      if (data !== undefined && (data.active > 0 || data.queued > 0)) return ACTIVE_POLL_MS;
      return wsStatus === 'open' ? IDLE_BACKGROUND_POLL_MS : ACTIVE_POLL_MS;
    },
    retry: false,
    enabled,
  });
  useEffect(() => {
    const events = klient?.events;
    if (!enabled || !background || wsStatus !== 'open' || events === undefined) return;
    const sub = events.on('session.workChanged', () => {
      void queryClient.invalidateQueries({ queryKey: ['request-governance', scopeId] });
    });
    return () => { sub.dispose(); };
  }, [enabled, background, klient, queryClient, scopeId, wsStatus]);
  return { snapshot: query.data, stale: query.isError || wsStatus !== 'open', loading: available && query.isPending };
}
