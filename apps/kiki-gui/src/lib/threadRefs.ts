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
import { QueryClientContext, type Query, type QueryClient, type QueryKey } from '@tanstack/react-query';

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

function threadCacheVersionReader(client: QueryClient | undefined): () => number {
  let previous: readonly (readonly [Query, number])[] = [];
  let version = 0;
  return () => {
    const current = client?.getQueryCache().getAll()
      .filter((query) => isThreadRefQuery(query.queryKey) && query.state.data !== undefined)
      .map((query) => [query, query.state.dataUpdateCount] as const) ?? [];
    // Identity also detects removal/replacement when update counts are equal.
    if (current.length !== previous.length || current.some(([query, count], index) =>
      query !== previous[index]?.[0] || count !== previous[index]?.[1])) {
      previous = current;
      version += 1;
    }
    return version;
  };
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
    (listener: () => void) => (client === undefined ? noopSubscribe() : client.getQueryCache().subscribe((event) => {
      if (isThreadRefQuery(event.query.queryKey)) listener();
    })),
    [client],
  );
  const readVersion = useMemo(() => threadCacheVersionReader(client), [client]);
  const version = useSyncExternalStore(subscribe, readVersion, () => 0);
  const snapshot = useMemo(() => snapshotOf(client), [client, version]);
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
      if (client.getQueryState(['thread-ref', id]) !== undefined) continue;
      void client.prefetchQuery({ queryKey: ['thread-ref', id], queryFn: () => fetchSession(id), staleTime: 60_000, retry: false });
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
