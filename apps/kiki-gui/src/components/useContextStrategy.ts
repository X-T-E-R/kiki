/**
 * useContextStrategy — reads and writes one agent's context-renewal strategy
 * (`GET/PATCH /sessions/{id}/agents/{agent}/context-strategy`) and runs a
 * manual compaction with a chosen strategy (`POST /sessions/{id}:compact`).
 * The server resolves the effective strategy and its layer; the hook only
 * caches the answer. Only the main agent carries a session override, so a
 * subagent handle is read-only.
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ContextStrategyStatus } from '@kiki/protocol';
import { MAIN_AGENT_ID } from '@kiki/session-core/session';

import { useConnection } from '../state/connection';

export type ContextStrategy = ContextStrategyStatus['strategy'];
/** Strategies a manual compaction can be asked for; auto resolves per run. */
export type ManualCompactStrategy = 'summarize' | 'fresh';

export function contextStrategyQueryKey(sessionId: string, agentId: string): readonly string[] {
  return ['contextStrategy', sessionId, agentId];
}

export interface ContextStrategyHandle {
  readonly status: ContextStrategyStatus | undefined;
  /** The main agent can hold a session override; subagents only read. */
  readonly writable: boolean;
  readonly refresh: () => void;
  /** `null` clears the session override (back to the inherited layer). */
  readonly write: (strategy: ContextStrategy | null) => Promise<ContextStrategyStatus>;
  /** Writes `strategy` as the global default and drops the session override. */
  readonly saveGlobal: (strategy: ContextStrategy) => Promise<ContextStrategyStatus>;
  /** Manual compaction; no strategy runs the session's effective one. */
  readonly compact: (strategy?: ManualCompactStrategy) => Promise<import('@kiki/protocol').CompactSessionResponse | void>;
}

export function useContextStrategy(input: {
  readonly sessionId: string | undefined;
  readonly agentId: string;
}): ContextStrategyHandle | undefined {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const { sessionId, agentId } = input;
  const enabled = sessionId !== undefined;
  const query = useQuery({
    queryKey: contextStrategyQueryKey(sessionId ?? '', agentId),
    queryFn: () => client.getContextStrategy(sessionId!, agentId),
    enabled,
    staleTime: 30_000,
    retry: false,
  });

  const refresh = useCallback(() => {
    if (sessionId === undefined) return;
    void queryClient.invalidateQueries({ queryKey: contextStrategyQueryKey(sessionId, agentId) });
  }, [agentId, queryClient, sessionId]);

  const write = useCallback(async (strategy: ContextStrategy | null) => {
    if (sessionId === undefined) throw new Error('no session');
    const status = await client.setContextStrategy(sessionId, agentId, { strategy });
    queryClient.setQueryData(contextStrategyQueryKey(sessionId, agentId), status);
    return status;
  }, [agentId, client, queryClient, sessionId]);

  const saveGlobal = useCallback(async (strategy: ContextStrategy) => {
    if (sessionId === undefined) throw new Error('no session');
    const status = await client.setContextStrategy(sessionId, agentId, { strategy, save: 'global' });
    queryClient.setQueryData(contextStrategyQueryKey(sessionId, agentId), status);
    void queryClient.invalidateQueries({ queryKey: ['config'] });
    return status;
  }, [agentId, client, queryClient, sessionId]);

  const compact = useCallback(async (strategy?: ManualCompactStrategy) => {
    if (sessionId === undefined) throw new Error('no session');
    // The compact route names the fresh strategy `relay`.
    const receipt = await client.compactSession(sessionId, strategy === undefined ? {} : { strategy: strategy === 'fresh' ? 'relay' : 'summarize' });
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    return receipt;
  }, [client, queryClient, sessionId]);

  // An engine without the route (404 / error) keeps the card as it was.
  if (!enabled || query.isError) return undefined;
  return {
    status: query.data,
    writable: agentId === MAIN_AGENT_ID,
    refresh,
    write,
    saveGlobal,
    compact,
  };
}
