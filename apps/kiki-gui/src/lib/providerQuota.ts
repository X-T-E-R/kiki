import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProviderCatalogItem, ProviderQuotaMeter, ProviderQuotaSnapshot, ProviderQuotaSource } from '@kiki/protocol';
import { useConnection } from '../state/connection';
import {
  configuredEngineDescriptors, engineDisplayOf, engineOverridesOf, engineVisibilityOf,
} from '../components/settings/profileEditor/engines';

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
    return undefined;
  }
  if (meter.used !== null && meter.limit !== null && meter.limit > 0) {
    return Math.round((meter.used / meter.limit) * 100);
  }
  return undefined;
}

export type MeterValueReading =
  | { readonly kind: 'used' | 'remaining' | 'balance' | 'spent' | 'ratio'; readonly value: string }
  | { readonly kind: 'unknown' };

/**
 * Classifies how a meter's numeric state should be read aloud. Missing numbers
 * stay explicitly `'unknown'` rather than turning into zero or an empty dash.
 */
export function meterValue(meter: ProviderQuotaMeter): MeterValueReading {
  const { used, limit, remaining } = meter;
  const util = meterUtilization(meter);
  if (meter.unit === 'percent') {
    if (used !== null) return { kind: 'used', value: `${Math.round(used)}%` };
    if (remaining !== null) return { kind: 'remaining', value: `${Math.round(remaining)}%` };
    return { kind: 'unknown' };
  }
  if (meter.unit === 'money') {
    const curr = meter.currency ?? meter.unit_label;
    if (remaining !== null) return { kind: 'balance', value: `${remaining.toFixed(2)} ${curr}`.trim() };
    if (used !== null) return { kind: 'spent', value: `${used.toFixed(2)} ${curr}`.trim() };
    return { kind: 'unknown' };
  }
  if (used !== null && limit !== null) {
    const pct = util !== undefined ? ` · ${Math.round(util)}%` : '';
    return { kind: 'ratio', value: `${used}/${limit}${pct} ${meter.unit_label}`.trim() };
  }
  if (remaining !== null) {
    return { kind: 'remaining', value: `${remaining} ${meter.unit_label}`.trim() };
  }
  if (used !== null) {
    return { kind: 'used', value: `${used} ${meter.unit_label}`.trim() };
  }
  return { kind: 'unknown' };
}

/**
 * Which external engines the quota page speaks for: the ones the user turned on
 * in Settings › Connections. Read from the same display records the pickers use,
 * so the two never disagree; hiding here never writes to them.
 */
export interface QuotaEngineScope {
  /** `agent_executor_display.externals_visible`; false closes every external engine. */
  readonly externalsVisible: boolean;
  /** Engines with an explicit `show_in_profile_list = true`. */
  readonly enabled: ReadonlySet<string>;
  /** Engines with an explicit `show_in_profile_list = false`. */
  readonly disabled: ReadonlySet<string>;
  /** Engines with a user-authored `[agent_executors.<id>]` descriptor. */
  readonly configured: ReadonlySet<string>;
}

/** An explicit on counts; a user-written descriptor counts unless explicitly turned off. */
export function isEngineInQuotaScope(engineId: string, scope: QuotaEngineScope): boolean {
  if (!scope.externalsVisible) return false;
  if (scope.enabled.has(engineId)) return true;
  return !scope.disabled.has(engineId) && scope.configured.has(engineId);
}

export interface ArrangedQuotaSources {
  /** Enabled sources with an official quota API (attention items first). */
  readonly live: readonly ProviderQuotaSource[];
  /** Subset of `live` whose effective status is `auth_required` or `error`. */
  readonly attention: readonly ProviderQuotaSource[];
  /** Subset of `live` that is healthy, cached, or not queried yet. */
  readonly ledger: readonly ProviderQuotaSource[];
  /** Turned-on external engines; their quota stays inside each engine. */
  readonly engines: readonly ProviderQuotaSource[];
  /** Registered engines left out because they are not turned on. Never deleted, only not listed. */
  readonly hiddenEngines: number;
  /** True while the engine scope is still loading: engines are held back rather than flashed. */
  readonly enginesPending: boolean;
  /** Enabled connections with no official quota API. */
  readonly unsupported: readonly ProviderQuotaSource[];
  /** Provider and service sources whose quota check is off. */
  readonly off: readonly ProviderQuotaSource[];
}

