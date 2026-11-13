import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExecutorCatalogItem, ProviderCatalogItem } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
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
  arrangeQuotaSources, effectiveQuotaStatus, formatHarnessQuotaReading, formatWindowPeriod,
  groupHarnessQuotaReadings, HARNESS_QUOTA_UNAVAILABLE_MESSAGE, harnessQuotaQueryKey, isSourceLocked,
  isSourceRefreshable, mergeHarnessQuotaSnapshots, meterUtilization, meterValue,
  normalizeQuotaSources, pluginQuotaNextExpiryMs, pluginQuotaSnapshotStatus, quotaEngineScopeOf,
  quotaLocalUsageHref, quotaSettingsHref, readCachedHarnessQuota, signedOutProviderIds, statusBadgeInfo,
  useProviderQuotas,
  type HarnessQuotaReading, type PluginHarnessQuotaSnapshot,
  type ProviderQuotaMeter, type ProviderQuotaSnapshot, type ProviderQuotaSource, type ProviderQuotaStatus,
} from '../../lib/providerQuota';

const ENGINE_HEALTH: Record<EngineHealth, { readonly key: I18nKey; readonly dot: string }> = {
  ready: { key: 'st.engines.statusReady', dot: 'bg-success' },
  warning: { key: 'st.engines.statusWarning', dot: 'bg-amber-ink' },
  missing: { key: 'st.engines.statusMissing', dot: 'bg-danger' },
  unknown: { key: 'st.engines.statusUnknown', dot: 'bg-ink/[0.25]' },
};

const ROW_LINK = 'inline-flex h-7 shrink-0 items-center rounded px-1.5 text-[11.5px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink';
const SMALL_BUTTON = 'inline-flex h-7 items-center gap-1 rounded border border-hairline bg-paper px-2 text-[11px] font-medium text-ink transition-colors hover:bg-ink/[0.05] disabled:opacity-50';
const ICON_BUTTON = 'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded border border-hairline bg-paper px-1.5 text-[11px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50';

/**
 * Usage › Quota. The subject is what each vendor still allows: enabled sources
 * with an official quota API form a single ledger; sources needing sign-in or
 * recovery surface at the top. Connections without such an API or with checks
 * turned off are folded at the tail, and external engines appear only when
 * turned on in Settings.
 */
