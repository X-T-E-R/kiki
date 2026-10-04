import { useQuery } from '@tanstack/react-query';

import { useConnection } from '../state/connection';

const BUSY_SCAN_PAGE_SIZE = 50;

export function useBusySessionCount(): number | undefined {
  const { client } = useConnection();
  const query = useQuery({
    queryKey: ['sessions', 'restart-confirm'],
    queryFn: () => client.listSessions({ page_size: BUSY_SCAN_PAGE_SIZE }),
    staleTime: 10_000,
    select: (page) => page.busy_count ?? (page.has_more ? undefined : page.items.filter((session) => session.busy).length),
  });
  return query.data;
}
