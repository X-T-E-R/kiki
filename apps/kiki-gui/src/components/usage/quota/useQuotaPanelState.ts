import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../../i18n';
import { isPeerConnectionSource } from '../../../lib/peerAccess';
import {
  arrangeQuotaSources,
  HARNESS_QUOTA_UNAVAILABLE_MESSAGE,
  harnessQuotaQueryKey,
  isNativeQuotaNeverFetched,
  isSourceRefreshable,
  mergeHarnessQuotaSnapshots,
  normalizeQuotaSources,
  pluginQuotaNextExpiryMs,
  pluginQuotaSnapshotStatus,
  QUOTA_REFRESH_CONCURRENCY,
  quotaEngineScopeOf,
  readCachedHarnessQuota,
  runWithConcurrency,
  signedOutProviderIds,
  useProviderQuotas,
  type HarnessQuotaActionId,
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
  const [pendingPluginActions, setPendingPluginActions] = useState<ReadonlySet<string>>(() => new Set());
  const [pluginActionFeedbacks, setPluginActionFeedbacks] = useState<Record<string, Feedback>>({});
  const [savingEngineSourceIds, setSavingEngineSourceIds] = useState<ReadonlySet<string>>(() => new Set());
  const autoRefreshedScopeRef = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

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

  const performPluginAction = useCallback(async (
    pluginSourceId: string,
    action: HarnessQuotaActionId,
    accountId?: string,
  ) => {
    const api = client.klient?.rest?.harnessQuota;
    if (api === undefined || typeof api.performAction !== 'function') {
      setPluginActionFeedbacks((prev) => ({
        ...prev,
        [pluginSourceId]: { tone: 'error', text: HARNESS_QUOTA_UNAVAILABLE_MESSAGE },
      }));
      return;
    }
    const actionKey = `${pluginSourceId}\0${action}\0${accountId ?? ''}`;
    setPendingPluginActions((prev) => new Set(prev).add(actionKey));
    setPluginActionFeedbacks((prev) => {
      if (!(pluginSourceId in prev)) return prev;
      const next = { ...prev };
      delete next[pluginSourceId];
      return next;
    });
    try {
      const response = await api.performAction(
        pluginSourceId,
        accountId !== undefined ? { action, account_id: accountId } : { action },
      );
      if (!response.ok) {
        setPluginActionFeedbacks((prev) => ({
          ...prev,
          [pluginSourceId]: { tone: 'error', text: response.message ?? HARNESS_QUOTA_UNAVAILABLE_MESSAGE },
        }));
        return;
      }
      if (response.message) {
        setPluginActionFeedbacks((prev) => ({
          ...prev,
          [pluginSourceId]: { tone: 'success', text: response.message! },
        }));
      }
      try {
        await refreshPluginSource(pluginSourceId);
      } catch {
        /* Captured in pluginErrors */
      }
    } catch (error) {
      setPluginActionFeedbacks((prev) => ({
        ...prev,
        [pluginSourceId]: { tone: 'error', text: errorText(locale, error) },
      }));
    } finally {
      setPendingPluginActions((prev) => {
        const next = new Set(prev);
        next.delete(actionKey);
        return next;
      });
    }
  }, [client, locale, refreshPluginSource]);

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

  const seenTargetRevisionsRef = useRef<Map<string, string>>(new Map());
  const pluginCatalogEnabled = client.klient?.rest?.harnessQuota !== undefined && !isPeerConnectionSource(connectionSource);
  const initialCacheReady =
    !quotas.loading &&
    quotas.snapshot !== undefined &&
    !arranged.enginesPending &&
    !providersQuery.isPending &&
    (!pluginCatalogEnabled || !harnessQuotaQuery.isPending);

  useEffect(() => {
    if (!initialCacheReady) return;
    const scopeKey = `${scopeId}:${meta?.server_id ?? ''}`;
    const isInitialScope = autoRefreshedScopeRef.current !== scopeKey;
    if (isInitialScope) {
      autoRefreshedScopeRef.current = scopeKey;
      seenTargetRevisionsRef.current.clear();
    }

    const revisionChangedTargets = arranged.live.filter((source) => {
      if (source.revision === undefined) return false;
      const prev = seenTargetRevisionsRef.current.get(source.id);
      if (prev === source.revision) return false;
      seenTargetRevisionsRef.current.set(source.id, source.revision);
      return !isInitialScope && isSourceRefreshable(source) && !signedOut.has(source.provider_id);
    });
    const nativeTargets = isInitialScope
      ? [
          ...arranged.live.filter((source) => isNativeQuotaNeverFetched(source, signedOut)),
          ...arranged.engines.filter(
            (engine) => engineQuotaSourceOf(configRaw, engine.provider_id) === '' && isNativeQuotaNeverFetched(engine, signedOut),
          ),
        ]
      : revisionChangedTargets;
    const pluginTargets = new Set<string>();
    if (isInitialScope) {
      for (const engine of arranged.engines) {
        const selected = engineQuotaSourceOf(configRaw, engine.provider_id);
        if (selected === '') continue;
        const snap = pluginQuotaSources.find((s) => s.id === selected && s.engineIds.includes(engine.provider_id));
        if (
          snap !== undefined &&
          pluginQuotaSnapshotStatus(snap, engine.provider_id, pluginErrors[selected], Date.now(), pluginCatalogError !== undefined) === 'unqueried'
        ) {
          pluginTargets.add(selected);
        }
      }
    }
    if (nativeTargets.length === 0 && pluginTargets.size === 0) return;

    const nativeIds = nativeTargets.map((s) => s.id);
    if (nativeIds.length > 0) {
      setActiveRefreshSourceIds((prev) => [...new Set([...prev, ...nativeIds])]);
    }
    const tasks: Array<() => Promise<void>> = [
      ...nativeTargets.map((target) => async () => {
        try {
          await quotas.refreshSource(target.id);
        } catch (error) {
          if (mountedRef.current) {
            setSourceFeedbacks((prev) => ({ ...prev, [target.id]: { tone: 'error', text: errorText(locale, error) } }));
          }
        } finally {
          if (mountedRef.current) {
            setActiveRefreshSourceIds((prev) => prev.filter((id) => id !== target.id));
          }
        }
      }),
      ...[...pluginTargets].map((pluginId) => async () => {
        try {
          await refreshPluginSource(pluginId);
        } catch {
          /* Captured in pluginErrors */
        }
      }),
    ];
    void runWithConcurrency(tasks, QUOTA_REFRESH_CONCURRENCY);
  }, [
    arranged.engines,
    arranged.enginesPending,
    arranged.live,
    configRaw,
    initialCacheReady,
    locale,
    meta?.server_id,
    pluginCatalogError,
    pluginErrors,
    pluginQuotaSources,
    quotas,
    refreshPluginSource,
    scopeId,
    signedOut,
  ]);

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
    const tasks: Array<() => Promise<void>> = [
      ...targets.map((target) => async () => {
        try {
          await quotas.refreshSource(target.id);
        } catch (error) {
          setSourceFeedbacks((prev) => ({ ...prev, [target.id]: { tone: 'error', text: errorText(locale, error) } }));
        } finally {
          setActiveRefreshSourceIds((prev) => prev.filter((id) => id !== target.id));
        }
      }),
      ...[...pluginTargets].map((pluginId) => async () => {
        try { await refreshPluginSource(pluginId); } catch { /* Captured in pluginErrors */ }
      }),
    ];
    try {
      await runWithConcurrency(tasks, QUOTA_REFRESH_CONCURRENCY);
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
    pendingPluginActions,
    pluginActionFeedbacks,
    savingEngineSourceIds,
    clearFeedback,
    refreshPluginSource,
    performPluginAction,
    handleSelectEngineQuotaSource,
    handleHeaderRefresh,
  };
}
