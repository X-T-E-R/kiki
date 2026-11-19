import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExecutorCatalogItem, ProviderCatalogItem } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { compactIdentifier } from '../../lib/compactIdentifier';
import { useConnection } from '../../state/connection';
import { DisclosureChevron, Icon } from '../icons';
import { FeedbackLine, Toggle, type Feedback } from '../controls';
import { MiniContextMenu, type MiniMenuEntry } from '../MiniContextMenu';
import { OAuthDeviceCard } from '../OAuthDeviceCard';
import { SearchableSelect } from '../SearchableSelect';
import { useOAuthFlow } from '../useOAuthFlow';
import { engineHealth, engineQuotaSourceOf, type EngineHealth } from '../settings/ExternalEnginesSection';
import { asConfigRecord, EXECUTORS_QUERY_KEY, useExecutorCatalogQuery } from '../settings/profileEditor/engines';
import { SMALL_INPUT } from '../ui';
import {
  arrangeQuotaSources,
  compactQuotaMeterLabel,
  effectiveQuotaStatus,
  formatHarnessQuotaReading,
  formatQuotaResetDuration,
  formatQuotaResetShort,
  formatWindowPeriod,
  groupHarnessQuotaReadings,
  HARNESS_QUOTA_UNAVAILABLE_MESSAGE,
  harnessQuotaQueryKey,
  isSourceLocked,
  isSourceRefreshable,
  mergeHarnessQuotaSnapshots,
  meterRemainingPercent,
  meterValue,
  normalizeQuotaSources,
  pluginQuotaNextExpiryMs,
  pluginQuotaSnapshotStatus,
  quotaEngineScopeOf,
  quotaFuelBarClass,
  quotaFuelTier,
  quotaLocalUsageHref,
  quotaSettingsHref,
  readCachedHarnessQuota,
  signedOutProviderIds,
  statusBadgeInfo,
  useProviderQuotas,
  type HarnessQuotaAccountGroup,
  type HarnessQuotaReading,
  type PluginHarnessQuotaSnapshot,
  type ProviderQuotaMeter,
  type ProviderQuotaSnapshot,
  type ProviderQuotaSource,
  type ProviderQuotaStatus,
} from '../../lib/providerQuota';
import { isPeerConnectionSource } from '../../lib/peerAccess';

const EMPTY_PLUGIN_QUOTA_SOURCES: readonly PluginHarnessQuotaSnapshot[] = [];

const ENGINE_HEALTH: Record<EngineHealth, { readonly key: I18nKey; readonly dot: string }> = {
  ready: { key: 'st.engines.statusReady', dot: 'bg-success' },
  warning: { key: 'st.engines.statusWarning', dot: 'bg-amber-ink' },
  missing: { key: 'st.engines.statusMissing', dot: 'bg-danger' },
  unknown: { key: 'st.engines.statusUnknown', dot: 'bg-ink/[0.25]' },
};

const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-2 md:grid-cols-[minmax(176px,216px)_minmax(0,1fr)_auto]';
const ROW_LINK = 'inline-flex h-7 shrink-0 items-center rounded px-1.5 text-[11.5px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink';
const SMALL_BUTTON = 'inline-flex h-7 items-center gap-1 rounded border border-hairline bg-paper px-2 text-[11px] font-medium text-ink transition-colors hover:bg-ink/[0.05] disabled:opacity-50';
const ICON_BUTTON = 'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded border border-hairline bg-paper px-1.5 text-[11px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50';

function q(key: I18nKey): I18nKey {
  return key;
}

/**
 * Usage › Quotas. Minimalist paper-and-ink fuel ledger:
 * - Zero stacked section headings or summary counters; broken auth floats to the
 *   top, everything else aligns on one calm hairline axis.
 * - One meter bar = window name + remaining % + compact reset countdown.
 * - Multi-account OAuth fleets collapse by default to pool-level fuel bars and
 *   expand on click into an aligned seat × pool matrix.
 */