export function ProviderQuotaPanel() {
  const { t, time, locale } = useI18n();
  const { client, scopeId, meta } = useConnection();
  const queryClient = useQueryClient();
  const { snapshot, loading, isError, stale, refetch, isRefetching, refreshSource, refreshingSourceId, setSourceEnabled } = useProviderQuotas();
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000, retry: false });
  const executorsQuery = useExecutorCatalogQuery();
  const pluginQuotaKey = harnessQuotaQueryKey(scopeId, meta?.server_id);
  const harnessQuotaQuery = useQuery({
    queryKey: pluginQuotaKey,
    queryFn: ({ signal }) => readCachedHarnessQuota(client.klient?.rest?.harnessQuota, signal),
    enabled: client.klient?.rest?.harnessQuota !== undefined,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const pluginQuotaSources = harnessQuotaQuery.data?.sources ?? [];
  const pluginCatalogError = harnessQuotaQuery.isError ? errorText(locale, harnessQuotaQuery.error) : undefined;
  const [expiryTick, setExpiryTick] = useState(0);
  const now = Date.now();
  const nextPluginExpiryMs = useMemo(
    () => pluginQuotaNextExpiryMs(pluginQuotaSources, now),
    [pluginQuotaSources, now, expiryTick],
  );
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
            // Error is already captured in pluginErrors state per pluginId.
          }
        }),
      ]);
    } finally {
      setRefreshingAll(false);
      setActiveRefreshSourceIds([]);
    }
  };

  return (
    <div className="space-y-6" data-provider-quota-panel>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="mr-auto font-display text-[18px] leading-6 text-ink">{t('usage.quota.title')}</h2>
        <div className="flex items-center gap-3">
          {stale ? (
            <span className="text-[12px] text-amber-ink" data-quota-stale>
              {t('usage.governance.stale', { time: asOfTime ? time.relativeTime(asOfTime) : '' })}
            </span>
          ) : asOfTime ? (
            <span className="text-[12px] text-ink-faint">{t('usage.quota.asOf', { time: time.relativeTime(asOfTime) })}</span>
          ) : null}
          <button type="button" data-quota-refresh-button onClick={() => void handleHeaderRefresh()} disabled={loading || isRefetching || refreshingAll}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-sm text-[12.5px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:min-h-11">
            <Icon name="refresh" size={14} className={isRefetching || refreshingAll ? 'animate-spin' : undefined} />
            {t(isRefetching || refreshingAll ? 'usage.quota.refreshing' : 'usage.quota.refreshAll')}
          </button>
        </div>
      </div>
      {loading ? (
        <div role="status" className="flex items-center justify-center gap-2 rounded-xl border border-hairline bg-panel px-4 py-8 text-[13px] text-ink-faint">
          <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />{t('usage.loading')}
        </div>
      ) : isError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-[12.5px] text-danger" data-quota-snapshot-error>
          <p className="font-medium">{t('usage.quota.status.error')}</p>
          <button type="button" data-quota-snapshot-retry className={SMALL_BUTTON} onClick={() => { void refetch(); }}>
            {t('st.im.retry')}
          </button>
        </div>
      ) : (
        <>
          {arranged.live.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline bg-panel px-4 py-6 text-[13px] text-ink-faint" data-quota-empty>
              <div>
                <p className="text-ink-soft">{t('usage.quota.emptyTitle')}</p>
                <p className="mt-0.5 text-[11.5px] text-ink-faint">{t('usage.quota.emptyBody')}</p>
              </div>
              <Link to="/settings/ai?tab=providers" data-quota-manage-connections className={ROW_LINK}>
                {t('usage.quota.action.manageConnections')}
              </Link>
            </div>
          ) : (
            <div className="space-y-5" data-quota-items>
              {arranged.attention.length > 0 ? (
                <section className="space-y-2" data-quota-attention>
                  <SectionHeading title={t('usage.quota.attentionTitle')} />
                  <div className="space-y-2.5">
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
                  </div>
                </section>
              ) : null}

              {arranged.ledger.length > 0 ? (
                <section className="space-y-2" data-quota-ledger>
                  {arranged.attention.length > 0 ? <SectionHeading title={t('usage.quota.ledgerTitle')} /> : null}
                  <div className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-panel">
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
                  </div>
                </section>
              ) : null}
            </div>
          )}
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
          <div className="space-y-2">
            <UnsupportedQuotaSection sources={arranged.unsupported} providerById={providerById} />
            <OffQuotaSection sources={arranged.off} providerById={providerById} onEnable={(id) => setSourceEnabled(id, true)} />
          </div>
        </>
      )}
    </div>
  );
}

function q(key: I18nKey): I18nKey {
  return key;
}

