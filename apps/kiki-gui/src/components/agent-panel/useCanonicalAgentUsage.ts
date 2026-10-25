import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import type { AgentCapabilitiesResponse, AgentPanelMetrics } from '@kiki/protocol';
import { useOptionalConnection } from '../../state/connection';
import type { ContextMeterUsage } from '../ContextMeter';
import { panelMetricsCapabilitiesKey } from './panelMetricsQuery';

type CanonicalAgentUsageState = 'inactive' | 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';

type ReadState = {
  readonly identity: string;
  readonly status: Exclude<CanonicalAgentUsageState, 'inactive' | 'idle' | 'unavailable'>;
  readonly data?: AgentCapabilitiesResponse;
};

export interface CanonicalAgentUsageResult {
  readonly hasIdentity: boolean;
  readonly state: CanonicalAgentUsageState;
  readonly usage?: ContextMeterUsage;
  readonly partial: boolean;
}

const known = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value) && value >= 0;

function inputOther(
  input: number | null | undefined,
  cacheRead: number | null | undefined,
  cacheWrite: number | null | undefined,
): number | null {
  if (!known(input) || !known(cacheRead) || !known(cacheWrite)) return null;
  const result = input - cacheRead - cacheWrite;
  return result >= 0 ? result : null;
}

/** Maps one canonical panel row without converting an unknown field to zero. */
export function mapCanonicalAgentUsage(metrics: AgentPanelMetrics | undefined): ContextMeterUsage {
  return {
    input_tokens: inputOther(metrics?.inputTokens, metrics?.cacheReadTokens, metrics?.cacheWriteTokens),
    output_tokens: known(metrics?.outputTokens) ? metrics.outputTokens : null,
    cache_read_tokens: known(metrics?.cacheReadTokens) ? metrics.cacheReadTokens : null,
    cache_creation_tokens: known(metrics?.cacheWriteTokens) ? metrics.cacheWriteTokens : null,
    total_cost_usd: known(metrics?.totalCostUsd) ? metrics.totalCostUsd : null,
  };
}

