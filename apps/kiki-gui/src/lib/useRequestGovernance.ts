import { useQuery } from '@tanstack/react-query';
import { useConnection } from '../state/connection';

export function useRequestGovernance() {
  const { client, scopeId, wsStatus } = useConnection();
  const query = useQuery({
    queryKey: ['request-governance', scopeId],
    queryFn: () => client.getRequestGovernance(),
    refetchInterval: 1000,
    retry: false,
  });
  return { snapshot: query.data, stale: query.isError || wsStatus !== 'open', loading: query.isPending };
}
