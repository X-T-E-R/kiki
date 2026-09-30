import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Session } from '@kiki/protocol';
import { mergeConversationItems, type SessionSortOrder } from '@kiki/session-core/sessions';
import { forgetRoomSeen, sessionSeenSnapshot, subscribeSessionSeen } from '@kiki/session-core/settings';
import { useConnection } from '../state/connection';
import { ROOMS_QUERY_KEY } from './botRooms';

export const ROOM_ITEMS_QUERY_KEY = ['rooms', 'items'] as const;

/** The logical sidebar source; sessions retain their independent load-more cursor. */
export function useConversationList(sessions: readonly Session[], order: SessionSortOrder = 'updated-desc') {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const seen = useSyncExternalStore(subscribeSessionSeen, sessionSeenSnapshot, sessionSeenSnapshot);
  const roomsQuery = useQuery({
    queryKey: ROOM_ITEMS_QUERY_KEY,
    queryFn: () => {
      const rest = client.klient.rest;
      if (rest === undefined) throw new Error('Room list is unavailable on this transport');
      return rest.rooms.listItems();
    },
    staleTime: 15_000,
    refetchInterval: 15_000,
    retry: false,
  });
  useEffect(() => {
    const subscription = client.klient.events.on('room.changed', (event) => {
      if (event.deleted) forgetRoomSeen(event.roomId);
      void queryClient.invalidateQueries({ queryKey: ROOMS_QUERY_KEY });
    });
    return () => { subscription.dispose(); };
  }, [client, queryClient]);
  const rooms = roomsQuery.data ?? [];
  const items = useMemo(() => mergeConversationItems(sessions, rooms, seen, order), [sessions, rooms, seen, order]);
  return { items, rooms, roomsQuery, seen };
}