export function useCanonicalAgentUsage({
  open,
  sessionId,
  agentId,
}: {
  readonly open: boolean;
  readonly sessionId?: string;
  readonly agentId?: string;
}): CanonicalAgentUsageResult {
  const connection = useOptionalConnection();
  const queryClient = useContext(QueryClientContext);
  const hasIdentity = sessionId !== undefined && sessionId !== '' && agentId !== undefined && agentId !== '';
  const settleQuery = useMemo(() => hasIdentity ? {
    session_id: sessionId,
    agent_id: agentId,
    metrics_settle: true as const,
    metrics_only: true as const,
    metrics_agent_ids: [agentId],
  } : undefined, [agentId, hasIdentity, sessionId]);
  const headerQuery = useMemo(() => hasIdentity ? {
    session_id: sessionId,
    agent_id: agentId,
    metrics_settle: false as const,
    metrics_only: true as const,
  } : undefined, [agentId, hasIdentity, sessionId]);
  const keyScope = useMemo(() => [
    connection?.spaceKey ?? 'main',
    connection?.scopeId ?? 'local',
    connection?.meta?.server_id ?? '',
  ] as const, [connection?.meta?.server_id, connection?.scopeId, connection?.spaceKey]);
  // Both keys are owned by this waiter. The settle key is intentionally not
  // the right-rail header key, so closing the card cannot cancel that observer.
  const settleQueryKey = useMemo(() => panelMetricsCapabilitiesKey(
    settleQuery ?? { session_id: '', agent_id: '', metrics_settle: true, metrics_only: true, metrics_agent_ids: [] },
    ...keyScope,
  ), [keyScope, settleQuery]);
  const headerQueryKey = useMemo(() => panelMetricsCapabilitiesKey(
    headerQuery ?? { session_id: '', agent_id: '', metrics_settle: false, metrics_only: true },
    ...keyScope,
  ), [headerQuery, keyScope]);
  const readIdentity = `${keyScope[0]}:${keyScope[1]}:${keyScope[2]}:${sessionId ?? ''}:${agentId ?? ''}`;
  const klient = connection?.klient;
  const klientRef = useRef(klient);
  klientRef.current = klient;
  const canRead = open && hasIdentity && queryClient !== undefined && klient !== undefined && settleQuery !== undefined && headerQuery !== undefined;
  const [read, setRead] = useState<ReadState | undefined>(undefined);

  useEffect(() => {
    if (!canRead || queryClient === undefined || klientRef.current === undefined || settleQuery === undefined || headerQuery === undefined) {
      setRead(undefined);
      return;
    }
    const cachedSettle = queryClient.getQueryState<AgentCapabilitiesResponse>(settleQueryKey);
    const cachedHeader = queryClient.getQueryState<AgentCapabilitiesResponse>(headerQueryKey);
    const cached = (cachedHeader?.dataUpdatedAt ?? 0) >= (cachedSettle?.dataUpdatedAt ?? 0)
      ? cachedHeader?.data ?? cachedSettle?.data
      : cachedSettle?.data ?? cachedHeader?.data;
    let settleComplete = cached?.metrics?.[agentId]?.usageComplete === true;
    if (cached !== undefined) setRead({ identity: readIdentity, status: 'ready', data: cached });
    else setRead({ identity: readIdentity, status: 'loading' });
    let active = true;
    const refresh = (mode: 'settle' | 'header') => {
      const requestQuery = mode === 'settle' ? settleQuery : headerQuery;
      const requestKey = mode === 'settle' ? settleQueryKey : headerQueryKey;
      void queryClient.fetchQuery({
        queryKey: requestKey,
        queryFn: ({ signal }) => {
          const currentKlient = klientRef.current;
          if (currentKlient === undefined) throw new Error('Agent usage client unavailable');
          return currentKlient.global.agentPanel.read(requestQuery, { signal });
        },
        staleTime: 15_000,
        retry: false,
      }).then(
        (data) => {
          if (!active) return;
          settleComplete = data.metrics?.[agentId]?.usageComplete === true;
          setRead({ identity: readIdentity, status: 'ready', data });
        },
        () => { if (active) setRead({ identity: readIdentity, status: 'error' }); },
      );
    };
    refresh(settleComplete ? 'header' : 'settle');
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      refresh(settleComplete ? 'header' : 'settle');
    }, 15_000);
    return () => {
      active = false;
      window.clearInterval(interval);
      void queryClient.cancelQueries({ queryKey: settleQueryKey, exact: true });
      void queryClient.cancelQueries({ queryKey: headerQueryKey, exact: true });
    };
  }, [agentId, canRead, headerQuery, headerQueryKey, queryClient, readIdentity, settleQuery, settleQueryKey]);

  const currentRead = read?.identity === readIdentity ? read : undefined;
  if (!hasIdentity) return { hasIdentity: false, state: 'inactive', partial: false };
  if (!open) return { hasIdentity: true, state: 'idle', partial: false };
  if (queryClient === undefined || klient === undefined || settleQuery === undefined) {
    return {
      hasIdentity: true,
      state: 'unavailable',
      usage: mapCanonicalAgentUsage(undefined),
      partial: false,
    };
  }
  if (currentRead?.status === 'error') return { hasIdentity: true, state: 'error', partial: false };
  if (currentRead?.status !== 'ready' || currentRead.data === undefined) {
    return { hasIdentity: true, state: 'loading', partial: false };
  }
  const metrics = currentRead.data.metrics?.[agentId];
  return {
    hasIdentity: true,
    state: 'ready',
    usage: mapCanonicalAgentUsage(metrics),
    partial: metrics?.usagePartial === true || metrics?.costPartial === true,
  };
}