export function ProviderQuotaPanel() {
  const { t, time, locale } = useI18n();
  const { client, scopeId, meta, connectionSource } = useConnection();
  const queryClient = useQueryClient();
  const { snapshot, loading, isError, stale, refetch, isRefetching, refreshSource, refreshingSourceId, setSourceEnabled } = useProviderQuotas();
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
    const timer = setTimeout(() => {
      setExpiryTick((tick) => tick + 1);
    }, delayMs);
    return () => { clearTimeout(timer); };
  }, [nextPluginExpiryMs]);

  const configRaw = asConfigRecord(configQuery.data?.raw);
  const sources = normalizeQuotaSources(snapshot);
  const providers = providersQuery.data?.items;
  const signedOut = useMemo(() => signedOutProviderIds(providers), [providers]);
  const engineScope = configQuery.isPending ? 'pending' as const : configQuery.isError ? null : quotaEngineScopeOf(configQuery.data);
  const arranged = arrangeQuotaSources(sources, engineScope, signedOut);
  const providerById = (id: string) => providers?.find((provider) => provider.id === id);
  const asOfTime = snapshot?.generated_at;
  const [sourceFeedbacks, setSourceFeedbacks] = useState<Record<string, Feedback>>({});
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [activeRefreshSourceIds, setActiveRefreshSourceIds] = useState<readonly string[]>([]);
  const [refreshingPluginIds, setRefreshingPluginIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pluginErrors, setPluginErrors] = useState<Record<string, string>>({});
  const [savingEngineSourceIds, setSavingEngineSourceIds] = useState<ReadonlySet<string>>(() => new Set());

  const clearFeedback = (id: string) => {
    setSourceFeedbacks((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

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
        agent_executor_overrides: {
          [engineId]: { quota_source: nextSourceId === '' ? null : nextSourceId },
        },
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
  }, [client, locale, queryClient]);

  const handleHeaderRefresh = async () => {
    if (loading || isRefetching || refreshingAll) return;
    const liveTargets = arranged.live.filter((source) => isSourceRefreshable(source) && !signedOut.has(source.provider_id));
    const nativeEngineTargets = arranged.engines.filter((engine) => {
      const selected = engineQuotaSourceOf(configRaw, engine.provider_id);
      return selected === '' && isSourceRefreshable(engine);
    });
    const targets = [...liveTargets, ...nativeEngineTargets];
    const pluginTargets = new Set<string>();
    for (const engine of arranged.engines) {
      const selected = engineQuotaSourceOf(configRaw, engine.provider_id);
      if (selected !== '' && pluginQuotaSources.some((s) => s.id === selected && s.engineIds.includes(engine.provider_id))) {
        pluginTargets.add(selected);
      }
    }
    if (targets.length === 0 && pluginTargets.size === 0) {
      await refetch();
      return;
    }
    setRefreshingAll(true);
    setActiveRefreshSourceIds(targets.map((s) => s.id));
    setSourceFeedbacks((prev) => {
      const next = { ...prev };
      for (const target of targets) {
        delete next[target.id];
      }
      return next;
    });
    try {
      await Promise.all([
        ...targets.map(async (target) => {
          try {
            await refreshSource(target.id);
          } catch (error) {
            setSourceFeedbacks((prev) => ({
              ...prev,
              [target.id]: { tone: 'error', text: errorText(locale, error) },
            }));
          }
        }),
        ...[...pluginTargets].map(async (pluginId) => {
          try {
            await refreshPluginSource(pluginId);
          } catch {
            // Error is captured in pluginErrors state per pluginId.
          }
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
  const refreshAllTitle = asOfTime
    ? `${t('usage.quota.refreshAll')} · ${t('usage.quota.asOf', { time: time.relativeTime(asOfTime) })}`
    : t('usage.quota.refreshAll');

  return (
    <div className="space-y-4" data-provider-quota-panel>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {stale ? (
          <button
            type="button"
            data-quota-stale
            aria-label={`${t('usage.governance.stale', { time: asOfTime ? time.relativeTime(asOfTime) : '' })} · ${t('usage.execution.retryRefresh')}`}
            title={`${t('usage.governance.stale', { time: asOfTime ? time.relativeTime(asOfTime) : '' })} · ${t('usage.execution.retryRefresh')}`}
            onClick={() => { void refetch(); }}
            disabled={isRefetching}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-amber-ink transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50"
          >
            <Icon name="refresh" size={14} className={isRefetching ? 'animate-spin' : undefined} />
          </button>
        ) : null}
        {showEngineSection ? (
          <Link to="/settings/ai#st-card-engines" data-quota-engines-manage className={ROW_LINK}>
            {t(q('usage.quota.engines.manage'))}
          </Link>
        ) : null}
        <button
          type="button"
          data-quota-refresh-button
          data-quota-as-of={asOfTime}
          title={refreshAllTitle}
          onClick={() => void handleHeaderRefresh()}
          disabled={loading || isRefetching || refreshingAll}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-hairline bg-paper px-2.5 py-1 text-[12px] font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:min-h-11"
        >
          <Icon name="refresh" size={14} className={isRefetching || refreshingAll ? 'animate-spin' : undefined} />
          {t(isRefetching || refreshingAll ? 'usage.quota.refreshing' : 'usage.quota.refreshAll')}
        </button>
      </div>

      {loading ? (
        <div role="status" className="flex items-center gap-2 py-8 text-[13px] text-ink-faint">
          <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />{t('usage.loading')}
        </div>
      ) : isError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-[12.5px] text-danger" data-quota-snapshot-error>
          <p className="font-medium">{t('usage.quota.status.error')}</p>
          <button type="button" data-quota-snapshot-retry className={SMALL_BUTTON} onClick={() => { void refetch(); }}>
            {t('st.im.retry')}
          </button>
        </div>
      ) : (
        <>
          {arranged.live.length === 0 && !showEngineSection ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-y border-hairline py-6 text-[13px] text-ink-faint" data-quota-empty>
              <div>
                <p className="font-medium text-ink-soft">{t('usage.quota.emptyTitle')}</p>
                <p className="mt-0.5 text-[12px] text-ink-faint">{t('usage.quota.emptyBody')}</p>
              </div>
              <Link to="/settings/ai?tab=providers" data-quota-manage-connections className={ROW_LINK}>
                {t('usage.quota.action.manageConnections')}
              </Link>
            </div>
          ) : (
            <div className="space-y-4" data-quota-items>
              {arranged.live.length === 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border-y border-hairline py-4 text-[12.5px] text-ink-faint" data-quota-empty>
                  <span>{t('usage.quota.emptyTitle')}</span>
                  <Link to="/settings/ai?tab=providers" data-quota-manage-connections className={ROW_LINK}>
                    {t('usage.quota.action.manageConnections')}
                  </Link>
                </div>
              ) : null}

              {arranged.attention.length > 0 ? (
                <section className="space-y-2.5" data-quota-attention>
                  {arranged.attention.map((source) => {
                    const provider = providerById(source.provider_id);
                    return (
                      <AttentionQuotaRow
                        key={source.id}
                        source={source}
                        status={effectiveQuotaStatus(source, signedOut)}
                        signedOut={source.kind === 'provider' && signedOut.has(source.provider_id)}
                        settingsHref={quotaSettingsHref(source, provider)}
                        localUsageHref={quotaLocalUsageHref(source, provider)}
                        isRefreshing={refreshingSourceId === source.id || source.refreshing || activeRefreshSourceIds.includes(source.id)}
                        feedback={sourceFeedbacks[source.id]}
                        onClearExternalFeedback={() => clearFeedback(source.id)}
                        onRefresh={() => refreshSource(source.id)}
                        onToggleEnabled={(enabled) => setSourceEnabled(source.id, enabled)}
                      />
                    );
                  })}
                </section>
              ) : null}

              {arranged.ledger.length > 0 || showEngineSection ? (
                <div className="divide-y divide-hairline border-y border-hairline">
                  {arranged.ledger.length > 0 ? (
                    <section className="divide-y divide-hairline" data-quota-ledger>
                      {arranged.ledger.map((source) => {
                        const provider = providerById(source.provider_id);
                        return (
                          <LedgerQuotaRow
                            key={source.id}
                            source={source}
                            status={effectiveQuotaStatus(source, signedOut)}
                            signedOut={source.kind === 'provider' && signedOut.has(source.provider_id)}
                            settingsHref={quotaSettingsHref(source, provider)}
                            localUsageHref={quotaLocalUsageHref(source, provider)}
                            isRefreshing={refreshingSourceId === source.id || source.refreshing || activeRefreshSourceIds.includes(source.id)}
                            feedback={sourceFeedbacks[source.id]}
                            onClearExternalFeedback={() => clearFeedback(source.id)}
                            onRefresh={() => refreshSource(source.id)}
                            onToggleEnabled={(enabled) => setSourceEnabled(source.id, enabled)}
                          />
                        );
                      })}
                    </section>
                  ) : null}

                  <EngineQuotaSection
                    engines={arranged.engines}
                    hidden={arranged.hiddenEngines}
                    pending={arranged.enginesPending}
                    catalog={executorsQuery.data?.items}
                    configRaw={configRaw}
                    configError={configQuery.isError}
                    onRetryConfig={() => { void configQuery.refetch(); }}
                    pluginQuotaSources={pluginQuotaSources}
                    pluginCatalogError={pluginCatalogError}
                    onRetryPluginCatalog={() => { void harnessQuotaQuery.refetch(); }}
                    now={now}
                    refreshingPluginIds={refreshingPluginIds}
                    pluginErrors={pluginErrors}
                    savingEngineSourceIds={savingEngineSourceIds}
                    refreshingNativeSourceId={refreshingSourceId}
                    activeRefreshSourceIds={activeRefreshSourceIds}
                    sourceFeedbacks={sourceFeedbacks}
                    onClearFeedback={clearFeedback}
                    onSelectQuotaSource={handleSelectEngineQuotaSource}
                    onRefreshPluginSource={refreshPluginSource}
                    onRefreshNativeSource={refreshSource}
                  />
                </div>
              ) : null}
            </div>
          )}

          <div className="space-y-1 pt-1">
            <UnsupportedQuotaSection sources={arranged.unsupported} providerById={providerById} />
            <OffQuotaSection sources={arranged.off} providerById={providerById} onEnable={(id) => setSourceEnabled(id, true)} />
          </div>
        </>
      )}
    </div>
  );
}

function KindTag({ kind }: { readonly kind: ProviderQuotaSource['kind'] }) {
  const { t } = useI18n();
  if (kind === 'provider' || kind === 'executor') return null;
  return <span className="shrink-0 text-[11px] text-ink-faint">{t(`usage.quota.kind.${kind}` as I18nKey)}</span>;
}

function SourceAccountSubtitle({ source, settingsHref, showSettingsLink }: {
  readonly source: ProviderQuotaSource;
  readonly settingsHref: string;
  readonly showSettingsLink?: boolean;
}) {
  const { t } = useI18n();
  const accountDisplay = source.account_label ? compactIdentifier(source.account_label) : undefined;
  const rawTitle = [source.account_label, source.source.label].filter(Boolean).join(' · ');
  if (accountDisplay === undefined && !showSettingsLink) return null;
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-ink-faint">
      {accountDisplay !== undefined ? (
        <span className="min-w-0 truncate" title={rawTitle}>{accountDisplay}</span>
      ) : null}
      {accountDisplay !== undefined && showSettingsLink ? <span aria-hidden>·</span> : null}
      {showSettingsLink ? (
        <Link to={settingsHref} data-quota-settings-link={source.id} className="shrink-0 text-ink-soft hover:text-ink hover:underline">
          {t('usage.quota.action.settings')}
        </Link>
      ) : null}
    </p>
  );
}

function RowActionsMenu({ source, settingsHref, localUsageHref, onDisable }: {
  readonly source: ProviderQuotaSource;
  readonly settingsHref: string;
  readonly localUsageHref?: string;
  readonly onDisable: () => Promise<void>;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const entries = useMemo<readonly MiniMenuEntry[]>(() => [
    {
      key: 'settings',
      label: t('usage.quota.action.settings'),
      run: () => { void navigate(settingsHref); },
    },
    ...(localUsageHref !== undefined ? [{
      key: 'local-usage',
      label: t('usage.quota.action.localUsage'),
      run: () => { void navigate(localUsageHref); },
    }] : []),
    { separator: true as const },
    {
      key: 'disable',
      label: t('usage.quota.action.disable'),
      danger: true,
      run: () => onDisable(),
    },
  ], [localUsageHref, navigate, onDisable, settingsHref, t]);

  return (
    <>
      <button
        type="button"
        data-quota-menu-trigger={source.id}
        aria-label={t('st.spaces.menuAria', { name: source.label })}
        aria-expanded={menuPos !== null}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenuPos((prev) => prev === null ? { x: rect.left, y: rect.bottom + 4 } : null);
        }}
        className={ICON_BUTTON}
      >
        <Icon name="more" size={14} />
      </button>
      {menuPos !== null ? (
        <MiniContextMenu
          x={menuPos.x}
          y={menuPos.y}
          entries={entries}
          onClose={() => { setMenuPos(null); }}
          ariaLabel={source.label}
          overlayId={`quota-row-menu-${source.id}`}
          dataAttribute="data-quota-row-menu"
        />
      ) : null}
    </>
  );
}

function AttentionQuotaRow({ source, status, signedOut, settingsHref, localUsageHref, isRefreshing, feedback: externalFeedback, onClearExternalFeedback, onRefresh, onToggleEnabled }: {
  readonly source: ProviderQuotaSource;
  readonly status: ProviderQuotaStatus;
  readonly signedOut: boolean;
  readonly settingsHref: string;
  readonly localUsageHref?: string;
  readonly isRefreshing: boolean;
  readonly feedback?: Feedback;
  readonly onClearExternalFeedback?: () => void;
  readonly onRefresh: () => Promise<unknown>;
  readonly onToggleEnabled: (enabled: boolean) => Promise<unknown>;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const onSignedIn = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['providers'] }),
      queryClient.invalidateQueries({ queryKey: ['provider-quotas'] }),
    ]);
  }, [queryClient]);
  const flow = useOAuthFlow(onSignedIn);
  const [authBusy, setAuthBusy] = useState(false);
  const [localFeedback, setLocalFeedback] = useState<Feedback>(null);
  const feedback = localFeedback ?? externalFeedback ?? null;
  const badge = statusBadgeInfo(status);
  const isLocked = isSourceLocked(source);
  const refreshAfterMs = source.refresh_after ? new Date(source.refresh_after).getTime() : 0;
  const secondsLeft = isLocked ? Math.ceil((refreshAfterMs - Date.now()) / 1000) : 0;

  const handleAuthAction = async () => {
    setLocalFeedback(null);
    onClearExternalFeedback?.();
    if (source.auth.action === 'oauth_login') {
      setAuthBusy(true);
      try {
        const methods = await client.listOAuthMethods();
        const method = methods.find((entry) => entry.provider === source.auth.provider || entry.id === source.auth.provider);
        if (method === undefined) {
          void navigate(settingsHref);
          return;
        }
        await flow.start(method);
      } catch (error) {
        setLocalFeedback({ tone: 'error', text: errorText(locale, error) });
      } finally {
        setAuthBusy(false);
      }
    } else {
      void navigate(settingsHref);
    }
  };
  const runAction = async (action: () => Promise<unknown>) => {
    setLocalFeedback(null);
    onClearExternalFeedback?.();
    try { await action(); }
    catch (error) { setLocalFeedback({ tone: 'error', text: errorText(locale, error) }); }
  };
  const message = signedOut ? t(q('usage.quota.signedOut')) : source.message ?? source.reason;
  const cardTone = status === 'auth_required'
    ? 'border-amber-rule/40 bg-amber-card/65'
    : 'border-danger/30 bg-danger/5';

  return (
    <section data-quota-item={source.id} className={`space-y-2 rounded-lg border px-3.5 py-3 ${cardTone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate font-display text-[14px] font-semibold text-ink">{source.label}</h3>
            <KindTag kind={source.kind} />
            <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10.5px] font-medium ${badge.toneClass}`} data-quota-status={status}>
              {t(badge.labelKey as I18nKey)}
            </span>
          </div>
          <SourceAccountSubtitle source={source} settingsHref={settingsHref} showSettingsLink />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {status === 'auth_required' ? (
            <button type="button" data-quota-auth-action={source.id} onClick={() => { void handleAuthAction(); }}
              disabled={authBusy || flow.busy !== null || (flow.showing && flow.snapshot?.status === 'pending')}
              className={SMALL_BUTTON}>
              {t(source.auth.action === 'oauth_login' || source.auth.action === 'executor_login' ? 'usage.quota.action.login' : 'usage.quota.action.settings')}
            </button>
          ) : null}
          {source.supported && source.enabled && !signedOut ? (
            <button type="button" data-quota-source-refresh={source.id} onClick={() => { void runAction(onRefresh); }}
              disabled={isRefreshing || isLocked} title={isLocked ? t('usage.quota.refreshAfter', { seconds: secondsLeft }) : undefined}
              className={SMALL_BUTTON}>
              <Icon name="refresh" size={12} className={isRefreshing ? 'animate-spin' : undefined} />
              {isLocked ? `${secondsLeft}s` : t(status === 'error' ? 'st.im.retry' : 'usage.quota.refresh')}
            </button>
          ) : null}
          <RowActionsMenu
            source={source}
            settingsHref={settingsHref}
            localUsageHref={localUsageHref}
            onDisable={() => runAction(() => onToggleEnabled(false))}
          />
        </div>
      </div>
      {message ? <p className="truncate text-[12px] text-ink-soft" title={message}>{message}</p> : null}
      {source.meters.length > 0 ? (
        <div className="space-y-2 border-t border-hairline/70 pt-2 opacity-85">
          {source.meters.map((meter) => <QuotaMeterRow key={meter.id} meter={meter} sourceStatus={status} />)}
        </div>
      ) : null}
      {flow.showing && flow.snapshot !== null ? (
        <OAuthDeviceCard snapshot={flow.snapshot} label={source.label} cancelling={flow.cancelling}
          onCancel={() => { void flow.cancel(); }} onDismiss={() => { flow.dismiss(flow.snapshot!.flow_id); }} />
      ) : null}
      <FeedbackLine feedback={flow.feedback?.value ?? null} />
      <FeedbackLine feedback={feedback} />
    </section>
  );
}

