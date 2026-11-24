import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ExecutorCatalogItem } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../../i18n';
import { compactIdentifier } from '../../../lib/compactIdentifier';
import {
  formatQuotaPercentNumber,
  formatQuotaResetDuration,
  groupHarnessQuotaReadings,
  isSourceLocked,
  pluginQuotaSnapshotStatus,
  quotaFuelTier,
  quotaSettingsHref,
  type HarnessQuotaActionDeclaration,
  type HarnessQuotaActionId,
  type HarnessQuotaAccountGroup,
  type PluginHarnessQuotaSnapshot,
  type ProviderQuotaSource,
} from '../../../lib/providerQuota';
import { FeedbackLine, type Feedback } from '../../controls';
import { DisclosureChevron, Icon } from '../../icons';
import { SearchableSelect } from '../../SearchableSelect';
import { engineHealth, engineQuotaSourceOf, type EngineHealth } from '../../settings/ExternalEnginesSection';
import { computeRemainingPace, summarizePoolHealth } from './quotaModel';
import { PluginAccountsMatrix, SingleAccountPluginRow } from './QuotaFleetMatrix';
import { QUOTA_ICON_BUTTON, QUOTA_ROW_GRID, QUOTA_SMALL_BUTTON } from './QuotaSourceRow';
import { QuotaWindowMeter } from './QuotaWindowMeter';

const ENGINE_HEALTH: Record<EngineHealth, { readonly key: I18nKey; readonly dot: string }> = {
  ready: { key: 'st.engines.statusReady', dot: 'bg-success' },
  warning: { key: 'st.engines.statusWarning', dot: 'bg-amber-ink' },
  missing: { key: 'st.engines.statusMissing', dot: 'bg-danger' },
  unknown: { key: 'st.engines.statusUnknown', dot: 'bg-ink/[0.25]' },
};

const ROW_LINK =
  'inline-flex h-7 shrink-0 items-center rounded px-1.5 text-[11.5px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:px-2.5';

export function EngineQuotaSection({
  engines,
  hidden,
  pending,
  catalog,
  configRaw,
  configError,
  onRetryConfig,
  pluginQuotaSources,
  pluginCatalogError,
  onRetryPluginCatalog,
  now,
  refreshingPluginIds,
  pluginErrors,
  pendingPluginActions,
  pluginActionFeedbacks,
  savingEngineSourceIds,
  refreshingNativeSourceId,
  activeRefreshSourceIds,
  sourceFeedbacks,
  onClearFeedback,
  onSelectQuotaSource,
  onRefreshPluginSource,
  onPerformPluginAction,
  onRefreshNativeSource,
  expandedEngineIds,
  onToggleEngineExpand,
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
  readonly pendingPluginActions?: ReadonlySet<string>;
  readonly pluginActionFeedbacks?: Readonly<Record<string, Feedback>>;
  readonly savingEngineSourceIds: ReadonlySet<string>;
  readonly refreshingNativeSourceId: string | undefined;
  readonly activeRefreshSourceIds: readonly string[];
  readonly sourceFeedbacks: Readonly<Record<string, Feedback>>;
  readonly onClearFeedback: (id: string) => void;
  readonly onSelectQuotaSource: (engineId: string, nextSourceId: string) => Promise<void>;
  readonly onRefreshPluginSource: (pluginSourceId: string) => Promise<void>;
  readonly onPerformPluginAction?: (pluginSourceId: string, action: HarnessQuotaActionId, accountId?: string) => Promise<void>;
  readonly onRefreshNativeSource: (sourceId: string) => Promise<unknown>;
  readonly expandedEngineIds?: ReadonlySet<string>;
  readonly onToggleEngineExpand?: (engineId: string) => void;
}) {
  const { t } = useI18n();
  if (pending || (!configError && pluginCatalogError === undefined && engines.length === 0 && hidden === 0)) return null;

  return (
    <section data-quota-engines>
      {configError ? (
        <div className="flex flex-wrap items-center gap-2 py-2.5" data-quota-engine-config-error>
          <FeedbackLine feedback={{ tone: 'error', text: t('usage.quota.engines.configError') }} />
          <button type="button" className={QUOTA_SMALL_BUTTON} onClick={onRetryConfig}>{t('st.im.retry')}</button>
        </div>
      ) : null}
      {pluginCatalogError !== undefined ? (
        <div className="flex flex-wrap items-center gap-2 py-2.5" data-quota-engine-plugin-error>
          <FeedbackLine feedback={{ tone: 'error', text: pluginCatalogError }} />
          <button type="button" data-quota-engine-plugin-retry className={QUOTA_SMALL_BUTTON} onClick={onRetryPluginCatalog}>{t('st.im.retry')}</button>
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
                pendingPluginActions={pendingPluginActions}
                pluginActionFeedback={selectedSourceId !== '' ? pluginActionFeedbacks?.[selectedSourceId] : undefined}
                isRefreshingNative={
                  refreshingNativeSourceId === source.id ||
                  source.refreshing ||
                  activeRefreshSourceIds.includes(source.id)
                }
                feedback={sourceFeedbacks[source.id]}
                onClearFeedback={() => onClearFeedback(source.id)}
                onSelectQuotaSource={(next) => onSelectQuotaSource(engineId, next)}
                onRefreshPluginSource={onRefreshPluginSource}
                onPerformPluginAction={onPerformPluginAction}
                onRefreshNativeSource={() => onRefreshNativeSource(source.id)}
                expanded={expandedEngineIds?.has(engineId)}
                onToggleExpand={onToggleEngineExpand ? () => onToggleEngineExpand(engineId) : undefined}
              />
            );
          })}
        </ul>
      ) : null}
      {hidden > 0 ? (
        <span className="sr-only" data-quota-hidden-engines={hidden}>
          {t('usage.quota.engines.hidden', { n: hidden })}
        </span>
      ) : null}
    </section>
  );
}

