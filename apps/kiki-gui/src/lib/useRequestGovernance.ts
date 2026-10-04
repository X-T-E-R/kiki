import { useQuery } from '@tanstack/react-query';
import { useConnection } from '../state/connection';

/**
 * The shared 1s governance snapshot. `enabled` lets a consumer mount the poll
 * only while its indicator can be visible (e.g. the composer only while the
 * session works); other observers on the same key keep their own cadence.
 */
export function useRequestGovernance(options?: { readonly enabled?: boolean }) {
  const { client, scopeId, wsStatus } = useConnection();
  const query = useQuery({
    queryKey: ['request-governance', scopeId],
    queryFn: () => client.getRequestGovernance(),
    refetchInterval: 1000,
    retry: false,
    enabled: options?.enabled ?? true,
  });
  return { snapshot: query.data, stale: query.isError || wsStatus !== 'open', loading: query.isPending };
}
