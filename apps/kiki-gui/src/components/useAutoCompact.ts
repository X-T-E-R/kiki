/**
 * useAutoCompact — reads and writes one agent's automatic-compaction point
 * (`GET/PATCH /sessions/{id}/agents/{agent}/auto-compact`). The server is the
 * only authority for the effective value; the hook caches its answer, keeps
 * the last known default (only PATCH responses carry it) and refreshes the
 * catalogs a saved default lands in.
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { AutoCompactStatus, AutoCompactWrite, AutoCompactWriteResult } from '@kiki/protocol';

import { useConnection } from '../state/connection';

export function autoCompactQueryKey(sessionId: string, agentId: string): readonly string[] {
  return ['autoCompact', sessionId, agentId];
}

function autoCompactDefaultKey(sessionId: string, agentId: string): readonly string[] {
  return ['autoCompactDefault', sessionId, agentId];
}

export interface AutoCompactHandle {
  readonly status: AutoCompactStatus | undefined;
  /** Default without the session override, known after the first write. */
  readonly defaultStatus: AutoCompactStatus | undefined;
  readonly unavailable: boolean;
  readonly refresh: () => void;
  readonly write: (input: AutoCompactWrite) => Promise<AutoCompactWriteResult>;
}

export function useAutoCompact(input: {
  readonly sessionId: string | undefined;
  readonly agentId: string;
  /** Re-reads when the bound model or its configured window changes. */
  readonly refreshKey?: string;
}): AutoCompactHandle | undefined {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const { sessionId, agentId, refreshKey } = input;
  const enabled = sessionId !== undefined;
  const key = autoCompactQueryKey(sessionId ?? '', agentId);
  const query = useQuery({
    queryKey: [...key, refreshKey ?? ''],
    queryFn: () => client.getAutoCompact(sessionId!, agentId),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
  const defaultQuery = useQuery<AutoCompactStatus | null>({
    queryKey: autoCompactDefaultKey(sessionId ?? '', agentId),
    queryFn: () => null,
    enabled: false,
    staleTime: Infinity,
  });

  const refresh = useCallback(() => {
    if (sessionId === undefined) return;
    void queryClient.invalidateQueries({ queryKey: autoCompactQueryKey(sessionId, agentId) });
  }, [agentId, queryClient, sessionId]);

  const write = useCallback(async (body: AutoCompactWrite) => {
    if (sessionId === undefined) throw new Error('no session');
    const result = await client.setAutoCompact(sessionId, agentId, body);
    queryClient.setQueriesData({ queryKey: autoCompactQueryKey(sessionId, agentId) }, result.effective);
    queryClient.setQueryData(autoCompactDefaultKey(sessionId, agentId), result.default);
    // A saved default lands in a catalog other screens read.
    if (body.save === 'model') void queryClient.invalidateQueries({ queryKey: ['models'] });
    if (body.save === 'profile') void queryClient.invalidateQueries({ queryKey: ['agentProfiles'] });
    if (body.save === 'global') void queryClient.invalidateQueries({ queryKey: ['config'] });
    return result;
  }, [agentId, client, queryClient, sessionId]);

  if (!enabled) return undefined;
  return {
    status: query.data,
    defaultStatus: defaultQuery.data ?? undefined,
    unavailable: query.isError,
    refresh,
    write,
  };
}