function EngineQuotaRow({
  source,
  health,
  selectedSourceId,
  matchingPluginSources,
  selectedPluginSnapshot,
  pluginCatalogError,
  now,
  savingSource,
  isRefreshingPlugin,
  pluginError,
  pendingPluginActions,
  pluginActionFeedback,
  isRefreshingNative,
  feedback: externalFeedback,
  onClearFeedback,
  onSelectQuotaSource,
  onRefreshPluginSource,
  onPerformPluginAction,
  onRefreshNativeSource,
  expanded: controlledExpanded,
  onToggleExpand,
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
  readonly pendingPluginActions?: ReadonlySet<string>;
  readonly pluginActionFeedback?: Feedback;
  readonly isRefreshingNative: boolean;
  readonly feedback: Feedback | undefined;
  readonly onClearFeedback: () => void;
  readonly onSelectQuotaSource: (nextSourceId: string) => Promise<void>;
  readonly onRefreshPluginSource: (pluginSourceId: string) => Promise<void>;
  readonly onPerformPluginAction?: (pluginSourceId: string, action: HarnessQuotaActionId, accountId?: string) => Promise<void>;
  readonly onRefreshNativeSource: () => Promise<unknown>;
  readonly expanded?: boolean;
  readonly onToggleExpand?: () => void;
}) {
  const { t, time, locale } = useI18n();
  const [localFeedback, setLocalFeedback] = useState<Feedback>(null);
  const [uncontrolledFleetOpen, setUncontrolledFleetOpen] = useState(false);
  const fleetOpen = controlledExpanded ?? uncontrolledFleetOpen;
  const toggleFleetOpen = () => {
    if (onToggleExpand !== undefined) {
      onToggleExpand();
    } else {
      setUncontrolledFleetOpen((prev) => !prev);
    }
  };
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
  const defaultPoolLabel = t('usage.quota.engines.defaultPool');
  const fleetHealth = useMemo(
    () => summarizePoolHealth(accountGroups, defaultPoolLabel, now),
    [accountGroups, defaultPoolLabel, now],
  );

  const feedback = localFeedback ?? pluginActionFeedback ?? externalFeedback ?? null;
  const declaredActions: readonly HarnessQuotaActionDeclaration[] = isPluginMode && selectedPluginSnapshot !== undefined && pStatus !== 'missing'
    ? (selectedPluginSnapshot.actions ?? [])
    : [];
  const poolActions = declaredActions.filter((action) => action.scope === 'pool');
  const accountActions = declaredActions.filter((action) => action.scope === 'account');
  const view = ENGINE_HEALTH[health];
  const hasQuotaControls = matchingPluginSources.length > 0 || selectedSourceId !== '' || source.supported;

  if (!hasQuotaControls) {
    return (
      <li
        data-quota-engine={engineId}
        data-engine-health={health}
        className="flex min-h-10 items-center justify-between gap-3 py-2.5"
      >
        <span className="flex min-w-0 items-center gap-2 text-[13px] font-[510] text-ink" title={engineId}>
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

  const pluginExpiredTooltip = pStatus === 'expired'
    ? `${t('usage.quota.engines.pluginExpired', {
        time: selectedPluginSnapshot?.readAt ? time.relativeTime(selectedPluginSnapshot.readAt) : '',
      })} · ${t('usage.quota.refresh')}`
    : undefined;
  const refreshTooltip = pluginExpiredTooltip
    ?? (headerReadAt
      ? `${t('usage.quota.refresh')} · ${t('usage.quota.engines.readAt', { time: time.relativeTime(headerReadAt) })}`
      : t('usage.quota.refresh'));
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
  const keepActionsVisible = isRefreshingPlugin || isRefreshingNative || isNativeLocked || pStatus === 'expired';

  return (
    <li
      tabIndex={-1}
      data-quota-engine={engineId}
      data-engine-health={health}
      data-engine-quota-mode={isPluginMode ? 'plugin' : 'native'}
      className="group space-y-2.5 py-3.5 outline-none focus-visible:ring-2 focus-visible:ring-selected-ink"
    >
      <div className={QUOTA_ROW_GRID}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${!isPluginMode && source.status === 'auth_required' ? 'bg-amber-rule' : view.dot}`}
              title={!isPluginMode && source.status === 'auth_required' ? t('usage.quota.status.auth_required') : t(view.key)}
            />
            <h3 className="truncate font-sans text-[13px] font-[510] text-ink" title={engineId}>
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
              onClick={toggleFleetOpen}
              className="mt-1 -ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 font-sans tracking-normal text-[11.5px] text-[var(--kiki-chart-label)] transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:px-2"
            >
              <DisclosureChevron open={fleetOpen} />
              <span className="tabular-nums">
                {t('usage.quota.fleetSeatsAvailable', { ready: fleetHealth.readySeats, total: fleetHealth.totalSeats })}
              </span>
            </button>
          ) : singleSeat !== undefined ? (
            <p className="mt-0.5 truncate text-[11.5px] text-ink-faint" title={singleSeat.accountLabel}>
              {compactIdentifier(singleSeat.accountLabel)}
            </p>
          ) : !isPluginMode && (source.account_label !== undefined || health === 'warning' || health === 'missing') ? (
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-ink-faint">
              {source.account_label !== undefined ? (
                <span className="min-w-0 truncate" title={source.account_label}>
                  {compactIdentifier(source.account_label)}
                </span>
              ) : null}
              {source.account_label !== undefined && (health === 'warning' || health === 'missing') && source.status !== 'auth_required' ? (
                <span aria-hidden>·</span>
              ) : null}
              {(health === 'warning' || health === 'missing') && source.status !== 'auth_required' ? (
                <Link to={quotaSettingsHref(source)} data-quota-engine-settings={engineId} className="shrink-0 text-ink-soft hover:text-ink hover:underline">
                  {t('usage.quota.action.settings')}
                </Link>
              ) : null}
            </p>
          ) : null}
        </div>

        <div className="min-w-0 max-md:col-span-2 max-md:order-3">
          {!isPluginMode ? (
            source.supported ? (
              <div className="space-y-2" data-engine-native-quota={engineId} data-engine-quota-status={nativeUnqueried ? 'unqueried' : source.status}>
                {source.meters.length > 0 ? (
                  <div
                    className={source.meters.length >= 4 ? 'grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2' : 'space-y-2.5'}
                    data-engine-native-meters={engineId}
                  >
                    {source.meters.map((meter) => (
                      <QuotaWindowMeter key={meter.id} meter={meter} sourceStatus={source.status} nowMs={now} />
                    ))}
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
                          className="font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-2"
                        >
                          {t('usage.quota.queryNow')}
                        </button>
                      </>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-0.5 text-[12px]">
                    <p className={source.status === 'error' ? 'text-danger' : source.status === 'auth_required' ? 'text-amber-ink' : 'text-ink-soft'}>
                      {source.message ?? source.reason ?? t(source.status === 'ready' || source.status === 'stale' ? 'st.quota.none' : 'usage.quota.status.unknown')}
                    </p>
                    {source.status === 'auth_required' ? (
                      <Link
                        to={quotaSettingsHref(source)}
                        data-quota-engine-auth-settings={engineId}
                        className="shrink-0 font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink"
                      >
                        {t('usage.quota.action.settings')}
                      </Link>
                    ) : null}
                  </div>
                )}
                {source.message && source.meters.length > 0 ? (
                  <p className={`text-[11.5px] ${source.status === 'auth_required' || source.status === 'stale' ? 'text-amber-ink' : 'text-ink-soft'}`}>
                    {source.message}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="py-0.5" data-engine-quota-status="unsupported">
                <p className="text-[11.5px] text-ink-faint">
                  {t(matchingPluginSources.length > 0 ? 'usage.quota.engines.nativeUnsupportedWithPlugin' : 'usage.quota.engines.nativeUnsupported')}
                </p>
              </div>
            )
          ) : (
            <div className="space-y-2" data-engine-plugin-quota={engineId} data-engine-quota-status={pStatus}>
              {pStatus === 'missing' ? (
                <p className="py-0.5 text-[12px] text-danger" data-engine-quota-error={engineId}>
                  {t('usage.quota.engines.pluginMissing', { source: selectedSourceId })}
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
                    className="font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-2"
                  >
                    {t('usage.quota.queryNow')}
                  </button>
                </div>
              ) : pStatus === 'expired' ? null : accountGroups.length === 0 ? (
                <p className="py-0.5 text-[12px] text-ink-soft" data-engine-quota-empty={engineId}>
                  {t('usage.quota.engines.pluginEmpty')}
                </p>
              ) : isMultiSeat ? (
                <FleetPoolSummaryRow
                  engineId={engineId}
                  pools={fleetHealth.pools}
                  expanded={fleetOpen}
                  nowMs={now}
                  onToggle={toggleFleetOpen}
                />
              ) : (
                <SingleAccountPluginRow
                  account={accountGroups[0]!}
                  snapshotReadAt={selectedPluginSnapshot?.readAt}
                  nowMs={now}
                  pluginSourceId={selectedPluginSnapshot?.id}
                  accountActions={accountActions}
                  pendingPluginActions={pendingPluginActions}
                  onPerformPluginAction={onPerformPluginAction}
                />
              )}
            </div>
          )}
          <FeedbackLine feedback={feedback} />
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1 max-md:order-2">
          {selectedPluginSnapshot !== undefined && onPerformPluginAction !== undefined && poolActions.map((action) => {
            const actionKey = `${selectedPluginSnapshot.id}\0${action.id}\0`;
            const isPending = pendingPluginActions?.has(actionKey) === true;
            return (
              <button
                key={action.id}
                type="button"
                data-quota-plugin-action={action.id}
                data-quota-plugin-source={selectedPluginSnapshot.id}
                disabled={isPending || isRefreshingPlugin}
                onClick={() => {
                  setLocalFeedback(null);
                  onClearFeedback();
                  void onPerformPluginAction(selectedPluginSnapshot.id, action.id);
                }}
                className="inline-flex h-7 shrink-0 items-center rounded-md border border-hairline bg-paper px-2 text-[11.5px] font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:h-auto pointer-coarse:min-h-11 pointer-coarse:px-2.5"
              >
                {action.label}
              </button>
            );
          })}
          {showSourceSelect ? (
            <SearchableSelect
              triggerData={{
                'data-engine-quota-source': engineId,
                'data-quota-engines-auto-note': 'true',
              }}
              ariaLabel={t('usage.quota.engines.sourceAria', { engine: source.label })}
              title={t('usage.quota.engines.autoScheduleNote')}
              value={selectedSourceId}
              disabled={savingSource}
              align="end"
              onChange={(next) => {
                setLocalFeedback(null);
                onClearFeedback();
                void onSelectQuotaSource(next);
              }}
              options={[
                { value: '', label: t('usage.quota.engines.sourceNative') },
                ...(selectedSourceId !== '' && !matchingPluginSources.some((entry) => entry.id === selectedSourceId)
                  ? [{ value: selectedSourceId, label: selectedPluginSnapshot?.label ?? selectedSourceId }]
                  : []),
                ...matchingPluginSources.map((entry) => ({ value: entry.id, label: entry.label })),
              ]}
              buttonClassName="flex h-7 max-w-[172px] items-center gap-1 rounded-md border-0 bg-transparent px-2 text-[11.5px] text-[var(--kiki-chart-muted)] transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:min-h-11"
            />
          ) : null}
          {canRefreshPlugin ? (
            <button
              type="button"
              data-engine-quota-refresh={engineId}
              data-engine-quota-expired={pStatus === 'expired' ? engineId : undefined}
              data-engine-quota-query={pStatus === 'expired' ? engineId : undefined}
              data-engine-quota-read-at={pStatus === 'expired' ? selectedPluginSnapshot?.readAt : headerReadAt}
              disabled={isRefreshingPlugin}
              aria-label={refreshTooltip}
              title={refreshTooltip}
              onClick={() => { void runPluginRefresh(); }}
              className={
                pStatus === 'expired'
                  ? 'relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-card/70 text-amber-ink transition-colors hover:bg-amber-rule/15 focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:h-11 pointer-coarse:w-11'
                  : `${QUOTA_ICON_BUTTON} transition-opacity ${keepActionsVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'}`
              }
            >
              <Icon name="refresh" size={14} className={isRefreshingPlugin ? 'animate-spin' : undefined} />
              {pStatus === 'expired' ? (
                <span aria-hidden className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-amber-rule" />
              ) : null}
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
              className={`${QUOTA_ICON_BUTTON} transition-opacity ${
                keepActionsVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
              }`}
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
          poolByKey={fleetHealth.poolByKey}
          snapshotReadAt={selectedPluginSnapshot?.readAt}
          nowMs={now}
          pluginSourceId={selectedPluginSnapshot?.id}
          accountActions={accountActions}
          pendingPluginActions={pendingPluginActions}
          onPerformPluginAction={onPerformPluginAction}
        />
      ) : null}
    </li>
  );
}

