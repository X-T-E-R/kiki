/**
 * useSessionSearch — the one two-layer search engine shared by the sidebar
 * and the Ctrl+K quick switcher.
 *
 * Layer 1 (local) recomputes on every keystroke from the already-loaded
 * session list and workspace list: no network, never waits. Layer 2 (content)
 * debounces, then pages `POST /search` through an infinite query; react-query
 * hands each request an AbortSignal and cancels the superseded one when the
 * key changes, so a fast typist never waits on a stale round-trip.
 */

import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';

import type { Session, Workspace } from '@kiki/protocol';

import {
  buildContentSearchBody,
  CONTENT_SEARCH_DEBOUNCE_MS,
  isSearchable,
  parseSearchQuery,
  resolveWorkspaceTerm,
  scopeContentHits,
  searchLocal,
  type LocalSessionMatch,
  type LocalWorkspaceMatch,
  type ParsedSearchQuery,
} from '@kiki/session-core/sessions';
import type { SearchMessageHit, SearchMessagesResponse } from './client';
import { useConnection } from '../state/connection';

/** Concatenate pages in server order, keeping every page's `items` verbatim —
 * duplicates re-ranked across a page boundary are kept, never collapsed. */
export function mergeSearchPages(pages: readonly SearchMessagesResponse[]): SearchMessageHit[] {
  const hits: SearchMessageHit[] = [];
  for (const page of pages) {
    for (const hit of page.items) hits.push(hit);
  }
  return hits;
}

/** Next-page cursor; the server omits `page_token` on the final page. */
export function searchNextPageParam(lastPage: SearchMessagesResponse): string | undefined {
  return lastPage.has_more ? lastPage.page_token : undefined;
}

interface LocalSession {
  readonly id: string;
  readonly title: string;
  readonly workspace_id: string;
  readonly updated_at: string;
  readonly cwd: string;
  readonly source: Session;
}

export interface SessionSearchState {
  readonly parsed: ParsedSearchQuery;
  /** Raw input is non-empty (the results surface replaces the list). */
  readonly active: boolean;
  readonly local: {
    readonly workspaces: readonly LocalWorkspaceMatch<Workspace & { root: string }>[];
    readonly sessions: readonly LocalSessionMatch<LocalSession>[];
  };
  /** The content layer is armed (≥2 chars after the debounce). */
  readonly contentActive: boolean;
  readonly contentQuery: string;
  readonly hits: readonly SearchMessageHit[];
  /** Waiting for the debounce or the first page. */
  readonly contentPending: boolean;
  readonly contentInitialError: Error | null;
  readonly contentAppendError: boolean;
  readonly building: SearchMessagesResponse['index_state'] | undefined;
  /** The server cannot provide content results; local title matches still apply. */
  readonly unavailable: SearchMessagesResponse['index_state'] | undefined;
  readonly incomplete: boolean;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly isFetching: boolean;
  readonly fetchNextPage: () => void;
  readonly retry: () => void;
  readonly retryUnavailable: () => Promise<void>;
}

export function useSessionSearch(input: {
  readonly text: string;
  readonly sessions: readonly Session[];
  readonly workspaces: readonly Workspace[];
  readonly untitled: string;
  /** Workspace ids the active filters scope to (empty = all). */
  readonly workspaceScope?: readonly string[];
  /** Session ids that pass the non-workspace filters; hits outside drop out. */
  readonly allowedSessionIds?: ReadonlySet<string>;
  readonly queryKeyPrefix?: string;
  readonly pageSize?: number;
}): SessionSearchState {
  const { client } = useConnection();
  const parsed = useMemo(() => parseSearchQuery(input.text), [input.text]);

  // `in:` narrows the scope to one workspace on top of the chip filters.
  const inWorkspace = useMemo(
    () => resolveWorkspaceTerm(parsed.workspaceTerm, input.workspaces),
    [parsed.workspaceTerm, input.workspaces],
  );
  const scope = useMemo(
    () => (inWorkspace !== undefined ? [inWorkspace.id] : [...(input.workspaceScope ?? [])]),
    [inWorkspace, input.workspaceScope],
  );
  const scopeKey = scope.join(',');

  const localSessions = useMemo<LocalSession[]>(
    () =>
      input.sessions.map((session) => ({
        id: session.id,
        title:
          session.title.trim() !== ''
            ? session.title
            : (session.last_prompt?.trim() || input.untitled),
        workspace_id: session.workspace_id,
        updated_at: session.updated_at,
        cwd: session.metadata.cwd,
        source: session,
      })),
    [input.sessions, input.untitled],
  );
  const local = useMemo(() => {
    const scoped = scope.length === 0
      ? localSessions
      : localSessions.filter((session) => scope.includes(session.workspace_id));
    return searchLocal({
      text: parsed.text,
      sessions: scoped,
      workspaces: parsed.workspaceTerm === undefined ? input.workspaces : [],
    });
  }, [localSessions, input.workspaces, parsed.text, parsed.workspaceTerm, scope]);

  // Debounced content layer: the text AND its scope settle together.
  const [debounced, setDebounced] = useState({ text: '', role: undefined as ParsedSearchQuery['role'], scopeKey: '' });
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced({ text: parsed.text.trim(), role: parsed.role, scopeKey });
    }, CONTENT_SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [parsed.text, parsed.role, scopeKey]);
  const contentActive = isSearchable(debounced.text);
  const debouncedScope = debounced.scopeKey === '' ? [] : debounced.scopeKey.split(',');

  const query = useInfiniteQuery({
    queryKey: [input.queryKeyPrefix ?? 'global-search', debounced.text, debounced.role ?? '', debounced.scopeKey],
    queryFn: ({ signal, pageParam }) =>
      client.searchMessages(
        buildContentSearchBody({
          text: debounced.text,
          role: debounced.role,
          workspaceIds: debouncedScope,
          pageSize: input.pageSize,
          pageToken: pageParam,
        }),
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: searchNextPageParam,
    enabled: contentActive,
    staleTime: 15_000,
    refetchInterval: (current) => current.state.data?.pages.some((page) => page.index_state.state === 'building')
      ? 2_000 : false,
  });

  const hits = useMemo(
    () =>
      scopeContentHits(mergeSearchPages(query.data?.pages ?? []), {
        workspaceIds: debouncedScope,
        allowedSessionIds: input.allowedSessionIds,
      }),
    // debouncedScope is derived from debounced.scopeKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query.data, debounced.scopeKey, input.allowedSessionIds],
  );
  const building = query.data?.pages.findLast((page) => page.index_state.state === 'building')?.index_state;
  const unavailable = query.data?.pages.findLast((page) => page.index_state.state === 'unavailable')?.index_state;
  const incomplete = query.data?.pages.some((page) => page.incomplete !== undefined) === true;
  const typedContent = isSearchable(parsed.text);
  const waitingDebounce = typedContent && parsed.text.trim() !== debounced.text;

  return {
    parsed,
    active: input.text.trim() !== '',
    local,
    contentActive,
    contentQuery: debounced.text,
    hits: contentActive ? hits : [],
    contentPending: typedContent && (waitingDebounce || (contentActive && query.isPending)),
    contentInitialError: query.isError && query.data === undefined ? (query.error) : null,
    contentAppendError: query.isFetchNextPageError,
    building,
    unavailable,
    incomplete,
    hasNextPage: contentActive && query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetching: query.isFetching,
    fetchNextPage: () => { void query.fetchNextPage(); },
    retry: () => { void (query.data === undefined ? query.refetch() : query.fetchNextPage()); },
    retryUnavailable: async () => {
      await client.retrySearchIndexer();
      await query.refetch();
    },
  };
}