function LedgerQuotaRow({ source, status, signedOut, settingsHref, localUsageHref, isRefreshing, feedback: externalFeedback, onClearExternalFeedback, onRefresh, onToggleEnabled }: {
  readonly source: ProviderQuotaSource;
  readonly status: ProviderQuotaStatus;
  readonly signedOut: boolean;
  readonly settingsHref: string;
  readonly localUsageHref?: string;
  readonly isRefreshing: boolean;
  readonly feedback?: Feedback;
  readonly onClearExternalFeedback?: () => void;
  readonly onRefresh: () => Promise<unknown>;
  readonly onToggleEnabled: (enabled: boolean) => Promise<unknown>;
}) {
  const { t, locale } = useI18n();
  const [localFeedback, setLocalFeedback] = useState<Feedback>(null);
  const feedback = localFeedback ?? externalFeedback ?? null;
  const badge = statusBadgeInfo(status);
  const isLocked = isSourceLocked(source);
  const refreshAfterMs = source.refresh_after ? new Date(source.refresh_after).getTime() : 0;
  const secondsLeft = isLocked ? Math.ceil((refreshAfterMs - Date.now()) / 1000) : 0;

  const runAction = async (action: () => Promise<unknown>) => {
    setLocalFeedback(null);
    onClearExternalFeedback?.();
    try { await action(); }
    catch (error) { setLocalFeedback({ tone: 'error', text: errorText(locale, error) }); }
  };

  const canRefresh = source.supported && source.enabled && !signedOut;
  const hasBeenQueried = status !== 'ready' ? (status !== 'unknown' || source.checked_at !== undefined || source.data_as_of !== undefined) : true;
  const unqueried = !hasBeenQueried && source.meters.length === 0;
  const emptyStatusMessage = source.message ?? source.reason;

  return (
    <section data-quota-item={source.id} className="space-y-2 py-3.5">
      <div className={ROW_GRID}>
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate font-display text-[14px] font-semibold text-ink">{source.label}</h3>
            <KindTag kind={source.kind} />
            {status !== 'ready' && !unqueried ? (
              <span className={`shrink-0 rounded border px-1.5 py-px text-[10px] font-medium ${badge.toneClass}`} data-quota-status={status}>
                {t(badge.labelKey as I18nKey)}
              </span>
            ) : (
              <span className="sr-only" data-quota-status={status}>{t(badge.labelKey as I18nKey)}</span>
            )}
          </div>
          <SourceAccountSubtitle source={source} settingsHref={settingsHref} />
        </div>

        <div className="min-w-0 max-md:col-span-2 max-md:order-3">
          {source.meters.length > 0 ? (
            <div className="space-y-2.5">
              {source.meters.map((meter) => <QuotaMeterRow key={meter.id} meter={meter} sourceStatus={status} />)}
            </div>
          ) : unqueried ? (
            <div className="flex flex-wrap items-center gap-2 py-0.5 text-[12px] text-ink-soft" data-quota-not-queried={source.id}>
              <span>{t('usage.quota.notQueried')}</span>
              {canRefresh ? (
                <>
                  <span aria-hidden className="text-ink-faint">·</span>
                  <button
                    type="button"
                    data-quota-query-now={source.id}
                    disabled={isRefreshing || isLocked}
                    onClick={() => { void runAction(onRefresh); }}
                    className="font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink disabled:opacity-50"
                  >
                    {t('usage.quota.queryNow')}
                  </button>
                </>
              ) : null}
            </div>
          ) : (
            <p className="py-0.5 text-[12px] text-ink-soft" data-quota-no-meters={source.id}>
              {emptyStatusMessage ?? t(status === 'ready' || status === 'stale' ? 'st.quota.none' : 'usage.quota.status.unknown')}
            </p>
          )}
          {source.message && source.meters.length > 0 ? <p className="mt-1 text-[11.5px] text-ink-soft">{source.message}</p> : null}
          {source.reason && !source.message && source.meters.length > 0 ? <p className="mt-1 text-[11px] text-ink-faint">{source.reason}</p> : null}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-1.5 max-md:order-2">
          {canRefresh ? (
            <button
              type="button"
              data-quota-source-refresh={source.id}
              onClick={() => { void runAction(onRefresh); }}
              disabled={isRefreshing || isLocked}
              aria-label={t('usage.quota.refresh')}
              title={isLocked ? t('usage.quota.refreshAfter', { seconds: secondsLeft }) : t('usage.quota.refresh')}
              className={ICON_BUTTON}
            >
              <Icon name="refresh" size={14} className={isRefreshing ? 'animate-spin' : undefined} />
              {isLocked ? <span className="font-mono text-[10.5px]">{secondsLeft}s</span> : null}
            </button>
          ) : null}
          <RowActionsMenu
            source={source}
            settingsHref={settingsHref}
            localUsageHref={localUsageHref}
            onDisable={() => runAction(() => onToggleEnabled(false))}
          />
        </div>
      </div>
      <FeedbackLine feedback={feedback} />
    </section>
  );
}

