import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../../i18n';
import { isPeerConnectionSource } from '../../../lib/peerAccess';
import {
  arrangeQuotaSources,
  HARNESS_QUOTA_UNAVAILABLE_MESSAGE,
  harnessQuotaQueryKey,
  isSourceRefreshable,
  mergeHarnessQuotaSnapshots,
  normalizeQuotaSources,
  pluginQuotaNextExpiryMs,
  quotaEngineScopeOf,
  readCachedHarnessQuota,
  signedOutProviderIds,
  useProviderQuotas,
  type PluginHarnessQuotaSnapshot,
} from '../../../lib/providerQuota';
import { useConnection } from '../../../state/connection';
import type { Feedback } from '../../controls';
import { engineQuotaSourceOf } from '../../settings/ExternalEnginesSection';
import { asConfigRecord, EXECUTORS_QUERY_KEY, useExecutorCatalogQuery } from '../../settings/profileEditor/engines';

const EMPTY_PLUGIN_QUOTA_SOURCES: readonly PluginHarnessQuotaSnapshot[] = [];

export function useQuotaPanelState() {
  const { locale } = useI18n();
  const { client, scopeId, meta, connectionSource } = useConnection();
  const queryClient = useQueryClient();
  const quotas = useProviderQuotas();
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000, retry: false });
  const executorsQuery = useExecutorCatalogQuery();
  const pluginQuotaKey = harnessQuotaQueryKey(scopeId, meta?.server_id);
  const harnessQuotaQuery = useQuery({
    queryKey: pluginQuotaKey,
    queryFn: ({ signal }) => readCachedHarnessQuota(client.klient?.rest?.harnessQuota, signal),
    enabled: client.klient?.rest?.harnessQuota !== undefined && !isPeerConnectionSource(connectionSource),
    refetchOnWindowFocus: false,
    retry: false,
  });

  const pluginQuotaSources = harnessQuotaQuery.data?.sources ?? EMPTY_PLUGIN_QUOTA_SOURCES;
  const pluginCatalogError = harnessQuotaQuery.isError ? errorText(locale, harnessQuotaQuery.error) : undefined;
  const [, setExpiryTick] = useState(0);
  const now = Date.now();
  const nextPluginExpiryMs = pluginQuotaNextExpiryMs(pluginQuotaSources, now);
  useEffect(() => {
    if (nextPluginExpiryMs === undefined) return;
    const delayMs = Math.max(0, nextPluginExpiryMs - Date.now());
    const timer = setTimeout(() => { setExpiryTick((tick) => tick + 1); }, delayMs);
    return () => { clearTimeout(timer); };
  }, [nextPluginExpiryMs]);

  const configRaw = asConfigRecord(configQuery.data?.raw);
  const sources = normalizeQuotaSources(quotas.snapshot);
  const providers = providersQuery.data?.items;
  const signedOut = useMemo(() => signedOutProviderIds(providers), [providers]);
  const engineScope = configQuery.isPending ? 'pending' as const : configQuery.isError ? null : quotaEngineScopeOf(configQuery.data);
  const arranged = arrangeQuotaSources(sources, engineScope, signedOut);
  const providerById = (id: string) => providers?.find((provider) => provider.id === id);

  const [sourceFeedbacks, setSourceFeedbacks] = useState<Record<string, Feedback>>({});
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [activeRefreshSourceIds, setActiveRefreshSourceIds] = useState<readonly string[]>([]);
  const [refreshingPluginIds, setRefreshingPluginIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pluginErrors, setPluginErrors] = useState<Record<string, string>>({});
  const [savingEngineSourceIds, setSavingEngineSourceIds] = useState<ReadonlySet<string>>(() => new Set());

  const clearFeedback = useCallback((id: string) => {
    setSourceFeedbacks((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const refreshPluginSource = useCallback(async (pluginSourceId: string) => {
    const api = client.klient?.rest?.harnessQuota;
    if (api === undefined) return;
    setRefreshingPluginIds((prev) => new Set(prev).add(pluginSourceId));
    setPluginErrors((prev) => {
      if (!(pluginSourceId in prev)) return prev;
      const next = { ...prev };
      delete next[pluginSourceId];
      return next;
    });
    try {
      const updated = await api.read(pluginSourceId);
      queryClient.setQueryData(pluginQuotaKey, (current: { readonly sources: readonly PluginHarnessQuotaSnapshot[] } | undefined) =>
        mergeHarnessQuotaSnapshots(current, updated.sources),
      );
    } catch (error) {
      const message = errorText(locale, error);
      setPluginErrors((prev) => ({ ...prev, [pluginSourceId]: message }));
      queryClient.setQueryData(pluginQuotaKey, (current: { readonly sources: readonly PluginHarnessQuotaSnapshot[] } | undefined) => {
        if (current === undefined) return current;
        return {
          sources: current.sources.map((entry) =>
            entry.id === pluginSourceId ? { ...entry, readings: undefined, error: HARNESS_QUOTA_UNAVAILABLE_MESSAGE } : entry,
          ),
        };
      });
      throw error;
    } finally {
      setRefreshingPluginIds((prev) => {
        const next = new Set(prev);
        next.delete(pluginSourceId);
        return next;
      });
    }
  }, [client, locale, pluginQuotaKey, queryClient]);

  const handleSelectEngineQuotaSource = useCallback(async (engineId: string, nextSourceId: string) => {
    setSavingEngineSourceIds((prev) => new Set(prev).add(engineId));
    clearFeedback(`executor:${engineId}`);
    try {
      await client.patchConfig({
        agent_executor_overrides: { [engineId]: { quota_source: nextSourceId === '' ? null : nextSourceId } },
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['config'] }),
        queryClient.invalidateQueries({ queryKey: EXECUTORS_QUERY_KEY }),
      ]);
    } catch (error) {
      setSourceFeedbacks((prev) => ({
        ...prev,
        [`executor:${engineId}`]: { tone: 'error', text: errorText(locale, error) },
      }));
    } finally {
      setSavingEngineSourceIds((prev) => {
        const next = new Set(prev);
        next.delete(engineId);
        return next;
      });
    }
  }, [clearFeedback, client, locale, queryClient]);

  const handleHeaderRefresh = async () => {
    if (quotas.loading || quotas.isRefetching || refreshingAll) return;
    const liveTargets = arranged.live.filter((source) => isSourceRefreshable(source) && !signedOut.has(source.provider_id));
    const nativeEngineTargets = arranged.engines.filter(
      (engine) => engineQuotaSourceOf(configRaw, engine.provider_id) === '' && isSourceRefreshable(engine),
    );
    const targets = [...liveTargets, ...nativeEngineTargets];
    const pluginTargets = new Set<string>();
    for (const engine of arranged.engines) {
      const selected = engineQuotaSourceOf(configRaw, engine.provider_id);
      if (selected !== '' && pluginQuotaSources.some((s) => s.id === selected && s.engineIds.includes(engine.provider_id))) {
        pluginTargets.add(selected);
      }
    }
    if (targets.length === 0 && pluginTargets.size === 0) {
      await quotas.refetch();
      return;
    }
    setRefreshingAll(true);
    setActiveRefreshSourceIds(targets.map((s) => s.id));
    setSourceFeedbacks((prev) => {
      const next = { ...prev };
      for (const target of targets) delete next[target.id];
      return next;
    });
    try {
      await Promise.all([
        ...targets.map(async (target) => {
          try { await quotas.refreshSource(target.id); }
          catch (error) { setSourceFeedbacks((prev) => ({ ...prev, [target.id]: { tone: 'error', text: errorText(locale, error) } })); }
        }),
        ...[...pluginTargets].map(async (pluginId) => {
          try { await refreshPluginSource(pluginId); } catch { /* Captured in pluginErrors */ }
        }),
      ]);
    } finally {
      setRefreshingAll(false);
      setActiveRefreshSourceIds([]);
    }
  };

  const showEngineSection =
    !arranged.enginesPending &&
    (configQuery.isError || pluginCatalogError !== undefined || arranged.engines.length > 0 || arranged.hiddenEngines > 0);

  return {
    ...quotas,
    configQuery,
    executorsQuery,
    harnessQuotaQuery,
    configRaw,
    signedOut,
    arranged,
    providerById,
    pluginQuotaSources,
    pluginCatalogError,
    now,
    showEngineSection,
    sourceFeedbacks,
    refreshingAll,
    activeRefreshSourceIds,
    refreshingPluginIds,
    pluginErrors,
    savingEngineSourceIds,
    clearFeedback,
    refreshPluginSource,
    handleSelectEngineQuotaSource,
    handleHeaderRefresh,
  };
}
