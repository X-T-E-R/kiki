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

interface SharedRoomCacheStore {
  version: number;
  snapshot: Map<string, { name: string; members: number | undefined }> | undefined;
  readonly seenCounts: WeakMap<object, number>;
  readonly listeners: Set<() => void>;
  unsubscribe?: () => void;
}

const sharedRoomStores = new WeakMap<QueryClient, SharedRoomCacheStore>();
const EMPTY_ROOM_SNAPSHOT = new Map<string, { name: string; members: number | undefined }>();

function sharedRoomStoreFor(client: QueryClient): SharedRoomCacheStore {
  let store = sharedRoomStores.get(client);
  if (store === undefined) {
    store = { version: 0, snapshot: undefined, seenCounts: new WeakMap(), listeners: new Set() };
    sharedRoomStores.set(client, store);
  }
  return store;
}

function subscribeSharedRoomStore(client: QueryClient | undefined, listener: () => void): () => void {
  if (client === undefined) return noopSubscribe();
  const store = sharedRoomStoreFor(client);
  store.listeners.add(listener);
  if (store.unsubscribe === undefined) {
    for (const query of client.getQueryCache().getAll()) {
      if (query.queryKey[0] === ROOM_ITEMS_QUERY_KEY[0]) {
        store.seenCounts.set(query, query.state.dataUpdateCount);
      }
    }
    store.unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type !== 'added' && event.type !== 'updated' && event.type !== 'removed') return;
      if (event.query.queryKey[0] !== ROOM_ITEMS_QUERY_KEY[0]) return;
      if (event.type === 'added') {
        store.seenCounts.set(event.query, event.query.state.dataUpdateCount);
        if (event.query.state.data === undefined) return;
      } else if (event.type === 'updated') {
        const count = event.query.state.dataUpdateCount;
        const previous = store.seenCounts.get(event.query);
        if (previous === count || (previous === undefined && count === 0 && event.query.state.data === undefined)) return;
        store.seenCounts.set(event.query, count);
      } else {
        store.seenCounts.delete(event.query);
      }
      store.version += 1;
      store.snapshot = undefined;
      for (const fn of store.listeners) fn();
    });
  }
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size === 0 && store.unsubscribe !== undefined) {
      store.unsubscribe();
      store.unsubscribe = undefined;
      store.snapshot = undefined;
    }
  };
}

function readSharedRoomSnapshot(client: QueryClient | undefined): Map<string, { name: string; members: number | undefined }> {
  if (client === undefined) return EMPTY_ROOM_SNAPSHOT;
  const store = sharedRoomStoreFor(client);
  if (store.snapshot === undefined) store.snapshot = snapshotOf(client);
  return store.snapshot;
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
    (listener: () => void) => subscribeSharedRoomStore(client, listener),
    [client],
  );
  const getVersion = useCallback(
    () => (client === undefined ? 0 : sharedRoomStoreFor(client).version),
    [client],
  );
  const version = useSyncExternalStore(subscribe, getVersion, () => 0);
  const snapshot = useMemo(() => {
    void version;
    return readSharedRoomSnapshot(client);
  }, [client, version]);
  useEffect(() => {
    if (client === undefined || fetchRoom === undefined || ids.length === 0) return;
    for (const id of new Set(ids)) {
      if (snapshot.has(id) || client.getQueryState(roomQueryKey(id)) !== undefined) continue;
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