function EngineQuotaSection({
  engines, hidden, pending, catalog, configRaw, configError, onRetryConfig,
  pluginQuotaSources, pluginCatalogError, onRetryPluginCatalog, now,
  refreshingPluginIds, pluginErrors, savingEngineSourceIds,
  refreshingNativeSourceId, activeRefreshSourceIds, sourceFeedbacks, onClearFeedback,
  onSelectQuotaSource, onRefreshPluginSource, onRefreshNativeSource,
}: {
  readonly engines: readonly ProviderQuotaSource[];
  readonly hidden: number;
  readonly pending: boolean;
  readonly catalog: readonly ExecutorCatalogItem[] | undefined;
  readonly configRaw: Readonly<Record<string, unknown>> | undefined;
  readonly configError: boolean;
  readonly onRetryConfig: () => void;
  readonly pluginQuotaSources: readonly PluginHarnessQuotaSnapshot[];
  readonly pluginCatalogError: string | undefined;
  readonly onRetryPluginCatalog: () => void;
  readonly now: number;
  readonly refreshingPluginIds: ReadonlySet<string>;
  readonly pluginErrors: Readonly<Record<string, string>>;
  readonly savingEngineSourceIds: ReadonlySet<string>;
  readonly refreshingNativeSourceId: string | undefined;
  readonly activeRefreshSourceIds: readonly string[];
  readonly sourceFeedbacks: Readonly<Record<string, Feedback>>;
  readonly onClearFeedback: (id: string) => void;
  readonly onSelectQuotaSource: (engineId: string, nextSourceId: string) => Promise<void>;
  readonly onRefreshPluginSource: (pluginSourceId: string) => Promise<void>;
  readonly onRefreshNativeSource: (sourceId: string) => Promise<unknown>;
}) {
  const { t } = useI18n();
  if (pending || (!configError && pluginCatalogError === undefined && engines.length === 0 && hidden === 0)) return null;

  return (
    <section data-quota-engines>
      {configError ? (
        <div className="flex flex-wrap items-center gap-2 py-2.5" data-quota-engine-config-error>
          <FeedbackLine feedback={{ tone: 'error', text: t('usage.quota.engines.configError') }} />
          <button type="button" className={SMALL_BUTTON} onClick={onRetryConfig}>{t('st.im.retry')}</button>
        </div>
      ) : null}
      {pluginCatalogError !== undefined ? (
        <div className="flex flex-wrap items-center gap-2 py-2.5" data-quota-engine-plugin-error>
          <FeedbackLine feedback={{ tone: 'error', text: pluginCatalogError }} />
          <button type="button" data-quota-engine-plugin-retry className={SMALL_BUTTON} onClick={onRetryPluginCatalog}>{t('st.im.retry')}</button>
        </div>
      ) : null}
      {engines.length > 0 ? (
        <ul className="divide-y divide-hairline">
          {engines.map((source) => {
            const engineId = source.provider_id;
            const item = catalog?.find((entry) => entry.id === engineId);
            const health: EngineHealth = item === undefined ? 'unknown' : engineHealth(item, undefined);
            const selectedSourceId = engineQuotaSourceOf(configRaw, engineId);
            const matchingPluginSources = pluginQuotaSources.filter((entry) => entry.engineIds.includes(engineId));
            const selectedPluginSnapshot = selectedSourceId !== ''
              ? pluginQuotaSources.find((entry) => entry.id === selectedSourceId)
              : undefined;
            return (
              <EngineQuotaRow
                key={source.id}
                source={source}
                health={health}
                selectedSourceId={selectedSourceId}
                matchingPluginSources={matchingPluginSources}
                selectedPluginSnapshot={selectedPluginSnapshot}
                pluginCatalogError={pluginCatalogError}
                now={now}
                savingSource={savingEngineSourceIds.has(engineId)}
                isRefreshingPlugin={selectedSourceId !== '' && refreshingPluginIds.has(selectedSourceId)}
                pluginError={selectedSourceId !== '' ? pluginErrors[selectedSourceId] : undefined}
                isRefreshingNative={
                  refreshingNativeSourceId === source.id ||
                  source.refreshing ||
                  activeRefreshSourceIds.includes(source.id)
                }
                feedback={sourceFeedbacks[source.id]}
                onClearFeedback={() => onClearFeedback(source.id)}
                onSelectQuotaSource={(next) => onSelectQuotaSource(engineId, next)}
                onRefreshPluginSource={onRefreshPluginSource}
                onRefreshNativeSource={() => onRefreshNativeSource(source.id)}
              />
            );
          })}
        </ul>
      ) : null}
      {hidden > 0 ? (
        <span className="sr-only" data-quota-hidden-engines={hidden}>
          {t(q('usage.quota.engines.hidden'), { n: hidden })}
        </span>
      ) : null}
    </section>
  );
}