/**
 * The status the page shows. A provider whose OAuth sign-in is known to be gone
 * is `auth_required` before anyone presses refresh, instead of "not queried".
 */
export function effectiveQuotaStatus(source: ProviderQuotaSource, signedOut: ReadonlySet<string>): ProviderQuotaStatus {
  if (source.enabled && source.kind === 'provider' && signedOut.has(source.provider_id)) return 'auth_required';
  return source.status;
}

const ATTENTION: ReadonlySet<ProviderQuotaStatus> = new Set(['auth_required', 'error']);

/**
 * Sort the snapshot into what the page shows. `scope` is `null` when the engine
 * preferences cannot be read, so every engine stays listed rather than guessed
 * away, and `'pending'` while they load.
 */
export function arrangeQuotaSources(
  sources: readonly ProviderQuotaSource[],
  scope: QuotaEngineScope | null | 'pending',
  signedOut: ReadonlySet<string> = new Set(),
): ArrangedQuotaSources {
  const live: ProviderQuotaSource[] = [];
  const attention: ProviderQuotaSource[] = [];
  const ledger: ProviderQuotaSource[] = [];
  const engines: ProviderQuotaSource[] = [];
  const unsupported: ProviderQuotaSource[] = [];
  const off: ProviderQuotaSource[] = [];
  let hiddenEngines = 0;
  for (const source of sources) {
    if (source.kind === 'executor') {
      if (scope === 'pending') continue;
      if (scope === null || isEngineInQuotaScope(source.provider_id, scope)) engines.push(source);
      else hiddenEngines += 1;
    } else if (!source.enabled) off.push(source);
    else if (!source.supported) unsupported.push(source);
    else {
      live.push(source);
      if (ATTENTION.has(effectiveQuotaStatus(source, signedOut))) attention.push(source);
      else ledger.push(source);
    }
  }
  const ordered = [...attention, ...ledger];
  return { live: ordered, attention, ledger, engines, hiddenEngines, enginesPending: scope === 'pending', unsupported, off };
}

/** Provider ids whose OAuth sign-in the provider catalog reports as gone. */
export function signedOutProviderIds(providers: readonly ProviderCatalogItem[] | undefined): ReadonlySet<string> {
  return new Set((providers ?? []).filter((provider) => provider.oauth?.signed_in === false).map((provider) => provider.id));
}

/** The engine scope off a `GET /config` response, from the records Settings › Connections writes. */
export function quotaEngineScopeOf(config: { readonly raw?: unknown } | undefined): QuotaEngineScope {
  const prefs = engineVisibilityOf(engineOverridesOf(config), engineDisplayOf(config));
  return { ...prefs, configured: new Set(Object.keys(configuredEngineDescriptors(config) ?? {})) };
}

/**
 * Where a source is configured. A provider lands on the settings card that
 * lists that connection (API services including local HTTP servers, or account sign-ins), under
 * the same id the quota row shows.
 */
export function quotaSettingsHref(source: ProviderQuotaSource, provider?: ProviderCatalogItem): string {
  if (source.kind === 'external_service' || source.auth.action === 'external_service_settings') return '/settings/search#st-card-search-providers';
  if (source.kind === 'executor' || source.auth.action === 'executor_login') return '/settings/ai#st-card-engines';
  if (provider?.oauth !== undefined || source.auth.action === 'oauth_login') return '/settings/ai?tab=providers';
  return '/settings/ai#st-card-providers';
}

/**
 * Local usage history link for a provider source, only when the provider catalog
 * confirms the exact same `provider_id` (no guessed mapping for managed aliases).
 */
export function quotaLocalUsageHref(source: ProviderQuotaSource, provider?: ProviderCatalogItem): string | undefined {
  if (source.kind !== 'provider' || provider === undefined || provider.id !== source.provider_id) return undefined;
  return `/usage?panel=history&provider=${encodeURIComponent(provider.id)}`;
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
