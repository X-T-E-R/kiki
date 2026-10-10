import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProviderQuotaMeter, ProviderQuotaSnapshot, ProviderQuotaSource } from '@kiki/protocol';
import { useConnection } from '../state/connection';

export type { ProviderQuotaMeter, ProviderQuotaSnapshot, ProviderQuotaSource } from '@kiki/protocol';
export type ProviderQuotaStatus = ProviderQuotaSource['status'];

export function formatWindowPeriod(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds <= 0) return undefined;
  if (seconds === 5 * 3600) return '5h';
  if (seconds === 24 * 3600) return '1d';
  if (seconds === 7 * 24 * 3600) return '7d';
  if (seconds >= 28 * 24 * 3600 && seconds <= 31 * 24 * 3600) return 'Month';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1)}h`;
  return `${(seconds / 86400).toFixed(seconds % 86400 === 0 ? 0 : 1)}d`;
}

export function meterToneClass(utilization: number): string {
  if (utilization >= 100) return 'bg-danger text-danger';
  if (utilization >= 80) return 'bg-amber-rule text-amber-ink';
  return 'bg-accent text-accent';
}

export function statusBadgeInfo(status: ProviderQuotaStatus): {
  readonly labelKey: string;
  readonly toneClass: string;
} {
  switch (status) {
    case 'ready':
      return { labelKey: 'usage.quota.status.ok', toneClass: 'border-hairline bg-panel text-ink-soft' };
    case 'stale':
      return { labelKey: 'usage.quota.status.stale', toneClass: 'border-amber-rule/40 bg-amber-card text-amber-ink' };
    case 'auth_required':
      return { labelKey: 'usage.quota.status.auth_required', toneClass: 'border-danger/40 bg-danger/10 text-danger' };
    case 'off':
    case 'unsupported':
      return { labelKey: `usage.quota.status.${status}`, toneClass: 'border-hairline bg-panel text-ink-faint' };
    case 'error':
      return { labelKey: 'usage.quota.status.error', toneClass: 'border-danger/30 bg-danger/5 text-danger' };
    case 'unknown':
      return { labelKey: 'usage.quota.status.unknown', toneClass: 'border-hairline bg-panel text-ink-faint' };
  }
}

export function normalizeQuotaSources(snapshot: ProviderQuotaSnapshot | null | undefined): readonly ProviderQuotaSource[] {
  return snapshot?.sources ?? [];
}

export function isSourceLocked(source: ProviderQuotaSource, now = Date.now()): boolean {
  if (!source.refresh_after) return false;
  return new Date(source.refresh_after).getTime() > now;
}

export function isSourceRefreshable(source: ProviderQuotaSource, now = Date.now()): boolean {
  return source.enabled && source.supported && !isSourceLocked(source, now);
}

/** A missing total never becomes an inferred usage ratio. Percent meters already carry plan percentages. */
export function meterUtilization(meter: ProviderQuotaMeter): number | undefined {
  if (meter.unit === 'percent') {
    if (meter.used !== null) return meter.used;
    if (meter.remaining !== null && meter.limit !== null && meter.limit > 0) {
      return Math.round((1 - meter.remaining / meter.limit) * 100);
    }
  }
  if (meter.used !== null && meter.limit !== null && meter.limit > 0) {
    return Math.round((meter.used / meter.limit) * 100);
  }
  return undefined;
}

export function useProviderQuotas(options?: { readonly enabled?: boolean }) {
  const { client, scopeId, wsStatus } = useConnection();
  const queryClient = useQueryClient();
  const queryKey = ['provider-quotas', scopeId];
  const query = useQuery({
    queryKey,
    queryFn: () => client.getProviderQuotas(),
    refetchOnWindowFocus: false,
    retry: false,
    enabled: options?.enabled ?? true,
  });
  const refreshMutation = useMutation({
    mutationFn: (sourceId: string) => client.refreshProviderQuota(sourceId),
    onSuccess: (data) => { queryClient.setQueryData(queryKey, data); },
  });
  const setEnabledMutation = useMutation({
    mutationFn: ({ sourceId, enabled }: { sourceId: string; enabled: boolean }) => client.setProviderQuotaEnabled(sourceId, enabled),
    onSuccess: (data) => { queryClient.setQueryData(queryKey, data); },
  });
  return {
    snapshot: query.data,
    loading: query.isPending,
    isError: query.isError,
    error: query.error,
    stale: query.isError || wsStatus !== 'open',
    refetch: query.refetch,
    isRefetching: query.isRefetching,
    refreshSource: (sourceId: string) => refreshMutation.mutateAsync(sourceId),
    isRefreshingSource: refreshMutation.isPending,
    refreshingSourceId: refreshMutation.isPending ? refreshMutation.variables : undefined,
    setSourceEnabled: (sourceId: string, enabled: boolean) => setEnabledMutation.mutateAsync({ sourceId, enabled }),
  };
}
