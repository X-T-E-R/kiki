import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { effectiveQuotaStatus, quotaLocalUsageHref, quotaSettingsHref } from '../../lib/providerQuota';
import { Icon } from '../icons';
import { OffQuotaSection, UnsupportedQuotaSection } from './quota/QuotaFoldSections';
import { buildQuotaOverviewPlan, QuotaOverviewDials } from './quota/QuotaOverviewDials';
import { EngineQuotaSection } from './quota/QuotaPoolRow';
import { AttentionQuotaRow, LedgerQuotaRow, QUOTA_SMALL_BUTTON } from './quota/QuotaSourceRow';
import { useQuotaPanelState } from './quota/useQuotaPanelState';

const ROW_LINK =
  'inline-flex h-7 shrink-0 items-center rounded px-1.5 text-[11.5px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:px-2.5';

export function ProviderQuotaPanel() {
  const { t, time } = useI18n();
  const state = useQuotaPanelState();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelWidth, setPanelWidth] = useState<number>(() => (
    typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth < 800
      ? window.innerWidth
      : 960
  ));
  const [expandedEngineIds, setExpandedEngineIds] = useState<ReadonlySet<string>>(() => new Set());
  const [focusWithinDials, setFocusWithinDials] = useState(false);
  const frozenDialIdsRef = useRef<readonly string[] | null>(null);

  useEffect(() => {
    const node = panelRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = (w: number) => {
      if (Number.isFinite(w) && w >= 240) {
        setPanelWidth(Math.round(w));
      }
    };
    measure(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) measure(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const toggleEngineExpand = useCallback((engineId: string) => {
    setExpandedEngineIds((prev) => {
      const next = new Set(prev);
      if (next.has(engineId)) {
        next.delete(engineId);
      } else {
        next.add(engineId);
      }
      return next;
    });
  }, []);

  const maxDials = panelWidth >= 800 ? 3 : 2;
  const defaultPoolLabel = t('usage.quota.engines.defaultPool');
  const unknownLabel = t('usage.quota.status.unknown');

  const overviewPlan = useMemo(
    () => buildQuotaOverviewPlan({
      ledgerSources: state.arranged.ledger,
      engineSources: state.arranged.engines,
      signedOut: state.signedOut,
      configRaw: state.configRaw,
      pluginQuotaSources: state.pluginQuotaSources,
      pluginErrors: state.pluginErrors,
      pluginCatalogError: state.pluginCatalogError,
      defaultPoolLabel,
      unknownLabel,
      nowMs: state.now,
      maxDials,
      frozenCandidateIds: focusWithinDials ? frozenDialIdsRef.current : null,
    }),
    [
      defaultPoolLabel,
      focusWithinDials,
      maxDials,
      state.arranged.engines,
      state.arranged.ledger,
      state.configRaw,
      state.now,
      state.pluginCatalogError,
      state.pluginErrors,
      state.pluginQuotaSources,
      state.signedOut,
      unknownLabel,
    ],
  );

  useEffect(() => {
    if (!focusWithinDials) {
      frozenDialIdsRef.current = overviewPlan.dials.map((d) => d.candidateId);
    }
  }, [focusWithinDials, overviewPlan.dials]);

  const asOfTime = state.snapshot?.generated_at;
  const refreshAllTitle = asOfTime
    ? `${t('usage.quota.refreshAll')} · ${t('usage.quota.asOf', { time: time.relativeTime(asOfTime) })}`
    : t('usage.quota.refreshAll');

  const hasDialsOrLedger =
    overviewPlan.dials.length > 0 || overviewPlan.remainingLedgerSources.length > 0;
  const hasExternalServices = state.arranged.externalServices.length > 0;

  return (
    <div ref={panelRef} className="@container/quotas space-y-4" data-provider-quota-panel>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {state.stale ? (
          <button
            type="button"
            data-quota-stale
            aria-label={`${t('usage.governance.stale', { time: asOfTime ? time.relativeTime(asOfTime) : '' })} · ${t('usage.execution.retryRefresh')}`}
            title={`${t('usage.governance.stale', { time: asOfTime ? time.relativeTime(asOfTime) : '' })} · ${t('usage.execution.retryRefresh')}`}
            onClick={() => { void state.refetch(); }}
            disabled={state.isRefetching}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--kiki-chart-warn-text)] transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          >
            <Icon name="refresh" size={14} className={state.isRefetching ? 'animate-spin' : undefined} />
          </button>
        ) : null}
        {state.showEngineSection ? (
          <Link to="/settings/ai#st-card-engines" data-quota-engines-manage className={ROW_LINK}>
            {t('usage.quota.engines.manage')}
          </Link>
        ) : null}
        <button
          type="button"
          data-quota-refresh-button
          data-quota-as-of={asOfTime}
          title={refreshAllTitle}
          onClick={() => void state.handleHeaderRefresh()}
          disabled={state.loading || state.isRefetching || state.refreshingAll}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-hairline bg-paper px-2.5 py-1 text-[12px] font-normal text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:min-h-11"
        >
          <Icon name="refresh" size={14} className={state.isRefetching || state.refreshingAll ? 'animate-spin' : undefined} />
          {t(state.isRefetching || state.refreshingAll ? 'usage.quota.refreshing' : 'usage.quota.refreshAll')}
        </button>
      </div>

      {state.loading ? (
        <div role="status" className="flex items-center gap-2 py-8 text-[13px] text-ink-faint">
          <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />{t('usage.loading')}
        </div>
      ) : state.isError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-[var(--kiki-chart-danger)] bg-danger/[0.05] pl-4 pr-3 py-3 text-[12.5px] text-[var(--kiki-chart-danger-text)]" data-quota-snapshot-error>
          <p className="font-normal">{t('usage.quota.status.error')}</p>
          <button type="button" data-quota-snapshot-retry className={QUOTA_SMALL_BUTTON} onClick={() => { void state.refetch(); }}>
            {t('st.im.retry')}
          </button>
        </div>
      ) : (
        <>
          {state.arranged.live.length === 0 && !state.showEngineSection ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-y border-hairline py-6 text-[13px] text-ink-faint" data-quota-empty>
              <div>
                <p className="font-normal text-ink-soft">{t('usage.quota.emptyTitle')}</p>
                <p className="mt-0.5 text-[12px] text-ink-faint">{t('usage.quota.emptyBody')}</p>
              </div>
              <Link to="/settings/ai?tab=providers" data-quota-manage-connections className={ROW_LINK}>
                {t('usage.quota.action.manageConnections')}
              </Link>
            </div>
          ) : (
            <div className="space-y-4" data-quota-items>
              {state.arranged.attention.length > 0 ? (
                <section className="space-y-2.5" data-quota-attention>
                  {state.arranged.attention.map((source) => {
                    const provider = state.providerById(source.provider_id);
                    return (
                      <AttentionQuotaRow
                        key={source.id}
                        source={source}
                        status={effectiveQuotaStatus(source, state.signedOut)}
                        signedOut={source.kind === 'provider' && state.signedOut.has(source.provider_id)}
                        settingsHref={quotaSettingsHref(source, provider)}
                        localUsageHref={quotaLocalUsageHref(source, provider)}
                        isRefreshing={
                          state.refreshingSourceId === source.id ||
                          source.refreshing ||
                          state.activeRefreshSourceIds.includes(source.id)
                        }
                        feedback={state.sourceFeedbacks[source.id]}
                        onClearExternalFeedback={() => state.clearFeedback(source.id)}
                        onRefresh={() => state.refreshSource(source.id)}
                        onToggleEnabled={(enabled) => state.setSourceEnabled(source.id, enabled)}
                      />
                    );
                  })}
                </section>
              ) : null}

              {hasDialsOrLedger || state.showEngineSection || hasExternalServices ? (
                <div className="divide-y divide-hairline border-y border-hairline">
                  {hasDialsOrLedger ? (
                    <section className="divide-y divide-hairline" data-quota-ledger>
                      <QuotaOverviewDials
                        dials={overviewPlan.dials}
                        endangeredEngineOverflow={overviewPlan.endangeredEngineOverflow}
                        signedOut={state.signedOut}
                        providerById={state.providerById}
                        quotaSettingsHrefOf={(source, provider) => quotaSettingsHref(source, provider as ReturnType<typeof state.providerById>)}
                        quotaLocalUsageHrefOf={(source, provider) => quotaLocalUsageHref(source, provider as ReturnType<typeof state.providerById>)}
                        refreshingSourceId={state.refreshingSourceId}
                        activeRefreshSourceIds={state.activeRefreshSourceIds}
                        sourceFeedbacks={state.sourceFeedbacks}
                        onClearFeedback={state.clearFeedback}
                        onRefreshSource={state.refreshSource}
                        onToggleSourceEnabled={state.setSourceEnabled}
                        expandedEngineIds={expandedEngineIds}
                        onToggleEngineExpand={toggleEngineExpand}
                        onFocusWithinChange={setFocusWithinDials}
                        nowMs={state.now}
                      />

                      {overviewPlan.remainingLedgerSources.map((source) => {
                        const provider = state.providerById(source.provider_id);
                        return (
                          <LedgerQuotaRow
                            key={source.id}
                            source={source}
                            status={effectiveQuotaStatus(source, state.signedOut)}
                            signedOut={source.kind === 'provider' && state.signedOut.has(source.provider_id)}
                            settingsHref={quotaSettingsHref(source, provider)}
                            localUsageHref={quotaLocalUsageHref(source, provider)}
                            isRefreshing={
                              state.refreshingSourceId === source.id ||
                              source.refreshing ||
                              state.activeRefreshSourceIds.includes(source.id)
                            }
                            feedback={state.sourceFeedbacks[source.id]}
                            onClearExternalFeedback={() => state.clearFeedback(source.id)}
                            onRefresh={() => state.refreshSource(source.id)}
                            onToggleEnabled={(enabled) => state.setSourceEnabled(source.id, enabled)}
                          />
                        );
                      })}
                    </section>
                  ) : null}

                  <EngineQuotaSection
                    engines={state.arranged.engines}
                    hidden={state.arranged.hiddenEngines}
                    pending={state.arranged.enginesPending}
                    catalog={state.executorsQuery.data?.items}
                    configRaw={state.configRaw}
                    configError={state.configQuery.isError}
                    onRetryConfig={() => { void state.configQuery.refetch(); }}
                    pluginQuotaSources={state.pluginQuotaSources}
                    pluginCatalogError={state.pluginCatalogError}
                    onRetryPluginCatalog={() => { void state.harnessQuotaQuery.refetch(); }}
                    now={state.now}
                    refreshingPluginIds={state.refreshingPluginIds}
                    pluginErrors={state.pluginErrors}
                    pendingPluginActions={state.pendingPluginActions}
                    pluginActionFeedbacks={state.pluginActionFeedbacks}
                    savingEngineSourceIds={state.savingEngineSourceIds}
                    refreshingNativeSourceId={state.refreshingSourceId}
                    activeRefreshSourceIds={state.activeRefreshSourceIds}
                    sourceFeedbacks={state.sourceFeedbacks}
                    onClearFeedback={state.clearFeedback}
                    onSelectQuotaSource={state.handleSelectEngineQuotaSource}
                    onRefreshPluginSource={state.refreshPluginSource}
                    onPerformPluginAction={state.performPluginAction}
                    onRefreshNativeSource={state.refreshSource}
                    expandedEngineIds={expandedEngineIds}
                    onToggleEngineExpand={toggleEngineExpand}
                  />

                  {hasExternalServices ? (
                    <section className="divide-y divide-hairline" data-quota-external-services>
                      {state.arranged.externalServices.map((source) => {
                        const provider = state.providerById(source.provider_id);
                        return (
                          <LedgerQuotaRow
                            key={source.id}
                            source={source}
                            status={effectiveQuotaStatus(source, state.signedOut)}
                            signedOut={false}
                            settingsHref={quotaSettingsHref(source, provider)}
                            localUsageHref={quotaLocalUsageHref(source, provider)}
                            isRefreshing={
                              state.refreshingSourceId === source.id ||
                              source.refreshing ||
                              state.activeRefreshSourceIds.includes(source.id)
                            }
                            feedback={state.sourceFeedbacks[source.id]}
                            onClearExternalFeedback={() => state.clearFeedback(source.id)}
                            onRefresh={() => state.refreshSource(source.id)}
                            onToggleEnabled={(enabled) => state.setSourceEnabled(source.id, enabled)}
                          />
                        );
                      })}
                    </section>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}

          <div className="space-y-1 pt-1">
            <UnsupportedQuotaSection sources={state.arranged.unsupported} providerById={state.providerById} />
            <OffQuotaSection
              sources={state.arranged.off}
              providerById={state.providerById}
              onEnable={(id) => state.setSourceEnabled(id, true)}
            />
          </div>
        </>
      )}
    </div>
  );
}
