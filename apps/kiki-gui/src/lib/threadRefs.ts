/**
 * Thread-reference directory: resolves a linked session id to the record and
 * workspace label the GUI already holds. Reads every cached session list (the
 * sidebar's pages, temporary conversations) and the metadata-only workspace
 * catalog from the query cache, and fetches a record once for an id none of
 * them carries (an archived thread, another workspace outside the current filter).
 *
 * The fetch is opt-in (`fetchSession`): the composer and injected-source
 * labels share metadata-only lookups within the connection's query cache.
 * A source with a known host is resolved only after that host matches the
 * connection. Without a query client, chips fall back to the short id.
 */

import { useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { QueryClientContext, type QueryClient, type QueryKey } from '@tanstack/react-query';

import type { Session, Workspace } from '@kiki/protocol';

import { threadRefInfoOf, type ThreadRefInfo } from '@kiki/session-core/composer';

/** The workspace label a chip and the context block show. Only `name` is read,
 * so the metadata-only catalog entry (`WorkspaceCatalogEntry`, no
 * `session_count` / `isGit`) serves it exactly like the full wire `Workspace`. */
type ThreadRefWorkspace = Pick<Workspace, 'name'>;

/** The catalog row as the cache holds it: the lookup id plus that label. */
type CachedWorkspaceLabel = Pick<Workspace, 'id' | 'name'>;

export interface ThreadRefEntry {
  readonly session: Session | undefined;
  readonly workspace: ThreadRefWorkspace | undefined;
}

export interface ThreadRefDirectory {
  readonly hostId?: string;
  readonly lookup: (sessionId: string) => ThreadRefEntry;
  readonly info: (sessionId: string) => ThreadRefInfo;
}

function isSession(value: unknown): value is Session {
  return typeof value === 'object' && value !== null
    && typeof (value as Session).id === 'string'
    && typeof (value as Session).workspace_id === 'string'
    && typeof (value as Session).updated_at === 'string';
}

/** Session records inside one cached list payload (infinite pages or `{ items }`). */
function sessionsIn(data: unknown): Session[] {
  if (typeof data !== 'object' || data === null) return [];
  const pages = (data as { pages?: unknown }).pages;
  if (Array.isArray(pages)) return pages.flatMap((page) => sessionsIn(page));
  const items = (data as { items?: unknown }).items;
  return Array.isArray(items) ? items.filter(isSession) : [];
}

function snapshotOf(client: QueryClient | undefined): { sessions: Map<string, Session>; workspaces: Map<string, ThreadRefWorkspace> } {
  const sessions = new Map<string, Session>();
  const workspaces = new Map<string, ThreadRefWorkspace>();
  if (client === undefined) return { sessions, workspaces };
  for (const [, data] of client.getQueriesData({ queryKey: ['sessions'] })) {
    for (const session of sessionsIn(data)) sessions.set(session.id, session);
  }
  for (const [, data] of client.getQueriesData({ queryKey: ['thread-ref'] })) {
    if (isSession(data) && !sessions.has(data.id)) sessions.set(data.id, data);
  }
  // App's metadata-only directory: the same key every picker reads, so a
  // rename invalidation reaches these labels with no second workspace listing.
  const listed = client.getQueryData<{ items?: readonly CachedWorkspaceLabel[] }>(['workspaces', 'catalog']);
  for (const workspace of listed?.items ?? []) workspaces.set(workspace.id, workspace);
  return { sessions, workspaces };
}

const noopSubscribe = () => () => {};

function isThreadRefQuery(key: QueryKey): boolean {
  return key[0] === 'sessions' || key[0] === 'thread-ref'
    || (key.length === 2 && key[0] === 'workspaces' && key[1] === 'catalog')
    || (key.length === 1 && key[0] === 'thread-host-id');
}

interface SharedThreadCacheStore {
  version: number;
  snapshot: { sessions: Map<string, Session>; workspaces: Map<string, ThreadRefWorkspace> } | undefined;
  readonly seenCounts: WeakMap<object, number>;
  readonly listeners: Set<() => void>;
  unsubscribe?: () => void;
}

const sharedThreadStores = new WeakMap<QueryClient, SharedThreadCacheStore>();

function sharedThreadStoreFor(client: QueryClient): SharedThreadCacheStore {
  let store = sharedThreadStores.get(client);
  if (store === undefined) {
    store = { version: 0, snapshot: undefined, seenCounts: new WeakMap(), listeners: new Set() };
    sharedThreadStores.set(client, store);
  }
  return store;
}

function subscribeSharedThreadStore(client: QueryClient | undefined, listener: () => void): () => void {
  if (client === undefined) return noopSubscribe();
  const store = sharedThreadStoreFor(client);
  store.listeners.add(listener);
  if (store.unsubscribe === undefined) {
    for (const query of client.getQueryCache().getAll()) {
      if (isThreadRefQuery(query.queryKey)) {
        store.seenCounts.set(query, query.state.dataUpdateCount);
      }
    }
    store.unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type !== 'added' && event.type !== 'updated' && event.type !== 'removed') return;
      if (!isThreadRefQuery(event.query.queryKey)) return;
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

function readSharedThreadSnapshot(client: QueryClient | undefined): { sessions: Map<string, Session>; workspaces: Map<string, ThreadRefWorkspace> } {
  if (client === undefined) return EMPTY_THREAD_SNAPSHOT;
  const store = sharedThreadStoreFor(client);
  if (store.snapshot === undefined) store.snapshot = snapshotOf(client);
  return store.snapshot;
}

const EMPTY_THREAD_SNAPSHOT = { sessions: new Map<string, Session>(), workspaces: new Map<string, ThreadRefWorkspace>() };

const THREAD_REF_PREFETCH_CONCURRENCY = 2;

interface ThreadRefPrefetchQueue {
  active: number;
  readonly queued: Set<string>;
  readonly tasks: Map<string, () => Promise<void>>;
}

const prefetchQueues = new WeakMap<QueryClient, ThreadRefPrefetchQueue>();

function enqueueThreadRefPrefetch(
  client: QueryClient,
  sessionId: string,
  fetchSession: (id: string) => Promise<Session>,
): void {
  if (client.getQueryState(['thread-ref', sessionId]) !== undefined) return;
  let state = prefetchQueues.get(client);
  if (state === undefined) {
    state = { active: 0, queued: new Set(), tasks: new Map() };
    prefetchQueues.set(client, state);
  }
  if (state.queued.has(sessionId) || state.tasks.has(sessionId)) return;
  const queue = state;
  const pump = () => {
    while (queue.active < THREAD_REF_PREFETCH_CONCURRENCY && queue.queued.size > 0) {
      const nextId = queue.queued.values().next().value;
      if (nextId === undefined) break;
      queue.queued.delete(nextId);
      const run = queue.tasks.get(nextId);
      queue.tasks.delete(nextId);
      if (run === undefined) continue;
      if (client.getQueryState(['thread-ref', nextId]) !== undefined) continue;
      queue.active += 1;
      void run().finally(() => {
        queue.active -= 1;
        pump();
      });
    }
  };
  queue.queued.add(sessionId);
  queue.tasks.set(sessionId, () =>
    client.prefetchQuery({
      queryKey: ['thread-ref', sessionId],
      queryFn: () => fetchSession(sessionId),
      staleTime: 60_000,
      retry: false,
    }),
  );
  pump();
}

/**
 * The directory for the linked ids in view. `ids` drives the one-shot fetch
 * for records no cached list carries; lookups for other ids still read the cache.
 */
export function useThreadRefDirectory(
  ids: readonly string[] = [],
  fetchSession?: (sessionId: string) => Promise<Session>,
  fetchHostId?: () => Promise<string>,
  sourceHostId?: string,
): ThreadRefDirectory {
  const client = useContext(QueryClientContext);
  const subscribe = useCallback(
    (listener: () => void) => subscribeSharedThreadStore(client, listener),
    [client],
  );
  const getVersion = useCallback(
    () => (client === undefined ? 0 : sharedThreadStoreFor(client).version),
    [client],
  );
  const version = useSyncExternalStore(subscribe, getVersion, () => 0);
  const snapshot = useMemo(() => {
    void version;
    return readSharedThreadSnapshot(client);
  }, [client, version]);
  const knownHostId = client?.getQueryData<string>(['thread-host-id']);
  const sourceMatches = sourceHostId === undefined || sourceHostId === knownHostId;
  const missing = useMemo(
    () => [...new Set(ids)].filter((id) => !snapshot.sessions.has(id)),
    [ids, snapshot],
  );
  useEffect(() => {
    if (client === undefined || fetchSession === undefined || !sourceMatches) return;
    for (const id of missing) {
      // One attempt per id: a failed lookup (deleted, other host) stays a
      // short-id chip rather than retrying on every render.
      enqueueThreadRefPrefetch(client, id, fetchSession);
    }
  }, [client, fetchSession, missing, sourceMatches]);
  const hasRefs = ids.length > 0;
  useEffect(() => {
    if (client === undefined || fetchHostId === undefined || !hasRefs) return;
    void client.prefetchQuery({ queryKey: ['thread-host-id'], queryFn: fetchHostId, staleTime: Infinity, retry: false });
  }, [client, fetchHostId, hasRefs]);
  const hostId = client?.getQueryData<string>(['thread-host-id']) ?? 'local';
  return useMemo(() => {
    const lookup = (sessionId: string): ThreadRefEntry => {
      const session = snapshot.sessions.get(sessionId);
      return { session, workspace: session === undefined ? undefined : snapshot.workspaces.get(session.workspace_id) };
    };
    return {
      hostId: knownHostId,
      lookup,
      info: (sessionId) => {
        const entry = lookup(sessionId);
        return threadRefInfoOf(sessionId, entry.session, entry.workspace, hostId);
      },
    };
  }, [snapshot, hostId, knownHostId]);
}
