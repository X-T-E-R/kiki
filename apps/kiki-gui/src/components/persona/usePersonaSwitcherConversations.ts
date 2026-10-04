/**
 * The conversation list behind a persona's switcher.
 *
 * Which conversations belong to a persona is the server's answer, not the
 * client's: the sidebar's own session list is a window (one page, grown only
 * when someone asks for more), and a persona's oldest conversation is usually
 * not in it. Both switcher surfaces — the sidebar row menu and the session
 * header's identity block — therefore read this one query when they open, so
 * they share a cache entry instead of each judging attribution on its own.
 *
 * Nothing is prefetched: the query is enabled by the panel being open.
 */

import { useQuery } from '@tanstack/react-query';

import { useConnection } from '../../state/connection';

/** The window one panel shows at once; the full list is a page away. */
const PAGE_SIZE = 100;

export const personaSwitcherQueryKey = (personaId: string | undefined) =>
  ['sessions', 'persona', personaId ?? '', 'switcher'] as const;

export function usePersonaSwitcherConversations(personaId: string | undefined, open: boolean) {
  const { client } = useConnection();
  return useQuery({
    queryKey: personaSwitcherQueryKey(personaId),
    queryFn: () => client.listSessions({ persona: personaId ?? '', page_size: PAGE_SIZE }),
    enabled: open && personaId !== undefined,
    staleTime: 15_000,
  });
}