function FleetPoolSummaryRow({
  engineId,
  pools,
  expanded,
  nowMs,
  onToggle,
}: {
  readonly engineId: string;
  readonly pools: ReturnType<typeof summarizePoolHealth>['pools'];
  readonly expanded: boolean;
  readonly nowMs: number;
  readonly onToggle: () => void;
}) {
  const { t, locale } = useI18n();
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
      className={`grid w-full gap-x-5 gap-y-1.5 rounded-md py-1 text-left transition-colors hover:bg-ink/[0.025] focus-visible:outline-2 focus-visible:outline-selected-ink ${colsClass}`}
    >
      {pools.map((pool) => {
        const pct = pool.tightestPercent;
        const resetAtMs = pool.tightestResetAt ? Date.parse(pool.tightestResetAt) : Number.NaN;
        const pace = pct !== undefined && pool.durationSeconds !== undefined && Number.isFinite(resetAtMs)
          ? computeRemainingPace({
              remainingPercent: pct,
              durationSeconds: pool.durationSeconds,
              resetAtMs,
              nowMs,
            })
          : null;
        const tier = pct !== undefined ? quotaFuelTier(pct) : undefined;
        const isCritical =
          pool.allExhausted ||
          (pct !== undefined && (pct <= 15 || tier === 'critical')) ||
          pace?.state === 'depleting';
        const isWarn = !isCritical && (tier === 'low' || pace?.state === 'fast');
        const tone = pct === undefined
          ? 'text-[var(--kiki-chart-muted)]'
          : isCritical
            ? 'font-semibold text-[var(--kiki-chart-danger-text)]'
            : isWarn
              ? 'font-semibold text-[var(--kiki-chart-warn-text)]'
              : 'font-semibold text-ink';
        const dotColor = isCritical
          ? 'var(--kiki-chart-danger)'
          : isWarn
            ? 'var(--kiki-chart-3)'
            : undefined;
        const resetFull = formatQuotaResetDuration(pool.tightestResetAt, locale);
        return (
          <div
            key={pool.key}
            data-bucket-progress={pct !== undefined ? true : undefined}
            className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]"
          >
            <span className="inline-flex min-w-0 items-center gap-1.5 font-sans tracking-normal text-[11.5px] text-[var(--kiki-chart-label)]">
              {dotColor !== undefined ? (
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: dotColor }}
                />
              ) : null}
              <span className="truncate" title={pool.label}>{pool.label}</span>
              {pool.window ? <span className="shrink-0 text-[var(--kiki-chart-muted)]">· {pool.window}</span> : null}
            </span>
            <span className="inline-flex shrink-0 items-baseline gap-1.5 tabular-nums">
              <span className={`text-[12.5px] ${tone}`}>
                {pct !== undefined ? `${formatQuotaPercentNumber(pct)}%` : (pool.fallbackValue ?? t('usage.quota.status.unknown'))}
              </span>
              {pool.tightestResetShort !== undefined ? (
                <span
                  className="text-[11px] text-[var(--kiki-chart-muted)]"
                  title={resetFull ? t('usage.quota.stripReset', { time: resetFull }) : pool.tightestResetAt}
                >
                  {pool.tightestResetShort}
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
    </button>
  );
}
