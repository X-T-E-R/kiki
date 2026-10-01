/**
 * Thread-reference directory: resolves a linked session id to the record and
 * workspace the GUI already holds. Reads every cached session list (the
 * sidebar's pages, temporary conversations) and the workspace list from the
 * query cache, and fetches a record once for an id none of them carries (an
 * archived thread, another workspace outside the current filter).
 *
 * The fetch is opt-in (`fetchSession`): the composer, which owns a client,
 * passes it; read-only surfaces (the transcript) read the cache only, which
 * the composer's fetches also fill. Without a query client every id resolves
 * to nothing and chips fall back to the short id.
 */

import { useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { QueryClientContext, type QueryClient } from '@tanstack/react-query';

import type { Session, Workspace } from '@kiki/protocol';

import { threadRefInfoOf, type ThreadRefInfo } from '@kiki/session-core/composer';

export interface ThreadRefEntry {
  readonly session: Session | undefined;
  readonly workspace: Workspace | undefined;
}

export interface ThreadRefDirectory {
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

function snapshotOf(client: QueryClient | undefined): { sessions: Map<string, Session>; workspaces: Map<string, Workspace> } {
  const sessions = new Map<string, Session>();
  const workspaces = new Map<string, Workspace>();
  if (client === undefined) return { sessions, workspaces };
  for (const [, data] of client.getQueriesData({ queryKey: ['sessions'] })) {
    for (const session of sessionsIn(data)) sessions.set(session.id, session);
  }
  for (const [, data] of client.getQueriesData({ queryKey: ['thread-ref'] })) {
    if (isSession(data) && !sessions.has(data.id)) sessions.set(data.id, data);
  }
  const listed = client.getQueryData<{ items?: Workspace[] }>(['workspaces']);
  for (const workspace of listed?.items ?? []) workspaces.set(workspace.id, workspace);
  return { sessions, workspaces };
}

const noopSubscribe = () => () => {};

/**
 * The directory for the linked ids in view. `ids` drives the one-shot fetch
 * for records no cached list carries; lookups for other ids still read the cache.
 */
export function useThreadRefDirectory(
  ids: readonly string[] = [],
  fetchSession?: (sessionId: string) => Promise<Session>,
  fetchHostId?: () => Promise<string>,
): ThreadRefDirectory {
  const client = useContext(QueryClientContext);
  // Re-render on cache changes; the version counter keeps the snapshot stable.
  const subscribe = useCallback(
    (listener: () => void) => (client === undefined ? noopSubscribe() : client.getQueryCache().subscribe(listener)),
    [client],
  );
  const version = useSyncExternalStore(
    subscribe,
    () => (client === undefined ? 0 : client.getQueryCache().getAll().reduce((sum, query) => sum + query.state.dataUpdateCount, 0)),
    () => 0,
  );
  const snapshot = useMemo(() => snapshotOf(client), [client, version]);
  const missing = useMemo(
    () => [...new Set(ids)].filter((id) => !snapshot.sessions.has(id)),
    [ids, snapshot],
  );
  useEffect(() => {
    if (client === undefined || fetchSession === undefined) return;
    for (const id of missing) {
      // One attempt per id: a failed lookup (deleted, other host) stays a
      // short-id chip rather than retrying on every render.
      if (client.getQueryState(['thread-ref', id]) !== undefined) continue;
      void client.prefetchQuery({ queryKey: ['thread-ref', id], queryFn: () => fetchSession(id), staleTime: 60_000, retry: false });
    }
  }, [client, fetchSession, missing]);
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
      lookup,
      info: (sessionId) => {
        const entry = lookup(sessionId);
        return threadRefInfoOf(sessionId, entry.session, entry.workspace, hostId);
      },
    };
  }, [snapshot, hostId]);
}