function EngineQuotaRow({
  source, health, selectedSourceId, matchingPluginSources, selectedPluginSnapshot,
  pluginCatalogError, now, savingSource, isRefreshingPlugin, pluginError, isRefreshingNative,
  feedback: externalFeedback, onClearFeedback, onSelectQuotaSource, onRefreshPluginSource, onRefreshNativeSource,
}: {
  readonly source: ProviderQuotaSource;
  readonly health: EngineHealth;
  readonly selectedSourceId: string;
  readonly matchingPluginSources: readonly PluginHarnessQuotaSnapshot[];
  readonly selectedPluginSnapshot: PluginHarnessQuotaSnapshot | undefined;
  readonly pluginCatalogError: string | undefined;
  readonly now: number;
  readonly savingSource: boolean;
  readonly isRefreshingPlugin: boolean;
  readonly pluginError: string | undefined;
  readonly isRefreshingNative: boolean;
  readonly feedback: Feedback | undefined;
  readonly onClearFeedback: () => void;
  readonly onSelectQuotaSource: (nextSourceId: string) => Promise<void>;
  readonly onRefreshPluginSource: (pluginSourceId: string) => Promise<void>;
  readonly onRefreshNativeSource: () => Promise<unknown>;
}) {
  const { t, time, locale } = useI18n();
  const [localFeedback, setLocalFeedback] = useState<Feedback>(null);
  const [fleetOpen, setFleetOpen] = useState(false);
  const engineId = source.provider_id;
  const isPluginMode = selectedSourceId !== '';
  const pStatus = isPluginMode
    ? pluginQuotaSnapshotStatus(selectedPluginSnapshot, engineId, pluginError, now, pluginCatalogError !== undefined)
    : undefined;
  const pluginReadings = selectedPluginSnapshot?.readings;
  const accountGroups = useMemo<readonly HarnessQuotaAccountGroup[]>(
    () => (isPluginMode && pStatus === 'ready' && pluginReadings !== undefined
      ? groupHarnessQuotaReadings(pluginReadings)
      : []),
    [isPluginMode, pStatus, pluginReadings],
  );

  const feedback = localFeedback ?? externalFeedback ?? null;
  const view = ENGINE_HEALTH[health];
  const hasQuotaControls = matchingPluginSources.length > 0 || selectedSourceId !== '' || source.supported;

  if (!hasQuotaControls) {
    return (
      <li
        data-quota-engine={engineId}
        data-engine-health={health}
        className="flex min-h-10 items-center justify-between gap-3 py-2.5"
      >
        <span className="flex min-w-0 items-center gap-2 text-[13.5px] font-medium text-ink" title={engineId}>
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${view.dot}`} title={t(view.key)} />
          <span className="truncate">{source.label}</span>
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {health !== 'ready' ? (
            <span className="text-[11.5px] text-ink-soft">{t(view.key)}</span>
          ) : null}
          {health === 'warning' || health === 'missing' ? (
            <Link to={quotaSettingsHref(source)} data-quota-engine-settings={engineId} className={ROW_LINK}>
              {t('usage.quota.action.settings')}
            </Link>
          ) : null}
        </div>
      </li>
    );
  }

  const showSourceSelect = matchingPluginSources.length > 0 || selectedSourceId !== '';
  const isNativeLocked = !isPluginMode && isSourceLocked(source);
  const nativeRefreshAfterMs = source.refresh_after ? new Date(source.refresh_after).getTime() : 0;
  const nativeSecondsLeft = isNativeLocked ? Math.ceil((nativeRefreshAfterMs - Date.now()) / 1000) : 0;
  const canRefreshNative = !isPluginMode && source.supported && source.enabled;
  const canRefreshPlugin = isPluginMode && pStatus !== 'missing';

  const headerReadAt = isPluginMode
    ? (pStatus !== 'expired' ? selectedPluginSnapshot?.readAt : undefined)
    : (source.supported ? (source.data_as_of ?? source.checked_at) : undefined);

  const refreshTooltip = headerReadAt
    ? `${t('usage.quota.refresh')} · ${t(q('usage.quota.engines.readAt'), { time: time.relativeTime(headerReadAt) })}`
    : t('usage.quota.refresh');
  const nativeRefreshTooltip = isNativeLocked
    ? t('usage.quota.refreshAfter', { seconds: nativeSecondsLeft })
    : refreshTooltip;

  const runNativeRefresh = async () => {
    setLocalFeedback(null);
    onClearFeedback();
    try {
      await onRefreshNativeSource();
    } catch (error) {
      setLocalFeedback({ tone: 'error', text: errorText(locale, error) });
    }
  };

  const runPluginRefresh = async () => {
    setLocalFeedback(null);
    onClearFeedback();
    try {
      await onRefreshPluginSource(selectedSourceId);
    } catch {
      // Error is stored on pluginErrors by parent.
    }
  };

  const nativeHasBeenQueried = source.status !== 'unknown' || source.checked_at !== undefined || source.data_as_of !== undefined;
  const nativeUnqueried = !isPluginMode && source.supported && !nativeHasBeenQueried && source.meters.length === 0;
  const isMultiSeat = isPluginMode && pStatus === 'ready' && accountGroups.length > 1;
  const singleSeat = isPluginMode && pStatus === 'ready' && accountGroups.length === 1 ? accountGroups[0] : undefined;
  const usableSeats = isMultiSeat
    ? accountGroups.filter((group) => !hasAnyExhaustedPool(group.readings)).length
    : accountGroups.length;

  return (
    <li
      data-quota-engine={engineId}
      data-engine-health={health}
      data-engine-quota-mode={isPluginMode ? 'plugin' : 'native'}
      className="space-y-2.5 py-3.5"
    >
      <div className={ROW_GRID}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${view.dot}`} title={t(view.key)} />
            <h3 className="truncate font-display text-[14px] font-semibold text-ink" title={engineId}>
              {source.label}
            </h3>
            {health !== 'ready' && health !== 'unknown' ? (
              <span className="shrink-0 text-[11px] text-ink-soft">{t(view.key)}</span>
            ) : null}
          </div>

          {isMultiSeat ? (
            <button
              type="button"
              data-quota-fleet-toggle={engineId}
              aria-expanded={fleetOpen}
              onClick={() => { setFleetOpen((prev) => !prev); }}
              className="mt-1 inline-flex items-center gap-1 rounded px-1 py-0.5 -ml-1 text-[11.5px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
            >
              <DisclosureChevron open={fleetOpen} />
              <span className="tabular-nums">
                {t('usage.quota.fleetSeatsAvailable', { ready: usableSeats, total: accountGroups.length })}
              </span>
            </button>
          ) : singleSeat !== undefined ? (
            <p className="mt-0.5 truncate text-[11.5px] text-ink-faint" title={singleSeat.accountLabel}>
              {compactIdentifier(singleSeat.accountLabel)}
            </p>
          ) : health === 'warning' || health === 'missing' ? (
            <Link to={quotaSettingsHref(source)} data-quota-engine-settings={engineId} className="mt-0.5 inline-block text-[11.5px] text-ink-soft hover:text-ink hover:underline">
              {t('usage.quota.action.settings')}
            </Link>
          ) : null}
        </div>

        <div className="min-w-0 max-md:col-span-2 max-md:order-3">
          {!isPluginMode ? (
            source.supported ? (
              <div className="space-y-2" data-engine-native-quota={engineId} data-engine-quota-status={nativeUnqueried ? 'unqueried' : source.status}>
                {source.meters.length > 0 ? (
                  <div className="space-y-2.5" data-engine-native-meters={engineId}>
                    {source.meters.map((meter) => <QuotaMeterRow key={meter.id} meter={meter} sourceStatus={source.status} />)}
                  </div>
                ) : nativeUnqueried ? (
                  <div className="flex flex-wrap items-center gap-2 py-0.5 text-[12px] text-ink-soft" data-engine-quota-unqueried={engineId}>
                    <span>{t('usage.quota.notQueried')}</span>
                    {canRefreshNative ? (
                      <>
                        <span aria-hidden className="text-ink-faint">·</span>
                        <button
                          type="button"
                          data-engine-quota-query={engineId}
                          disabled={isRefreshingNative || isNativeLocked}
                          onClick={() => { void runNativeRefresh(); }}
                          className="font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink disabled:opacity-50"
                        >
                          {t('usage.quota.queryNow')}
                        </button>
                      </>
                    ) : null}
                  </div>
                ) : (
                  <p className={`py-0.5 text-[12px] ${source.status === 'error' ? 'text-danger' : 'text-ink-soft'}`}>
                    {source.message ?? source.reason ?? t(source.status === 'ready' || source.status === 'stale' ? 'st.quota.none' : 'usage.quota.status.unknown')}
                  </p>
                )}
                {source.message && source.meters.length > 0 ? <p className="text-[11.5px] text-ink-soft">{source.message}</p> : null}
              </div>
            ) : (
              <div className="py-0.5" data-engine-quota-status="unsupported">
                <p className="text-[11.5px] text-ink-faint">
                  {t(q(matchingPluginSources.length > 0 ? 'usage.quota.engines.nativeUnsupportedWithPlugin' : 'usage.quota.engines.nativeUnsupported'))}
                </p>
              </div>
            )
          ) : (
            <div className="space-y-2" data-engine-plugin-quota={engineId} data-engine-quota-status={pStatus}>
              {pStatus === 'missing' ? (
                <p className="py-0.5 text-[12px] text-danger" data-engine-quota-error={engineId}>
                  {t(q('usage.quota.engines.pluginMissing'), { source: selectedSourceId })}
                </p>
              ) : pStatus === 'error' ? (
                <p className="py-0.5 text-[12px] text-danger" data-engine-quota-error={engineId}>
                  {pluginError ?? selectedPluginSnapshot?.error ?? pluginCatalogError}
                </p>
              ) : pStatus === 'unqueried' ? (
                <div className="flex flex-wrap items-center gap-2 py-0.5 text-[12px] text-ink-soft" data-engine-quota-unqueried={engineId}>
                  <span>{t('usage.quota.notQueried')}</span>
                  <span aria-hidden className="text-ink-faint">·</span>
                  <button
                    type="button"
                    data-engine-quota-query={engineId}
                    disabled={isRefreshingPlugin}
                    onClick={() => { void runPluginRefresh(); }}
                    className="font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink disabled:opacity-50"
                  >
                    {t('usage.quota.queryNow')}
                  </button>
                </div>
              ) : pStatus === 'expired' ? (
                <div className="flex items-center gap-1.5" data-engine-quota-expired={engineId}>
                  <button
                    type="button"
                    data-engine-quota-query={engineId}
                    data-engine-quota-read-at={selectedPluginSnapshot?.readAt}
                    disabled={isRefreshingPlugin}
                    onClick={() => { void runPluginRefresh(); }}
                    aria-label={`${t(q('usage.quota.engines.pluginExpired'), {
                      time: selectedPluginSnapshot?.readAt ? time.relativeTime(selectedPluginSnapshot.readAt) : '',
                    })} · ${t('usage.quota.refresh')}`}
                    title={`${t(q('usage.quota.engines.pluginExpired'), {
                      time: selectedPluginSnapshot?.readAt ? time.relativeTime(selectedPluginSnapshot.readAt) : '',
                    })} · ${t('usage.quota.refresh')}`}
                    className="inline-flex h-7 items-center gap-1 rounded border border-amber-rule/40 bg-amber-card px-2 text-[11px] font-medium text-amber-ink transition-colors hover:bg-amber-rule/15 disabled:opacity-50"
                  >
                    <Icon name="refresh" size={12} className={isRefreshingPlugin ? 'animate-spin' : undefined} />
                    <span>{t('usage.quota.status.expired')}</span>
                  </button>
                </div>
              ) : accountGroups.length === 0 ? (
                <p className="py-0.5 text-[12px] text-ink-soft" data-engine-quota-empty={engineId}>
                  {t(q('usage.quota.engines.pluginEmpty'))}
                </p>
              ) : isMultiSeat ? (
                !fleetOpen ? (
                  <FleetPoolSummaryRow
                    engineId={engineId}
                    accountGroups={accountGroups}
                    expanded={fleetOpen}
                    onToggle={() => { setFleetOpen(true); }}
                  />
                ) : null
              ) : (
                <SingleAccountPluginRow
                  account={accountGroups[0]!}
                  snapshotReadAt={selectedPluginSnapshot?.readAt}
                />
              )}
            </div>
          )}
          <FeedbackLine feedback={feedback} />
        </div>

        <div className="flex shrink-0 items-center justify-end gap-1.5 max-md:order-2">
          {showSourceSelect ? (
            <SearchableSelect
              triggerData={{
                'data-engine-quota-source': engineId,
                'data-quota-engines-auto-note': 'true',
              }}
              ariaLabel={t(q('usage.quota.engines.sourceAria'), { engine: source.label })}
              title={t(q('usage.quota.engines.autoScheduleNote'))}
              value={selectedSourceId}
              disabled={savingSource}
              align="end"
              onChange={(next) => {
                setLocalFeedback(null);
                onClearFeedback();
                void onSelectQuotaSource(next);
              }}
              options={[
                { value: '', label: t(q('usage.quota.engines.sourceNative')) },
                ...(selectedSourceId !== '' && !matchingPluginSources.some((entry) => entry.id === selectedSourceId)
                  ? [{ value: selectedSourceId, label: selectedPluginSnapshot?.label ?? selectedSourceId }]
                  : []),
                ...matchingPluginSources.map((entry) => ({ value: entry.id, label: entry.label })),
              ]}
              buttonClassName={`${SMALL_INPUT} flex min-w-[124px] max-w-[196px] items-center justify-between gap-1.5 py-1 pr-2 pl-2.5 text-[11.5px] pointer-coarse:min-h-11`}
            />
          ) : null}
          {canRefreshPlugin ? (
            <button
              type="button"
              data-engine-quota-refresh={engineId}
              data-engine-quota-read-at={headerReadAt}
              disabled={isRefreshingPlugin}
              aria-label={refreshTooltip}
              title={refreshTooltip}
              onClick={() => { void runPluginRefresh(); }}
              className={ICON_BUTTON}
            >
              <Icon name="refresh" size={14} className={isRefreshingPlugin ? 'animate-spin' : undefined} />
            </button>
          ) : canRefreshNative ? (
            <button
              type="button"
              data-engine-quota-refresh={engineId}
              data-quota-source-refresh={source.id}
              data-engine-quota-read-at={headerReadAt}
              disabled={isRefreshingNative || isNativeLocked}
              aria-label={nativeRefreshTooltip}
              title={nativeRefreshTooltip}
              onClick={() => { void runNativeRefresh(); }}
              className={ICON_BUTTON}
            >
              <Icon name="refresh" size={14} className={isRefreshingNative ? 'animate-spin' : undefined} />
              {isNativeLocked ? <span className="font-mono text-[10.5px]">{nativeSecondsLeft}s</span> : null}
            </button>
          ) : null}
        </div>
      </div>

      {isMultiSeat && fleetOpen ? (
        <PluginAccountsMatrix
          engineId={engineId}
          accountGroups={accountGroups}
          snapshotReadAt={selectedPluginSnapshot?.readAt}
        />
      ) : null}
    </li>
  );
}

