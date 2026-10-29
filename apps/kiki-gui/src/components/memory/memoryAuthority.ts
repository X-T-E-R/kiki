/**
 * Which store owns memory right now, read once per connection and shared by
 * every control on /memory.
 *
 * `governed` gates the SQLite-only reads and actions (sources, decisions,
 * historical revisions, permanent forget). `writable` gates every edit; only
 * `migrating` (the automatic startup upgrade) and `readonly` withhold it. A
 * `legacy` file store that is not migrating keeps its ordinary reads and
 * edits: a server without the automatic upgrade stays there, and the server
 * enforces any barrier of its own. A
 * server that cannot answer (an older build without the route, or a failed
 * read) stays on the behaviour the page always had: edits remain available,
 * the server keeps enforcing revisions, and nothing governed is offered. The
 * page never infers a governed store it has not been told about.
 */

import { createContext, useContext, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { MemoryAuthorityState } from '../../lib/client';
import { useConnection } from '../../state/connection';

export const MEMORY_AUTHORITY_QUERY_KEY = ['memory-authority'] as const;

export type MemoryStoreKind = 'legacy' | 'governed' | 'migrating' | 'readonly' | 'unknown';

export interface MemoryAuthorityView {
  readonly state: MemoryAuthorityState | undefined;
  readonly kind: MemoryStoreKind;
  readonly governed: boolean;
  readonly writable: boolean;
  readonly error: unknown;
  readonly loading: boolean;
  readonly refetch: () => void;
}

export function memoryStoreKind(state: MemoryAuthorityState | undefined): MemoryStoreKind {
  if (state === undefined) return 'unknown';
  if (state.mode === 'readonly') return 'readonly';
  if (state.mode === 'migrating') return 'migrating';
  return state.backend === 'sqlite' ? 'governed' : 'legacy';
}

/** How often a running upgrade is re-read. */
export const MIGRATION_POLL_MS = 2_000;

export function useMemoryAuthorityQuery(enabled = true): MemoryAuthorityView {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: MEMORY_AUTHORITY_QUERY_KEY,
    queryFn: ({ signal }) => client.memoryAuthority(signal),
    enabled,
    staleTime: 10_000,
    // A running upgrade is followed closely; a failed one waits for the reader.
    refetchInterval: (current) => {
      const migration = current.state.data?.migration;
      const upgrading = current.state.data?.mode === 'migrating';
      return upgrading && migration?.phase !== 'failed' ? MIGRATION_POLL_MS : 30_000;
    },
    retry: false,
  });
  const state = query.data;
  const kind = memoryStoreKind(state);
  // When the upgrade finishes, everything read while it ran is re-read. The
  // selection and any open draft are page state and stay where they are.
  const previous = useRef(kind);
  useEffect(() => {
    if ((previous.current === 'migrating' || previous.current === 'legacy') && kind === 'governed') {
      for (const key of ['memory', 'memory-journal', 'memory-related', 'memory-inbox', 'memory-provenance', 'memory-detail']) void queryClient.invalidateQueries({ queryKey: [key] });
    }
    previous.current = kind;
  }, [kind, queryClient]);
  return {
    state,
    kind,
    governed: kind === 'governed' || (kind === 'readonly' && state?.backend === 'sqlite'),
    writable: kind === 'legacy' || kind === 'governed' || kind === 'unknown',
    error: query.error,
    loading: query.isPending && enabled,
    refetch: () => { void query.refetch(); },
  };
}

const FALLBACK: MemoryAuthorityView = {
  state: undefined, kind: 'unknown', governed: false, writable: true, error: null, loading: false, refetch: () => {},
};

export const MemoryAuthorityContext = createContext<MemoryAuthorityView>(FALLBACK);

export function useMemoryAuthority(): MemoryAuthorityView {
  return useContext(MemoryAuthorityContext);
}
