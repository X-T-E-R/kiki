import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Session } from '@kiki/protocol';
import { mergeConversationItems, mergeSessionActivity, type ConversationWorkspace, type SessionListData, type SessionSortOrder } from '@kiki/session-core/sessions';
import { forgetRoomSeen, sessionSeenSnapshot, subscribeSessionSeen } from '@kiki/session-core/settings';
import { useConnection } from '../state/connection';
import { ROOMS_QUERY_KEY } from './botRooms';

export const ROOM_ITEMS_QUERY_KEY = ['rooms', 'items'] as const;
/** Minimum spacing between event-driven point reads of one session row. */
export const SESSION_EVENT_READ_INTERVAL_MS = 250;

/** The logical sidebar source; sessions retain their independent load-more cursor. */
export function useConversationList(sessions: readonly Session[], order: SessionSortOrder = 'updated-desc', workspaces: readonly ConversationWorkspace[] = []) {
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
  // A session that just changed is the only row the reader can see move: read
  // it and fold the result into the loaded pages, so an attached child's
  // activity reaches its family without waiting for the head poll. Reads are
  // per session, start at most once per interval, and an event that arrives
  // during a read or inside the interval is folded into one trailing read.
  useEffect(() => {
    let disposed = false;
    const inFlight = new Set<string>();
    const dirty = new Set<string>();
    const lastStart = new Map<string, number>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const read = (sessionId: string) => {
      inFlight.add(sessionId);
      dirty.delete(sessionId);
      lastStart.set(sessionId, Date.now());
      void client.getSession(sessionId).then((fresh) => {
        if (disposed) return;
        queryClient.setQueriesData<SessionListData>({ queryKey: ['sessions'] }, (old) => mergeSessionActivity(old, fresh));
      }).catch(() => {
        // The bounded head poll repairs a failed point read without dropping loaded rows.
      }).finally(() => {
        inFlight.delete(sessionId);
        if (!disposed && dirty.has(sessionId)) schedule(sessionId);
      });
    };
    const schedule = (sessionId: string) => {
      if (inFlight.has(sessionId) || timers.has(sessionId)) return;
      const wait = (lastStart.get(sessionId) ?? -Infinity) + SESSION_EVENT_READ_INTERVAL_MS - Date.now();
      if (wait <= 0) {
        read(sessionId);
        return;
      }
      timers.set(sessionId, setTimeout(() => {
        timers.delete(sessionId);
        if (!disposed && dirty.has(sessionId)) read(sessionId);
      }, wait));
    };
    const refresh = (sessionId: string) => {
      dirty.add(sessionId);
      schedule(sessionId);
    };
    const subscription = client.klient.events.on('session.metaUpdated', (event) => refresh(event.sessionId));
    return () => {
      disposed = true;
      subscription.dispose();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [client, queryClient]);
  const rooms = roomsQuery.data ?? [];
  const items = useMemo(() => mergeConversationItems(sessions, rooms, seen, order, workspaces), [sessions, rooms, seen, order, workspaces]);
  return { items, rooms, roomsQuery, seen };
}
