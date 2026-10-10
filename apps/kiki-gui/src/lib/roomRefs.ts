/**
 * Room-reference directory: resolves a linked room id to the record the GUI
 * already holds. Reads the same cached room list the room surfaces use, and
 * fetches a room once for an id the cache does not carry.
 *
 * A room the client cannot resolve is not an error and never blocks sending:
 * the chip falls back to the raw id, exactly as a thread chip falls back to a
 * short id. Nothing here posts, joins, or wakes anything.
 */

import { useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { QueryClientContext, type QueryClient } from '@tanstack/react-query';

import { createBotRoomApi, roomQueryKey } from './botRooms';
import { ROOM_ITEMS_QUERY_KEY } from './useConversationList';
import type { KikiClient } from './client';

export interface RoomRefDirectoryEntry {
  readonly name: string | undefined;
  /** False once the list loaded and carried no such room (deleted, or not a member). */
  readonly exists: boolean;
  readonly memberCount: number | undefined;
}

export interface RoomRefDirectory {
  readonly lookup: (roomId: string) => RoomRefDirectoryEntry;
}

const unknownEntry: RoomRefDirectoryEntry = { name: undefined, exists: false, memberCount: undefined };

const noopSubscribe = () => () => {};

/** Bumped by the room queries, so a late-arriving room list re-reads the chips. */
function roomCacheVersion(client: QueryClient | undefined): number {
  if (client === undefined) return 0;
  let sum = 0;
  for (const query of client.getQueryCache().getAll()) {
    if (query.queryKey[0] !== ROOM_ITEMS_QUERY_KEY[0]) continue;
    sum += query.state.dataUpdateCount;
  }
  return sum;
}

/**
 * Rooms inside one cached list payload. Two shapes reach this cache: the room
 * summaries the sidebar reads (`GET /rooms/items`, which carry `title` and a
 * `memberCount`) and the full room documents (`GET /rooms`, which carry `name`
 * and a `members` array). Both are read by the fields they actually use, so a
 * surface that cached one still names a room seeded by the other.
 */
function roomsIn(data: unknown): { id: string; name: string; members: number | undefined }[] {
  if (Array.isArray(data)) return roomsIn({ items: data });
  if (typeof data !== 'object' || data === null) return [];
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const room = item as { id?: unknown; name?: unknown; title?: unknown; members?: unknown; memberCount?: unknown };
    if (typeof room.id !== 'string') return [];
    const name = typeof room.name === 'string' ? room.name : typeof room.title === 'string' ? room.title : room.id;
    const members = Array.isArray(room.members) ? room.members.length
      : typeof room.memberCount === 'number' ? room.memberCount : undefined;
    return [{ id: room.id, name, members }];
  });
}

function snapshotOf(client: QueryClient | undefined): Map<string, { name: string; members: number | undefined }> {
  const rooms = new Map<string, { name: string; members: number | undefined }>();
  if (client === undefined) return rooms;
  for (const [, data] of client.getQueriesData({ queryKey: ROOM_ITEMS_QUERY_KEY })) {
    for (const room of roomsIn(data)) {
      if (!rooms.has(room.id)) rooms.set(room.id, { name: room.name, members: room.members });
    }
  }
  return rooms;
}

/**
 * The directory for the linked room ids in view. `ids` drives a one-shot fetch
 * for rooms the cached list does not carry; a failed lookup (deleted room,
 * other host) stays a raw-id chip rather than retrying on every render.
 *
 * Reading never requires a QueryClient, so a read-only surface that has no
 * provider mounted still gets whatever cache it can see, and an empty one.
 */
export function useRoomRefDirectory(
  ids: readonly string[] = [],
  fetchRoom?: (roomId: string) => Promise<{ id: string; name: string; members?: readonly unknown[] }>,
): RoomRefDirectory {
  const client = useContext(QueryClientContext);
  const subscribe = useCallback(
    (listener: () => void) => (client === undefined ? noopSubscribe() : client.getQueryCache().subscribe(listener)),
    [client],
  );
  const version = useSyncExternalStore(subscribe, () => roomCacheVersion(client), () => 0);
  const snapshot = useMemo(() => snapshotOf(client), [client, version]);
  useEffect(() => {
    if (client === undefined || fetchRoom === undefined) return;
    const known = snapshotOf(client);
    for (const id of new Set(ids)) {
      if (known.has(id) || client.getQueryState(roomQueryKey(id)) !== undefined) continue;
      void client.prefetchQuery({ queryKey: roomQueryKey(id), queryFn: () => fetchRoom(id), staleTime: 60_000, retry: false })
        .catch(() => undefined);
    }
  }, [client, fetchRoom, ids, snapshot]);
  return useMemo(
    () => ({
      lookup: (roomId: string): RoomRefDirectoryEntry => {
        const hit = snapshot.get(roomId);
        return hit === undefined ? unknownEntry : { name: hit.name, exists: true, memberCount: hit.members };
      },
    }),
    [snapshot],
  );
}

/** `client.getRoom`, shaped for the directory's fetcher. */
export function roomRefFetcher(client: KikiClient): (roomId: string) => Promise<{ id: string; name: string; members?: readonly unknown[] }> {
  return async (roomId) => {
    const room = await createBotRoomApi(client).getRoom(roomId);
    if (room === undefined) throw new Error(`Room ${roomId} is not available.`);
    return room;
  };
}