function SectionHeading({ title, action, children }: { readonly title: string; readonly action?: ReactNode; readonly children?: ReactNode }) {
  return (
    <div className="mb-2 space-y-0.5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function KindTag({ kind }: { readonly kind: ProviderQuotaSource['kind'] }) {
  const { t } = useI18n();
  if (kind === 'provider') return null;
  return <span className="shrink-0 rounded bg-ink/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">{t(`usage.quota.kind.${kind}` as I18nKey)}</span>;
}

function SourceIdentitySubtitle({ source, settingsHref }: {
  readonly source: ProviderQuotaSource;
  readonly settingsHref: string;
}) {
  const { t } = useI18n();
  const detailText = [source.account_label, source.source.label].filter(Boolean).join(' · ');
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-ink-faint">
      <span className="min-w-0 truncate" title={detailText}>{detailText}</span>
      <span aria-hidden>·</span>
      <Link to={settingsHref} data-quota-settings-link={source.id} className="shrink-0 text-ink-soft hover:text-ink hover:underline">
        {t('usage.quota.action.settings')}
      </Link>
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
    ? 'border-amber-rule/40 bg-amber-card'
    : 'border-danger/30 bg-danger/5';

  return (
    <section data-quota-item={source.id} className={`space-y-2.5 rounded-xl border p-3.5 ${cardTone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h4 className="truncate font-display text-[14px] font-semibold text-ink">{source.label}</h4>
            <KindTag kind={source.kind} />
            <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10.5px] font-medium ${badge.toneClass}`} data-quota-status={status}>
              {t(badge.labelKey as I18nKey)}
            </span>
          </div>
          <SourceIdentitySubtitle source={source} settingsHref={settingsHref} />
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
        <div className="space-y-2 border-t border-hairline/70 pt-2.5 opacity-75">
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
  const hasBeenQueried = status !== 'unknown' || source.checked_at !== undefined || source.data_as_of !== undefined;
  const unqueried = !hasBeenQueried && source.meters.length === 0;
  const emptyStatusMessage = source.message ?? source.reason;

  return (
    <section data-quota-item={source.id} className="space-y-2 px-4 py-3">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 md:grid-cols-[minmax(160px,220px)_1fr_auto]">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h4 className="truncate font-display text-[14px] font-semibold text-ink">{source.label}</h4>
            <KindTag kind={source.kind} />
            {status !== 'ready' && !unqueried ? (
              <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${badge.toneClass}`} data-quota-status={status}>
                {t(badge.labelKey as I18nKey)}
              </span>
            ) : (
              <span className="sr-only" data-quota-status={status}>{t(badge.labelKey as I18nKey)}</span>
            )}
          </div>
          <SourceIdentitySubtitle source={source} settingsHref={settingsHref} />
        </div>

        <div className="min-w-0 max-md:col-span-2 max-md:order-3">
          {source.meters.length > 0 ? (
            <div className="space-y-2">
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
  const anyQuotaSelectorShown = engines.some((source) => {
    const engineId = source.provider_id;
    const selected = engineQuotaSourceOf(configRaw, engineId);
    return selected !== '' || pluginQuotaSources.some((entry) => entry.engineIds.includes(engineId));
  });
  return (
    <section data-quota-engines>
      <SectionHeading title={t(q('usage.quota.engines.title'))}
        action={<Link to="/settings/ai#st-card-engines" data-quota-engines-manage className={ROW_LINK}>{t(q('usage.quota.engines.manage'))}</Link>} />
      {configError ? (
        <div className="mb-2 flex flex-wrap items-center gap-2" data-quota-engine-config-error>
          <FeedbackLine feedback={{ tone: 'error', text: t('usage.quota.engines.configError') }} />
          <button type="button" className={SMALL_BUTTON} onClick={onRetryConfig}>{t('st.im.retry')}</button>
        </div>
      ) : null}
      {pluginCatalogError !== undefined ? (
        <div className="mb-2 flex flex-wrap items-center gap-2" data-quota-engine-plugin-error>
          <FeedbackLine feedback={{ tone: 'error', text: pluginCatalogError }} />
          <button type="button" data-quota-engine-plugin-retry className={SMALL_BUTTON} onClick={onRetryPluginCatalog}>{t('st.im.retry')}</button>
        </div>
      ) : null}
      {engines.length > 0 ? (
        <ul className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-panel">
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
      <p className="mt-2 text-[11.5px] text-ink-faint">
        {hidden > 0 ? (
          <span data-quota-hidden-engines={hidden} className="mr-1.5">{t(q('usage.quota.engines.hidden'), { n: hidden })}</span>
        ) : null}
        <span data-quota-engines-auto-note={anyQuotaSelectorShown ? 'true' : undefined}>
          {t(q(anyQuotaSelectorShown ? 'usage.quota.engines.autoScheduleNote' : 'usage.quota.engines.note'))}
        </span>
      </p>
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
  const feedback = localFeedback ?? externalFeedback ?? null;
  const engineId = source.provider_id;
  const view = ENGINE_HEALTH[health];
  const hasQuotaControls = matchingPluginSources.length > 0 || selectedSourceId !== '' || source.supported;

  if (!hasQuotaControls) {
    return (
      <li data-quota-engine={engineId} data-engine-health={health}
        className="flex min-h-10 items-center gap-3 px-3.5 py-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
          {source.label}
          <span className="ml-2 hidden font-mono text-[11px] text-ink-faint sm:inline">{engineId}</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-ink-soft">
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${view.dot}`} />
          {t(view.key)}
        </span>
        {health === 'warning' || health === 'missing' ? (
          <Link to={quotaSettingsHref(source)} data-quota-engine-settings={engineId} className={ROW_LINK}>{t('usage.quota.action.settings')}</Link>
        ) : null}
      </li>
    );
  }

  const isPluginMode = selectedSourceId !== '';
  const showSourceSelect = matchingPluginSources.length > 0 || selectedSourceId !== '';
  const pStatus = isPluginMode
    ? pluginQuotaSnapshotStatus(selectedPluginSnapshot, engineId, pluginError, now, pluginCatalogError !== undefined)
    : undefined;
  const isNativeLocked = !isPluginMode && isSourceLocked(source);
  const nativeRefreshAfterMs = source.refresh_after ? new Date(source.refresh_after).getTime() : 0;
  const nativeSecondsLeft = isNativeLocked ? Math.ceil((nativeRefreshAfterMs - Date.now()) / 1000) : 0;
  const canRefreshNative = !isPluginMode && source.supported && source.enabled;
  const canRefreshPlugin = isPluginMode && pStatus !== 'missing';

  const headerReadAt = isPluginMode
    ? (pStatus !== 'expired' ? selectedPluginSnapshot?.readAt : undefined)
    : (source.supported ? (source.data_as_of ?? source.checked_at) : undefined);

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
  const accountGroups = useMemo(
    () => (isPluginMode && pStatus === 'ready' && selectedPluginSnapshot?.readings !== undefined
      ? groupHarnessQuotaReadings(selectedPluginSnapshot.readings)
      : []),
    [isPluginMode, pStatus, selectedPluginSnapshot?.readings],
  );

  return (
    <li
      data-quota-engine={engineId}
      data-engine-health={health}
      data-engine-quota-mode={isPluginMode ? 'plugin' : 'native'}
      className="space-y-2.5 px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="truncate font-display text-[13.5px] font-semibold text-ink">{source.label}</span>
          <span className="hidden font-mono text-[11px] text-ink-faint sm:inline">{engineId}</span>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-ink-soft">
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${view.dot}`} />
            {t(view.key)}
          </span>
          {health === 'warning' || health === 'missing' ? (
            <Link to={quotaSettingsHref(source)} data-quota-engine-settings={engineId} className={ROW_LINK}>
              {t('usage.quota.action.settings')}
            </Link>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {headerReadAt ? (
            <span
              className="text-[11px] text-ink-faint tabular-nums"
              data-engine-quota-read-at={headerReadAt}
              title={headerReadAt}
            >
              {t(q('usage.quota.engines.readAt'), { time: time.relativeTime(headerReadAt) })}
            </span>
          ) : null}
          {showSourceSelect ? (
            <SearchableSelect
              triggerData={{ 'data-engine-quota-source': engineId }}
              ariaLabel={t(q('usage.quota.engines.sourceAria'), { engine: source.label })}
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
              buttonClassName={`${SMALL_INPUT} flex min-w-[132px] max-w-[220px] items-center justify-between gap-1.5 py-1 pr-2 pl-2.5 text-[11.5px] pointer-coarse:min-h-11`}
            />
          ) : null}
          {canRefreshPlugin ? (
            <button
              type="button"
              data-engine-quota-refresh={engineId}
              disabled={isRefreshingPlugin}
              aria-label={t('usage.quota.refresh')}
              title={t('usage.quota.refresh')}
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
              disabled={isRefreshingNative || isNativeLocked}
              aria-label={t('usage.quota.refresh')}
              title={isNativeLocked ? t('usage.quota.refreshAfter', { seconds: nativeSecondsLeft }) : t('usage.quota.refresh')}
              onClick={() => { void runNativeRefresh(); }}
              className={ICON_BUTTON}
            >
              <Icon name="refresh" size={14} className={isRefreshingNative ? 'animate-spin' : undefined} />
              {isNativeLocked ? <span className="font-mono text-[10.5px]">{nativeSecondsLeft}s</span> : null}
            </button>
          ) : null}
        </div>
      </div>

      {!isPluginMode ? (
        source.supported ? (
          <div className="space-y-2" data-engine-native-quota={engineId} data-engine-quota-status={nativeUnqueried ? 'unqueried' : source.status}>
            {source.meters.length > 0 ? (
              <div className="space-y-2" data-engine-native-meters={engineId}>
                {source.meters.map((meter) => <QuotaMeterRow key={meter.id} meter={meter} sourceStatus={source.status} />)}
              </div>
            ) : nativeUnqueried ? (
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-soft" data-engine-quota-unqueried={engineId}>
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
              <p className={`text-[12px] ${source.status === 'error' ? 'text-danger' : 'text-ink-soft'}`}>
                {source.message ?? source.reason ?? t(source.status === 'ready' || source.status === 'stale' ? 'st.quota.none' : 'usage.quota.status.unknown')}
              </p>
            )}
            {source.message && source.meters.length > 0 ? <p className="text-[11.5px] text-ink-soft">{source.message}</p> : null}
            <FeedbackLine feedback={feedback} />
          </div>
        ) : (
          <div className="space-y-1" data-engine-quota-status="unsupported">
            <p className="text-[11.5px] text-ink-faint">
              {t(q(matchingPluginSources.length > 0 ? 'usage.quota.engines.nativeUnsupportedWithPlugin' : 'usage.quota.engines.nativeUnsupported'))}
            </p>
            <FeedbackLine feedback={feedback} />
          </div>
        )
      ) : (
        <div className="space-y-2" data-engine-plugin-quota={engineId} data-engine-quota-status={pStatus}>
          {pStatus === 'missing' ? (
            <p className="text-[12px] text-danger" data-engine-quota-error={engineId}>
              {t(q('usage.quota.engines.pluginMissing'), { source: selectedSourceId })}
            </p>
          ) : pStatus === 'error' ? (
            <p className="text-[12px] text-danger" data-engine-quota-error={engineId}>
              {pluginError ?? selectedPluginSnapshot?.error ?? pluginCatalogError}
            </p>
          ) : pStatus === 'unqueried' ? (
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-soft" data-engine-quota-unqueried={engineId}>
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
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-amber-ink" data-engine-quota-expired={engineId}>
              <span data-engine-quota-read-at={selectedPluginSnapshot?.readAt} title={selectedPluginSnapshot?.readAt}>
                {t(q('usage.quota.engines.pluginExpired'), {
                  time: selectedPluginSnapshot?.readAt ? time.relativeTime(selectedPluginSnapshot.readAt) : '',
                })}
              </span>
              <span aria-hidden className="text-ink-faint">·</span>
              <button
                type="button"
                data-engine-quota-query={engineId}
                disabled={isRefreshingPlugin}
                onClick={() => { void runPluginRefresh(); }}
                className="font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink disabled:opacity-50"
              >
                {t('usage.quota.refresh')}
              </button>
            </div>
          ) : accountGroups.length === 0 ? (
            <p className="text-[12px] text-ink-soft" data-engine-quota-empty={engineId}>
              {t(q('usage.quota.engines.pluginEmpty'))}
            </p>
          ) : (
            <div className="divide-y divide-hairline/60" data-engine-plugin-readings={engineId}>
              {accountGroups.map((group) => (
                <div key={group.accountId} data-quota-account={group.accountId} className="space-y-1.5 py-2 first:pt-0.5 last:pb-0.5">
                  <div className="flex flex-wrap items-baseline gap-1.5 text-[11.5px]">
                    <span className="font-medium text-ink">{group.accountLabel}</span>
                    {group.showAccountId ? (
                      <span className="font-mono text-[10.5px] text-ink-faint">{group.accountId}</span>
                    ) : null}
                  </div>
                  <div className="space-y-2">
                    {group.readings.map((reading, index) => (
                      <PluginQuotaBucketRow
                        key={`${reading.pool ?? 'default'}:${reading.window ?? ''}:${index}`}
                        reading={reading}
                        snapshotReadAt={selectedPluginSnapshot?.readAt}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <FeedbackLine feedback={feedback} />
        </div>
      )}
    </li>
  );
}

function PluginQuotaBucketRow({ reading, snapshotReadAt }: {
  readonly reading: HarnessQuotaReading;
  readonly snapshotReadAt: string | undefined;
}) {
  const { t, time } = useI18n();
  const [modelsOpen, setModelsOpen] = useState(false);
  const val = formatHarnessQuotaReading(reading);
  const models = reading.modelIds ?? [];
  const singleModelAsLabel = reading.pool === undefined && models.length === 1;
  const poolLabel = reading.pool ?? (singleModelAsLabel ? models[0]! : t(q('usage.quota.engines.defaultPool')));
  const inlineModels = !singleModelAsLabel && models.length > 0 && models.length <= 2;
  const foldModels = models.length > 2;
  const distinctReadAt = reading.readAt !== undefined && reading.readAt !== snapshotReadAt ? reading.readAt : undefined;
  const barTone = val.kind === 'known' && val.remainingPercent !== undefined
    ? quotaBarTone(val.remainingPercent)
    : undefined;
  const low = val.kind === 'known' && val.remainingPercent !== undefined && quotaIsLow(val.remainingPercent);

  return (
    <div
      className="space-y-1 text-[12px]"
      data-quota-bucket={reading.pool ?? 'default'}
      data-quota-window={reading.window ?? ''}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-1.5">
          <span className="truncate text-ink-soft">{poolLabel}</span>
          {reading.window ? (
            <span className="shrink-0 rounded bg-ink/[0.06] px-1.5 py-px font-mono text-[10px] text-ink-soft" data-bucket-window>
              {reading.window}
            </span>
          ) : null}
          {inlineModels ? (
            <span className="font-mono text-[10.5px] text-ink-faint" data-reading-models-inline>
              {models.join(' · ')}
            </span>
          ) : null}
          {foldModels ? (
            <button
              type="button"
              data-reading-models-toggle
              aria-expanded={modelsOpen}
              onClick={() => { setModelsOpen((prev) => !prev); }}
              className="inline-flex items-center gap-1 rounded bg-ink/[0.05] px-1.5 py-px font-mono text-[10px] text-ink-soft transition-colors hover:bg-ink/[0.09] hover:text-ink"
            >
              <DisclosureChevron open={modelsOpen} />
              <span>{t(q('usage.quota.engines.modelsCount'), { count: models.length })}</span>
            </button>
          ) : null}
        </div>

        <div className="flex shrink-0 items-baseline gap-2">
          {val.kind === 'unknown' ? (
            <span className="text-[11.5px] text-ink-faint tabular-nums" data-reading-state="unknown">
              {t('usage.quota.status.unknown')}
            </span>
          ) : (
            <span
              className={`text-[11.5px] tabular-nums ${val.exhausted ? 'font-medium text-danger' : 'text-ink'}`}
              data-reading-state={val.exhausted ? 'exhausted' : 'available'}
            >
              {t('usage.quota.value.remaining', { value: val.value })}
            </span>
          )}
          {reading.resetAt ? (
            <span className="text-[10.5px] text-ink-faint" title={reading.resetAt}>
              {t('usage.quota.resets', { time: time.timeUntil(reading.resetAt) })}
            </span>
          ) : null}
          {distinctReadAt ? (
            <span className="text-[10.5px] text-ink-faint tabular-nums" data-reading-read-at={distinctReadAt} title={distinctReadAt}>
              {t(q('usage.quota.engines.readAt'), { time: time.relativeTime(distinctReadAt) })}
            </span>
          ) : null}
        </div>
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

      {val.kind === 'known' && val.remainingPercent !== undefined && barTone !== undefined ? (
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-ink/[0.07]" data-bucket-progress>
          <div
            className={`h-full rounded-full transition-all duration-300 ${barTone}`}
            style={{ width: `${val.remainingPercent}%` }}
          />
        </div>
      ) : null}
      {low ? <p data-quota-low className="text-[11px] font-medium text-attention">{t('usage.quota.low')}</p> : null}
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
    <details data-quota-unsupported={sources.length} open={open} onToggle={(event) => { setOpen(event.currentTarget.open); }}
      className="rounded-lg border border-hairline">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[12.5px] text-ink-soft hover:text-ink [&::-webkit-details-marker]:hidden">
        <DisclosureChevron open={open} />
        <span>{t(q('usage.quota.unsupported.summary'), { n: sources.length })}</span>
      </summary>
      <div className="border-t border-hairline px-3 pt-2 pb-3">
        <p className="mb-1.5 text-[11.5px] text-ink-faint">{t(q('usage.quota.unsupported.note'))}</p>
        <ul className="grid gap-x-6 sm:grid-cols-2">
          {ordered.map((source) => (
            <li key={source.id} data-quota-unsupported-item={source.id} className="flex min-w-0 items-center gap-2 py-0.5">
              <span className="min-w-0 truncate font-mono text-[12px] text-ink" title={source.label}>{source.label}</span>
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
    <details data-quota-off={sources.length} open={open} onToggle={(event) => { setOpen(event.currentTarget.open); }}
      className="rounded-lg border border-hairline">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[12.5px] text-ink-soft hover:text-ink [&::-webkit-details-marker]:hidden">
        <DisclosureChevron open={open} />
        <span>{t(q('usage.quota.off.summary'), { n: sources.length })}</span>
      </summary>
      <ul className="divide-y divide-hairline border-t border-hairline bg-panel">
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
    <li data-quota-off-item={source.id} className="px-3 py-1.5">
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

/**
 * Quota bars are read, not acted on, so they are ink. Under a tenth left the
 * bar takes the "needs you" colour and says so in words, since running out is
 * the one thing here that will stop work.
 */
function quotaIsLow(remainingPercent: number): boolean {
  return remainingPercent < 10;
}

function quotaBarTone(remainingPercent: number): string {
  return quotaIsLow(remainingPercent) ? 'bg-attention' : 'bg-ink-soft';
}

function QuotaMeterRow({ meter, sourceStatus }: { readonly meter: ProviderQuotaMeter; readonly sourceStatus: ProviderQuotaStatus }) {
  const { t, time } = useI18n();
  const periodLabel = meter.window?.label ?? formatWindowPeriod(meter.window?.duration_seconds);
  const status = meter.status ?? sourceStatus;
  const badge = statusBadgeInfo(status);
  const util = meterUtilization(meter);
  const remainingPercent = util === undefined ? undefined : 100 - Math.min(100, Math.max(0, util));
  const reading = meterValue(meter);
  const valueText = reading.kind === 'unknown'
    ? t('usage.quota.status.unknown')
    : reading.kind === 'balance'
      ? t('usage.quota.value.balance', { value: reading.value })
      : reading.kind === 'remaining'
        ? t('usage.quota.value.remaining', { value: reading.value })
        : reading.kind === 'spent' || reading.kind === 'used'
          ? t('usage.quota.value.used', { value: reading.value })
          : reading.value;
  const resetTime = meter.window?.reset_at;
  return (
    <div className="space-y-1 text-[12px]" data-quota-meter={meter.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-ink-soft">{meter.label}</span>
          {meter.scope === 'team' ? <span className="shrink-0 rounded bg-ink/[0.06] px-1 py-px font-mono text-[9.5px] text-ink-faint">Team</span> : null}
          {periodLabel ? <span className="shrink-0 rounded bg-ink/[0.05] px-1 py-px font-mono text-[10px] text-ink-faint">{periodLabel}</span> : null}
          {status !== 'ready' ? (
            <span className={`shrink-0 rounded border px-1 py-px text-[9.5px] font-medium ${badge.toneClass}`} data-meter-status={status}>{t(badge.labelKey as I18nKey)}</span>
          ) : null}
        </span>
        <span className=" flex shrink-0 items-baseline gap-2">
          <span className="text-[11.5px] text-ink tabular-nums">{valueText}</span>
          {resetTime ? <span className="text-[10.5px] text-ink-faint">{t('usage.quota.resets', { time: time.timeUntil(resetTime) })}</span> : null}
        </span>
      </div>
      {util !== undefined && remainingPercent !== undefined ? (
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.07]" data-quota-progress>
          <div className={`h-full rounded-full transition-all duration-300 ${quotaBarTone(remainingPercent)}`} style={{ width: `${Math.min(100, Math.max(0, util))}%` }} />
        </div>
      ) : null}
      {remainingPercent !== undefined && quotaIsLow(remainingPercent) ? (
        <p data-quota-low className="text-[11px] font-medium text-attention">{t('usage.quota.low')}</p>
      ) : null}
      {meter.message ? <p className="text-[11px] text-danger">{meter.message}</p> : null}
    </div>
  );
}