function hasAnyExhaustedPool(readings: readonly HarnessQuotaReading[]): boolean {
  for (const reading of readings) {
    const val = formatHarnessQuotaReading(reading);
    if (val.kind === 'known' && val.exhausted) return true;
  }
  return false;
}

function accountSeatDotClass(readings: readonly HarnessQuotaReading[]): string {
  let hasKnown = false;
  let anyExhausted = false;
  let anyLow = false;
  for (const reading of readings) {
    const val = formatHarnessQuotaReading(reading);
    if (val.kind === 'unknown') continue;
    hasKnown = true;
    if (val.exhausted) anyExhausted = true;
    else if (val.remainingPercent !== undefined && val.remainingPercent < 30) anyLow = true;
  }
  if (!hasKnown) return 'bg-ink/25';
  if (anyExhausted) return 'bg-danger';
  if (anyLow) return 'bg-amber-rule';
  return 'bg-success';
}

function resolveReadingPoolLabel(reading: HarnessQuotaReading, defaultPoolLabel: string): string {
  const models = reading.modelIds ?? [];
  const singleModelAsLabel = reading.pool === undefined && models.length === 1;
  return reading.pool ?? (singleModelAsLabel ? models[0]! : defaultPoolLabel);
}

interface FleetPoolSummaryItem {
  readonly key: string;
  readonly label: string;
  readonly window: string | undefined;
  readonly avgPercent: number | undefined;
  readonly fallbackValue: string | undefined;
  readonly resetShort: string | undefined;
}

function summarizeFleetPools(
  accountGroups: readonly HarnessQuotaAccountGroup[],
  defaultPoolLabel: string,
): readonly FleetPoolSummaryItem[] {
  const map = new Map<string, {
    label: string;
    window: string | undefined;
    percents: number[];
    fallbackValue: string | undefined;
    earliestResetAt: string | undefined;
    earliestResetMs: number;
  }>();

  for (const group of accountGroups) {
    for (const reading of group.readings) {
      const label = resolveReadingPoolLabel(reading, defaultPoolLabel);
      const key = `${label}::${reading.window ?? ''}`;
      let entry = map.get(key);
      if (entry === undefined) {
        entry = {
          label,
          window: reading.window,
          percents: [],
          fallbackValue: undefined,
          earliestResetAt: undefined,
          earliestResetMs: Number.POSITIVE_INFINITY,
        };
        map.set(key, entry);
      }
      const val = formatHarnessQuotaReading(reading);
      if (val.kind === 'known') {
        if (val.remainingPercent !== undefined) entry.percents.push(val.remainingPercent);
        else if (entry.fallbackValue === undefined) entry.fallbackValue = val.value;
      }
      if (reading.resetAt) {
        const ms = Date.parse(reading.resetAt);
        if (Number.isFinite(ms) && ms > Date.now() && ms < entry.earliestResetMs) {
          entry.earliestResetMs = ms;
          entry.earliestResetAt = reading.resetAt;
        }
      }
    }
  }

  return [...map.entries()].map(([key, item]) => {
    const avgPercent = item.percents.length > 0
      ? Math.round(item.percents.reduce((sum, n) => sum + n, 0) / item.percents.length)
      : undefined;
    return {
      key,
      label: item.label,
      window: item.window,
      avgPercent,
      fallbackValue: item.fallbackValue,
      resetShort: formatQuotaResetShort(item.earliestResetAt),
    };
  });
}

function FleetPoolSummaryRow({
  engineId,
  accountGroups,
  expanded,
  onToggle,
}: {
  readonly engineId: string;
  readonly accountGroups: readonly HarnessQuotaAccountGroup[];
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const { t } = useI18n();
  const defaultPoolLabel = t(q('usage.quota.engines.defaultPool'));
  const pools = useMemo(
    () => summarizeFleetPools(accountGroups, defaultPoolLabel),
    [accountGroups, defaultPoolLabel],
  );
  const colsClass =
    pools.length >= 4
      ? 'grid-cols-2 lg:grid-cols-4'
      : pools.length === 3
        ? 'grid-cols-1 sm:grid-cols-3'
        : pools.length === 2
          ? 'grid-cols-1 sm:grid-cols-2'
          : 'grid-cols-1';

  return (
    <button
      type="button"
      data-quota-fleet-summary={engineId}
      aria-expanded={expanded}
      onClick={onToggle}
      className={`grid w-full gap-x-5 gap-y-2 rounded-md py-0.5 text-left transition-colors hover:bg-ink/[0.025] focus-visible:outline-2 focus-visible:outline-selected-ink ${colsClass}`}
    >
      {pools.map((pool) => {
        const pct = pool.avgPercent;
        const tier = pct !== undefined ? quotaFuelTier(pct) : undefined;
        const tone = pct === undefined
          ? 'text-ink-faint'
          : pct <= 0 || tier === 'critical'
            ? 'font-medium text-danger'
            : tier === 'low'
              ? 'font-medium text-amber-ink'
              : 'font-medium text-ink';
        return (
          <div key={pool.key} className="min-w-0 space-y-1 text-[12px]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-ink-soft">
                {pool.label}
                {pool.window ? <span className="text-ink-faint"> · {pool.window}</span> : null}
              </span>
              <span className={`shrink-0 text-[11.5px] tabular-nums ${tone}`}>
                {pct !== undefined ? `${pct}%` : (pool.fallbackValue ?? t('usage.quota.status.unknown'))}
              </span>
            </div>
            {pct !== undefined ? (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.07]">
                <div
                  className={`h-full rounded-full transition-all duration-200 ${quotaFuelBarClass(pct)}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </button>
  );
}

function SingleAccountPluginRow({
  account,
  snapshotReadAt,
}: {
  readonly account: HarnessQuotaAccountGroup;
  readonly snapshotReadAt: string | undefined;
}) {
  const cols = account.readings.length;
  const gridClass =
    cols >= 4
      ? 'grid gap-x-5 gap-y-2 sm:grid-cols-2 lg:grid-cols-4'
      : cols === 3
        ? 'grid gap-x-5 gap-y-2 sm:grid-cols-3'
        : cols === 2
          ? 'grid gap-x-5 gap-y-2 sm:grid-cols-2'
          : 'space-y-2';

  return (
    <div data-engine-plugin-readings data-quota-account={account.accountId} className={gridClass}>
      {account.readings.map((reading, idx) => (
        <PluginQuotaBucketCell
          key={`${reading.pool ?? 'default'}:${reading.window ?? ''}:${idx}`}
          reading={reading}
          snapshotReadAt={snapshotReadAt}
          showPoolLabel="always"
          showModelDisclosure
          alignTrack={cols > 1}
        />
      ))}
    </div>
  );
}

function columnSequenceSignature(readings: readonly HarnessQuotaReading[], defaultPoolLabel: string): string {
  return readings
    .map((reading) => `${resolveReadingPoolLabel(reading, defaultPoolLabel)}::${reading.window ?? ''}`)
    .join('|');
}

function PluginAccountsMatrix({
  engineId,
  accountGroups,
  snapshotReadAt,
}: {
  readonly engineId: string;
  readonly accountGroups: readonly HarnessQuotaAccountGroup[];
  readonly snapshotReadAt: string | undefined;
}) {
  const { t } = useI18n();
  const defaultPoolLabel = t(q('usage.quota.engines.defaultPool'));
  const firstGroup = accountGroups[0];
  const firstSig = firstGroup ? columnSequenceSignature(firstGroup.readings, defaultPoolLabel) : '';
  const isUniformMatrix =
    accountGroups.length > 1 &&
    firstGroup !== undefined &&
    firstGroup.readings.length > 0 &&
    accountGroups.every(
      (group) =>
        group.readings.length === firstGroup.readings.length &&
        columnSequenceSignature(group.readings, defaultPoolLabel) === firstSig,
    );

  const maxCols = Math.max(1, ...accountGroups.map((group) => group.readings.length));
  const cellsGridClass =
    maxCols >= 4
      ? 'grid gap-x-5 gap-y-2 md:grid-cols-4'
      : maxCols === 3
        ? 'grid gap-x-5 gap-y-2 md:grid-cols-3'
        : maxCols === 2
          ? 'grid gap-x-5 gap-y-2 md:grid-cols-2'
          : 'space-y-2';

  const firstModelSigOccurrence = useMemo(() => {
    const seen = new Set<string>();
    const allowed = new Set<string>();
    accountGroups.forEach((group, groupIndex) => {
      group.readings.forEach((reading, readingIndex) => {
        const models = reading.modelIds ?? [];
        if (models.length === 0) return;
        const sig = `${reading.pool ?? 'default'}::${models.join(',')}`;
        if (!seen.has(sig)) {
          seen.add(sig);
          allowed.add(`${groupIndex}:${readingIndex}`);
        }
      });
    });
    return allowed;
  }, [accountGroups]);

  return (
    <div
      className="divide-y divide-hairline/70 border-t border-hairline/70 pt-2"
      data-engine-plugin-readings={engineId}
    >
      {isUniformMatrix && firstGroup !== undefined ? (
        <div
          data-quota-matrix-header
          className="hidden pb-2 md:grid md:grid-cols-[minmax(176px,216px)_minmax(0,1fr)] md:items-start md:gap-x-6"
        >
          <span className="text-[11px] text-ink-faint">
            {t('usage.quota.summary.seats', { count: accountGroups.length })}
          </span>
          <div className={cellsGridClass}>
            {firstGroup.readings.map((reading, colIndex) => (
              <MatrixColumnHeader
                key={`${reading.pool ?? 'default'}:${reading.window ?? ''}:${colIndex}`}
                reading={reading}
                showModelDisclosure={firstModelSigOccurrence.has(`0:${colIndex}`)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {accountGroups.map((group, groupIndex) => {
        const seatDot = accountSeatDotClass(group.readings);
        const labelDisplay = compactIdentifier(group.accountLabel);
        const idDisplay = group.showAccountId ? compactIdentifier(group.accountId) : undefined;
        return (
          <div
            key={group.accountId}
            data-quota-account={group.accountId}
            className="grid grid-cols-1 gap-x-6 gap-y-2 py-2 last:pb-0.5 md:grid-cols-[minmax(176px,216px)_minmax(0,1fr)] md:items-center"
          >
            <div className="flex min-w-0 items-center gap-2 text-[12px]">
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${seatDot}`} />
              <span className="min-w-0 truncate text-ink" title={group.accountLabel}>
                {labelDisplay}
              </span>
              {idDisplay !== undefined ? (
                <span className="shrink-0 font-mono text-[10.5px] text-ink-faint" title={group.accountId}>
                  {idDisplay}
                </span>
              ) : null}
            </div>

            <div className={cellsGridClass}>
              {group.readings.map((reading, readingIndex) => (
                <PluginQuotaBucketCell
                  key={`${reading.pool ?? 'default'}:${reading.window ?? ''}:${readingIndex}`}
                  reading={reading}
                  snapshotReadAt={snapshotReadAt}
                  showPoolLabel={isUniformMatrix ? 'mobileOnly' : 'always'}
                  showModelDisclosure={!isUniformMatrix && firstModelSigOccurrence.has(`${groupIndex}:${readingIndex}`)}
                  alignTrack={maxCols > 1}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MatrixColumnHeader({
  reading,
  showModelDisclosure,
}: {
  readonly reading: HarnessQuotaReading;
  readonly showModelDisclosure: boolean;
}) {
  const { t } = useI18n();
  const [modelsOpen, setModelsOpen] = useState(false);
  const models = reading.modelIds ?? [];
  const poolLabel = resolveReadingPoolLabel(reading, t(q('usage.quota.engines.defaultPool')));
  const foldModels = showModelDisclosure && models.length > 2;

  return (
    <div className="min-w-0 space-y-1 text-[11.5px]">
      <div className="flex items-center justify-between gap-1.5">
        <span className="min-w-0 truncate font-medium text-ink-soft" title={poolLabel}>
          {poolLabel}
          {reading.window ? <span className="font-normal text-ink-faint"> · {reading.window}</span> : null}
        </span>
        {foldModels ? (
          <button
            type="button"
            data-reading-models-toggle
            aria-expanded={modelsOpen}
            onClick={() => { setModelsOpen((prev) => !prev); }}
            className="inline-flex shrink-0 items-center gap-0.5 rounded bg-ink/[0.04] px-1.5 py-px font-mono text-[10px] text-ink-faint transition-colors hover:bg-ink/[0.08] hover:text-ink"
          >
            <DisclosureChevron open={modelsOpen} />
            <span>{t(q('usage.quota.engines.modelsCount'), { count: models.length })}</span>
          </button>
        ) : null}
      </div>
      {foldModels && modelsOpen ? (
        <div className="flex flex-wrap gap-1 pt-0.5" data-reading-models-list>
          {models.map((modelId) => (
            <span key={modelId} className="rounded border border-hairline bg-paper px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
              {modelId}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PluginQuotaBucketCell({
  reading,
  snapshotReadAt,
  showPoolLabel,
  showModelDisclosure,
  alignTrack,
}: {
  readonly reading: HarnessQuotaReading;
  readonly snapshotReadAt: string | undefined;
  readonly showPoolLabel: 'always' | 'mobileOnly';
  readonly showModelDisclosure: boolean;
  readonly alignTrack: boolean;
}) {
  const { t, locale } = useI18n();
  const [modelsOpen, setModelsOpen] = useState(false);
  const val = formatHarnessQuotaReading(reading);
  const models = reading.modelIds ?? [];
  const singleModelAsLabel = reading.pool === undefined && models.length === 1;
  const poolLabel = resolveReadingPoolLabel(reading, t(q('usage.quota.engines.defaultPool')));
  const inlineModels = showModelDisclosure && !singleModelAsLabel && models.length > 0 && models.length <= 2;
  const foldModels = showModelDisclosure && models.length > 2;
  const distinctReadAt = reading.readAt !== undefined && reading.readAt !== snapshotReadAt ? reading.readAt : undefined;
  const remainingPct = val.kind === 'known' ? val.remainingPercent : undefined;
  const tier = remainingPct !== undefined ? quotaFuelTier(remainingPct) : undefined;
  const resetShort = formatQuotaResetShort(reading.resetAt);
  const resetFull = formatQuotaResetDuration(reading.resetAt, locale);

  const valueTone =
    val.kind === 'known'
      ? val.exhausted || tier === 'critical'
        ? 'font-medium text-danger'
        : tier === 'low'
          ? 'font-medium text-amber-ink'
          : 'font-medium text-ink'
      : 'text-ink-faint';

  return (
    <div
      className="min-w-0 space-y-1 text-[12px]"
      data-quota-bucket={reading.pool ?? 'default'}
      data-quota-window={reading.window ?? ''}
      data-quota-low={tier === 'critical' ? 'true' : undefined}
      data-reading-read-at={distinctReadAt}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={`min-w-0 truncate text-ink-soft ${showPoolLabel === 'mobileOnly' ? 'md:hidden' : ''}`}
          title={poolLabel}
        >
          {poolLabel}
          {reading.window ? <span className="text-ink-faint" data-bucket-window> · {reading.window}</span> : null}
        </span>

        <span className={`flex shrink-0 items-baseline gap-2 tabular-nums ${showPoolLabel === 'mobileOnly' ? 'md:w-full md:justify-between' : ''}`}>
          {val.kind === 'unknown' ? (
            <span className="text-[11.5px] text-ink-faint" data-reading-state="unknown">
              {t('usage.quota.status.unknown')}
            </span>
          ) : (
            <span
              className={`text-[11.5px] ${valueTone}`}
              data-reading-state={val.exhausted ? 'exhausted' : 'available'}
            >
              {val.value}
            </span>
          )}
          {resetShort !== undefined && reading.resetAt ? (
            <span
              className="text-[10.5px] text-ink-faint"
              title={resetFull ? t('usage.quota.stripReset', { time: resetFull }) : reading.resetAt}
            >
              {resetShort}
            </span>
          ) : null}
        </span>
      </div>

      {remainingPct !== undefined ? (
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.07]" data-bucket-progress>
          <div
            className={`h-full rounded-full transition-all duration-200 ${quotaFuelBarClass(remainingPct)}`}
            style={{ width: `${remainingPct}%` }}
          />
        </div>
      ) : alignTrack ? (
        <div aria-hidden className="h-1.5 w-full rounded-full border border-dashed border-hairline/80" />
      ) : null}

      {inlineModels || foldModels ? (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-[10.5px] text-ink-faint">
          {inlineModels ? (
            <span className="font-mono text-[10px]" data-reading-models-inline>
              {models.join(' · ')}
            </span>
          ) : <span />}
          {foldModels ? (
            <button
              type="button"
              data-reading-models-toggle
              aria-expanded={modelsOpen}
              onClick={() => { setModelsOpen((prev) => !prev); }}
              className="inline-flex items-center gap-0.5 rounded bg-ink/[0.04] px-1.5 py-px font-mono text-[10px] text-ink-soft transition-colors hover:bg-ink/[0.08] hover:text-ink"
            >
              <DisclosureChevron open={modelsOpen} />
              <span>{t(q('usage.quota.engines.modelsCount'), { count: models.length })}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {foldModels && modelsOpen ? (
        <div className="flex flex-wrap gap-1 pt-0.5" data-reading-models-list>
          {models.map((modelId) => (
            <span key={modelId} className="rounded border border-hairline bg-paper px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
              {modelId}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function UnsupportedQuotaSection({ sources, providerById }: {
  readonly sources: readonly ProviderQuotaSource[];
  readonly providerById: (id: string) => ProviderCatalogItem | undefined;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  const ordered = [...sources.filter((source) => source.kind === 'provider'), ...sources.filter((source) => source.kind !== 'provider')];
  return (
    <details
      data-quota-unsupported={sources.length}
      open={open}
      onToggle={(event) => { setOpen(event.currentTarget.open); }}
      className="pt-1"
    >
      <summary
        title={t(q('usage.quota.unsupported.note'))}
        className="flex cursor-pointer list-none items-center gap-2 py-1.5 text-[12px] text-ink-faint transition-colors hover:text-ink [&::-webkit-details-marker]:hidden"
      >
        <DisclosureChevron open={open} />
        <span>{t(q('usage.quota.unsupported.summary'), { n: sources.length })}</span>
      </summary>
      <div className="pb-2 pl-5">
        <ul className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
          {ordered.map((source) => (
            <li key={source.id} data-quota-unsupported-item={source.id} className="flex min-w-0 items-center gap-2 py-0.5">
              <span className="min-w-0 truncate font-mono text-[12px] text-ink-soft" title={source.label}>{source.label}</span>
              <KindTag kind={source.kind} />
              <Link to={quotaSettingsHref(source, providerById(source.provider_id))} data-quota-settings-link={source.id}
                className={`ml-auto ${ROW_LINK}`}>{t('usage.quota.action.settings')}</Link>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function OffQuotaSection({ sources, providerById, onEnable }: {
  readonly sources: readonly ProviderQuotaSource[];
  readonly providerById: (id: string) => ProviderCatalogItem | undefined;
  readonly onEnable: (id: string) => Promise<ProviderQuotaSnapshot>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  return (
    <details
      data-quota-off={sources.length}
      open={open}
      onToggle={(event) => { setOpen(event.currentTarget.open); }}
      className="pt-1"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 py-1.5 text-[12px] text-ink-faint transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
        <DisclosureChevron open={open} />
        <span>{t('usage.quota.off.summary', { n: sources.length })}</span>
      </summary>
      <ul className="divide-y divide-hairline/70 pb-2 pl-5">
        {sources.map((source) => (
          <OffQuotaRow key={source.id} source={source} href={quotaSettingsHref(source, providerById(source.provider_id))} onEnable={() => onEnable(source.id)} />
        ))}
      </ul>
    </details>
  );
}

function OffQuotaRow({ source, href, onEnable }: {
  readonly source: ProviderQuotaSource;
  readonly href: string;
  readonly onEnable: () => Promise<ProviderQuotaSnapshot>;
}) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const enable = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const next = await onEnable();
      const after = next?.sources.find((entry) => entry.id === source.id);
      if (after !== undefined && !after.enabled) setFeedback({ tone: 'error', text: t(q('usage.quota.off.blocked')) });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li data-quota-off-item={source.id} className="py-1.5">
      <div className="flex min-h-8 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-[12px] text-ink-soft">{source.label}</span>
        <KindTag kind={source.kind} />
        <Link to={href} data-quota-settings-link={source.id} className={`ml-auto ${ROW_LINK}`}>{t('usage.quota.action.settings')}</Link>
        <Toggle layout="bare" label={t('usage.quota.toggleEnable', { name: source.label })} checked={false} disabled={busy}
          onChange={(enabled) => { if (enabled) void enable(); }} />
      </div>
      <FeedbackLine feedback={feedback} />
    </li>
  );
}

function QuotaMeterRow({ meter, sourceStatus }: { readonly meter: ProviderQuotaMeter; readonly sourceStatus: ProviderQuotaStatus }) {
  const { t, locale } = useI18n();
  const periodLabel = meter.window?.label ?? formatWindowPeriod(meter.window?.duration_seconds);
  const { title: compactLabel, periodSuffix } = compactQuotaMeterLabel(meter.label, periodLabel);
  const status = meter.status ?? sourceStatus;
  const badge = statusBadgeInfo(status);
  const remainingPercent = meterRemainingPercent(meter);
  const tier = remainingPercent !== undefined ? quotaFuelTier(remainingPercent) : undefined;
  const reading = meterValue(meter);

  const primaryText =
    reading.kind === 'unknown'
      ? t('usage.quota.status.unknown')
      : remainingPercent !== undefined
        ? `${remainingPercent}%`
        : reading.value;

  const hoverDetail =
    remainingPercent !== undefined && reading.kind === 'ratio'
      ? reading.value
      : undefined;

  const exhausted =
    (remainingPercent !== undefined && remainingPercent <= 0) ||
    (meter.remaining !== null && meter.remaining <= 0);
  const primaryTone =
    reading.kind === 'unknown'
      ? 'text-ink-faint'
      : exhausted || tier === 'critical'
        ? 'font-medium text-danger'
        : tier === 'low'
          ? 'font-medium text-amber-ink'
          : 'font-medium text-ink';
  const resetTime = meter.window?.reset_at;
  const resetShort = formatQuotaResetShort(resetTime);
  const resetFull = formatQuotaResetDuration(resetTime, locale);

  return (
    <div
      className="space-y-1 text-[12px]"
      data-quota-meter={meter.id}
      data-quota-low={tier === 'critical' ? 'true' : undefined}
      data-meter-detail={hoverDetail}
      title={hoverDetail}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-ink-soft">{compactLabel}</span>
          {periodSuffix ? <span className="shrink-0 text-ink-faint">· {periodSuffix}</span> : null}
          {meter.scope === 'team' ? <span className="shrink-0 text-[11px] text-ink-faint">· Team</span> : null}
          {status !== 'ready' ? (
            <span className={`shrink-0 rounded border px-1 py-px text-[9.5px] font-medium ${badge.toneClass}`} data-meter-status={status}>{t(badge.labelKey as I18nKey)}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-baseline gap-x-2 tabular-nums">
          <span className={`text-[12px] ${primaryTone}`}>{primaryText}</span>
          {resetShort !== undefined && resetTime ? (
            <span
              className="text-[11px] text-ink-faint"
              title={resetFull ? t('usage.quota.stripReset', { time: resetFull }) : resetTime}
            >
              {resetShort}
            </span>
          ) : null}
        </span>
      </div>
      {remainingPercent !== undefined ? (
        <div
          className="relative h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.07]"
          data-quota-progress
          data-remaining-percent={remainingPercent}
        >
          <div
            className={`h-full rounded-full transition-all duration-200 ${quotaFuelBarClass(remainingPercent)}`}
            style={{ width: `${remainingPercent}%` }}
          />
        </div>
      ) : null}
      {meter.message ? <p className="text-[11px] text-danger">{meter.message}</p> : null}
    </div>
  );
}
