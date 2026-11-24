import { useState } from 'react';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../../i18n';
import {
  compactQuotaMeterLabel,
  effectiveQuotaStatus,
  formatQuotaPercentNumber,
  formatQuotaResetDuration,
  formatWindowPeriod,
  groupHarnessQuotaReadings,
  isSourceLocked,
  pluginQuotaSnapshotStatus,
  statusBadgeInfo,
  type PluginHarnessQuotaSnapshot,
  type ProviderQuotaMeter,
  type ProviderQuotaSource,
  type ProviderQuotaStatus,
} from '../../../lib/providerQuota';
import { FeedbackLine, type Feedback } from '../../controls';
import { DisclosureChevron, Icon } from '../../icons';
import { engineQuotaSourceOf } from '../../settings/ExternalEnginesSection';
import { QuotaCalibrationDial, QuotaMiniArc, resolveQuotaArcStroke } from './QuotaArcGauge';
import {
  computeRemainingPace,
  meterPrimaryReading,
  normalizeMeterLabel,
  parseWindowDurationSeconds,
  partitionPoolWindows,
  quotaConstraintBucketOf,
  summarizePoolHealth,
  type EvaluatedPoolWindow,
  type PartitionedPoolWindows,
  type QuotaConstraintBucket,
  type RemainingPace,
} from './quotaModel';
import {
  KindTag,
  QUOTA_ICON_BUTTON,
  RowActionsMenu,
  SourceAccountSubtitle,
} from './QuotaSourceRow';
import { QuotaPaceCaption, QuotaWindowMeter } from './QuotaWindowMeter';

export interface EvaluatedProviderMeter {
  readonly meter: ProviderQuotaMeter;
  readonly remainingPercent: number;
  readonly pace: RemainingPace | null;
  readonly constraintBucket: QuotaConstraintBucket;
  readonly primaryText: string;
  readonly secondaryText?: string;
}

export interface ProviderDialCandidate {
  readonly kind: 'provider';
  readonly candidateId: string;
  readonly source: ProviderQuotaSource;
  readonly status: ProviderQuotaStatus;
  readonly outerMeter: EvaluatedProviderMeter;
  readonly innerMeter?: EvaluatedProviderMeter;
  readonly worstBucket: QuotaConstraintBucket;
  readonly worstPercent: number;
}

export interface EnginePluginDialCandidate {
  readonly kind: 'engine-plugin';
  readonly candidateId: string;
  readonly source: ProviderQuotaSource;
  readonly engineId: string;
  readonly partition: PartitionedPoolWindows;
  readonly isMultiSeat: boolean;
  readonly readySeats: number;
  readonly totalSeats: number;
  readonly worstBucket: QuotaConstraintBucket;
  readonly worstPercent: number;
}

export interface EngineNativeDialCandidate {
  readonly kind: 'engine-native';
  readonly candidateId: string;
  readonly source: ProviderQuotaSource;
  readonly engineId: string;
  readonly outerMeter: EvaluatedProviderMeter;
  readonly innerMeter?: EvaluatedProviderMeter;
  readonly worstBucket: QuotaConstraintBucket;
  readonly worstPercent: number;
}

export type QuotaDialCandidate =
  | ProviderDialCandidate
  | EnginePluginDialCandidate
  | EngineNativeDialCandidate;

function evaluateSourceMeters(
  source: ProviderQuotaSource,
  status: ProviderQuotaStatus,
  unknownLabel: string,
  nowMs: number,
): readonly EvaluatedProviderMeter[] {
  const muted = status === 'stale' || status === 'error';
  const out: EvaluatedProviderMeter[] = [];

  for (const meter of source.meters) {
    const meterStatus = meter.status ?? status;
    if (meterStatus === 'error' || meterStatus === 'auth_required' || meterStatus === 'unsupported') {
      continue;
    }
    const display = meterPrimaryReading(meter, unknownLabel);
    if (!display.showBar || display.remainingPercent === undefined) continue;
    const pct = Math.max(0, Math.min(100, display.remainingPercent));
    const periodLabel = meter.window?.label ?? formatWindowPeriod(meter.window?.duration_seconds);
    const durationSeconds = parseWindowDurationSeconds(periodLabel, meter.window?.duration_seconds);
    const resetAtMs = meter.window?.reset_at ? Date.parse(meter.window.reset_at) : Number.NaN;
    const pace = !muted && meterStatus !== 'stale' && durationSeconds !== undefined && Number.isFinite(resetAtMs)
      ? computeRemainingPace({
          remainingPercent: pct,
          durationSeconds,
          resetAtMs,
          nowMs,
        })
      : null;
    out.push({
      meter,
      remainingPercent: pct,
      pace,
      constraintBucket: quotaConstraintBucketOf(pct, pace),
      primaryText: display.primaryText,
      secondaryText: display.secondaryText,
    });
  }

  return out.toSorted((a, b) => {
    if (a.constraintBucket !== b.constraintBucket) return a.constraintBucket - b.constraintBucket;
    if (a.remainingPercent !== b.remainingPercent) return a.remainingPercent - b.remainingPercent;
    return a.meter.id.localeCompare(b.meter.id);
  });
}

function compareDialCandidates(a: QuotaDialCandidate, b: QuotaDialCandidate): number {
  if (a.worstBucket !== b.worstBucket) return a.worstBucket - b.worstBucket;
  if (a.worstPercent !== b.worstPercent) return a.worstPercent - b.worstPercent;
  return a.candidateId.localeCompare(b.candidateId);
}

export interface QuotaOverviewPlan {
  readonly dials: readonly QuotaDialCandidate[];
  readonly endangeredEngineOverflow: readonly (EnginePluginDialCandidate | EngineNativeDialCandidate)[];
  readonly remainingLedgerSources: readonly ProviderQuotaSource[];
}

export function buildQuotaOverviewPlan(params: {
  readonly ledgerSources: readonly ProviderQuotaSource[];
  readonly engineSources: readonly ProviderQuotaSource[];
  readonly signedOut: ReadonlySet<string>;
  readonly configRaw: Readonly<Record<string, unknown>> | undefined;
  readonly pluginQuotaSources: readonly PluginHarnessQuotaSnapshot[];
  readonly pluginErrors: Readonly<Record<string, string>>;
  readonly pluginCatalogError: string | undefined;
  readonly defaultPoolLabel: string;
  readonly unknownLabel: string;
  readonly nowMs: number;
  readonly maxDials: number;
  readonly frozenCandidateIds?: readonly string[] | null;
}): QuotaOverviewPlan {
  const {
    ledgerSources,
    engineSources,
    signedOut,
    configRaw,
    pluginQuotaSources,
    pluginErrors,
    pluginCatalogError,
    defaultPoolLabel,
    unknownLabel,
    nowMs,
    maxDials,
    frozenCandidateIds,
  } = params;

  const candidates: QuotaDialCandidate[] = [];
  const providerRankBySourceId = new Map<string, { bucket: QuotaConstraintBucket; pct: number }>();

  for (const source of ledgerSources) {
    const status = effectiveQuotaStatus(source, signedOut);
    if (status !== 'ready' && status !== 'stale') continue;
    const ratioMeters = evaluateSourceMeters(source, status, unknownLabel, nowMs);
    if (ratioMeters.length === 0) continue;
    const outerMeter = ratioMeters[0]!;
    const innerMeter = ratioMeters[1];
    providerRankBySourceId.set(source.id, {
      bucket: outerMeter.constraintBucket,
      pct: outerMeter.remainingPercent,
    });
    candidates.push({
      kind: 'provider',
      candidateId: `provider:${source.id}`,
      source,
      status,
      outerMeter,
      innerMeter,
      worstBucket: outerMeter.constraintBucket,
      worstPercent: outerMeter.remainingPercent,
    });
  }

  for (const source of engineSources) {
    const engineId = source.provider_id;
    const selectedSourceId = engineQuotaSourceOf(configRaw, engineId);
    if (selectedSourceId !== '') {
      const snapshot = pluginQuotaSources.find((entry) => entry.id === selectedSourceId);
      const pStatus = pluginQuotaSnapshotStatus(
        snapshot,
        engineId,
        pluginErrors[selectedSourceId],
        nowMs,
        pluginCatalogError !== undefined,
      );
      if (pStatus !== 'ready' || snapshot === undefined || snapshot.readings === undefined) continue;
      const accountGroups = groupHarnessQuotaReadings(snapshot.readings);
      if (accountGroups.length === 0) continue;
      const fleetHealth = summarizePoolHealth(accountGroups, defaultPoolLabel, nowMs);
      const partition = partitionPoolWindows(fleetHealth.pools, nowMs);
      if (partition === null) continue;
      candidates.push({
        kind: 'engine-plugin',
        candidateId: `engine:${engineId}`,
        source,
        engineId,
        partition,
        isMultiSeat: accountGroups.length > 1,
        readySeats: fleetHealth.readySeats,
        totalSeats: fleetHealth.totalSeats,
        worstBucket: partition.worstBucket,
        worstPercent: partition.worstPercent,
      });
    } else if (source.supported && (source.status === 'ready' || source.status === 'stale')) {
      const ratioMeters = evaluateSourceMeters(source, source.status, unknownLabel, nowMs);
      if (ratioMeters.length === 0) continue;
      const outerMeter = ratioMeters[0]!;
      candidates.push({
        kind: 'engine-native',
        candidateId: `engine:${engineId}`,
        source,
        engineId,
        outerMeter,
        innerMeter: ratioMeters[1],
        worstBucket: outerMeter.constraintBucket,
        worstPercent: outerMeter.remainingPercent,
      });
    }
  }

  const naturalSorted = candidates.toSorted(compareDialCandidates);
  let orderedCandidates = naturalSorted;
  if (frozenCandidateIds && frozenCandidateIds.length > 0) {
    const byId = new Map(naturalSorted.map((c) => [c.candidateId, c]));
    const pinned: QuotaDialCandidate[] = [];
    const seen = new Set<string>();
    for (const id of frozenCandidateIds) {
      const found = byId.get(id);
      if (found) {
        pinned.push(found);
        seen.add(id);
      }
    }
    for (const item of naturalSorted) {
      if (!seen.has(item.candidateId)) pinned.push(item);
    }
    orderedCandidates = pinned;
  }

  const dials = orderedCandidates.slice(0, maxDials);
  const overflowCandidates = orderedCandidates.slice(maxDials);

  const dialProviderSourceIds = new Set(
    dials.filter((c): c is ProviderDialCandidate => c.kind === 'provider').map((c) => c.source.id),
  );

  const endangeredEngineOverflow = overflowCandidates.filter(
    (c): c is EnginePluginDialCandidate | EngineNativeDialCandidate =>
      (c.kind === 'engine-plugin' || c.kind === 'engine-native') && c.worstBucket < 3,
  );

  const remainingLedgerSources = ledgerSources
    .filter((source) => !dialProviderSourceIds.has(source.id))
    .toSorted((a, b) => {
      const rankA = providerRankBySourceId.get(a.id);
      const rankB = providerRankBySourceId.get(b.id);
      const endangeredA = rankA !== undefined && rankA.bucket < 3 ? rankA.bucket : 99;
      const endangeredB = rankB !== undefined && rankB.bucket < 3 ? rankB.bucket : 99;
      if (endangeredA !== endangeredB) return endangeredA - endangeredB;
      return 0;
    });

  return {
    dials,
    endangeredEngineOverflow,
    remainingLedgerSources,
  };
}

function PoolWindowLine({
  evaluated,
  swatchColor,
  ringRole,
}: {
  readonly evaluated: EvaluatedPoolWindow;
  readonly swatchColor: string;
  readonly ringRole: 'outer' | 'inner' | 'sibling';
}) {
  const { t, locale } = useI18n();
  const { pool, remainingPercent, pace } = evaluated;
  const resetFull = formatQuotaResetDuration(pool.tightestResetAt, locale);
  const displayPct = formatQuotaPercentNumber(remainingPercent);
  const isUrgent = pool.allExhausted || remainingPercent <= 5 || pace?.state === 'depleting';

  return (
    <div className="space-y-0.5 text-[12px]" data-quota-dial-window={pool.key} data-quota-dial-ring={ringRole}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 font-sans tracking-normal">
          <span
            aria-hidden
            className={ringRole === 'sibling' ? 'h-1.5 w-1.5 shrink-0 rounded-full border border-hairline-strong' : 'h-2 w-2 shrink-0 rounded-full'}
            style={ringRole === 'sibling' ? undefined : { backgroundColor: swatchColor }}
          />
          <span className="truncate text-[var(--kiki-chart-label)]" title={pool.label}>
            {pool.label}
          </span>
          {pool.window ? <span className="shrink-0 text-[var(--kiki-chart-muted)]">· {pool.window}</span> : null}
        </span>

        <span className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
          <span className={isUrgent ? 'font-semibold text-ink' : 'font-medium text-ink'}>{displayPct}%</span>
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
      <QuotaPaceCaption pace={pace} />
    </div>
  );
}

function ProviderDialCard({
  candidate,
  signedOut,
  settingsHref,
  localUsageHref,
  isRefreshing,
  feedback: externalFeedback,
  onClearExternalFeedback,
  onRefresh,
  onToggleEnabled,
  nowMs,
}: {
  readonly candidate: ProviderDialCandidate;
  readonly signedOut: boolean;
  readonly settingsHref: string;
  readonly localUsageHref?: string;
  readonly isRefreshing: boolean;
  readonly feedback?: Feedback;
  readonly onClearExternalFeedback?: () => void;
  readonly onRefresh: () => Promise<unknown>;
  readonly onToggleEnabled: (enabled: boolean) => Promise<unknown>;
  readonly nowMs: number;
}) {
  const { t, locale } = useI18n();
  const [localFeedback, setLocalFeedback] = useState<Feedback>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const { source, status, outerMeter, innerMeter } = candidate;
  const feedback = localFeedback ?? externalFeedback ?? null;
  const badge = statusBadgeInfo(status);
  const isLocked = isSourceLocked(source);
  const refreshAfterMs = source.refresh_after ? new Date(source.refresh_after).getTime() : 0;
  const secondsLeft = isLocked ? Math.ceil((refreshAfterMs - Date.now()) / 1000) : 0;
  const canRefresh = source.supported && source.enabled && !signedOut;
  const muted = status === 'stale';
  const keepActionsVisible = isRefreshing || isLocked || menuOpen;

  const runAction = async (action: () => Promise<unknown>) => {
    setLocalFeedback(null);
    onClearExternalFeedback?.();
    try { await action(); }
    catch (error) { setLocalFeedback({ tone: 'error', text: errorText(locale, error) }); }
  };

  const outerPeriod = outerMeter.meter.window?.label ?? formatWindowPeriod(outerMeter.meter.window?.duration_seconds);
  const { title: compactOuter } = compactQuotaMeterLabel(outerMeter.meter.label, outerPeriod);
  const normalizedOuter = normalizeMeterLabel(compactOuter, locale);

  const outerStroke = resolveQuotaArcStroke(outerMeter.remainingPercent, outerMeter.pace, muted, false);
  const innerStroke = innerMeter
    ? resolveQuotaArcStroke(innerMeter.remainingPercent, innerMeter.pace, muted, true)
    : undefined;

  const representedMeterIds = new Set<string>([
    outerMeter.meter.id,
    ...(innerMeter ? [innerMeter.meter.id] : []),
  ]);

  return (
    <section
      data-quota-item={source.id}
      data-quota-dial={source.id}
      className="group flex min-w-0 flex-col justify-between gap-3 py-2"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate font-sans tracking-normal text-[13px] font-[560] text-ink">
              {source.label}
            </h3>
            <KindTag kind={source.kind} />
            {status !== 'ready' ? (
              <span
                className="shrink-0 text-[11px] font-medium text-[var(--kiki-chart-warn-text)]"
                data-quota-status={status}
                title={[t(badge.labelKey as I18nKey), source.message, source.reason].filter(Boolean).join(' · ')}
              >
                {status === 'stale' ? '◷' : t(badge.labelKey as I18nKey)}
              </span>
            ) : (
              <span className="sr-only" data-quota-status={status}>{t(badge.labelKey as I18nKey)}</span>
            )}
          </div>
          <SourceAccountSubtitle source={source} settingsHref={settingsHref} />
        </div>

        <div
          className={`flex shrink-0 items-center gap-0.5 transition-opacity ${
            keepActionsVisible
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
          }`}
        >
          {canRefresh ? (
            <button
              type="button"
              data-quota-source-refresh={source.id}
              onClick={() => { void runAction(onRefresh); }}
              disabled={isRefreshing || isLocked}
              aria-label={t('usage.quota.refresh')}
              title={isLocked ? t('usage.quota.refreshAfter', { seconds: secondsLeft }) : t('usage.quota.refresh')}
              className={QUOTA_ICON_BUTTON}
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
            onOpenChange={setMenuOpen}
          />
        </div>
      </div>

      <div className="flex justify-center py-0.5">
        <QuotaCalibrationDial
          outerPercent={outerMeter.remainingPercent}
          outerPace={outerMeter.pace}
          innerPercent={innerMeter?.remainingPercent}
          innerPace={innerMeter?.pace}
          muted={muted}
          ariaLabel={`${source.label}: ${formatQuotaPercentNumber(outerMeter.remainingPercent)}%`}
          centerContent={(() => {
            const m = outerMeter.meter;
            const outerDisplayPct = formatQuotaPercentNumber(outerMeter.remainingPercent);
            if (m.unit === 'money' && m.remaining !== null && innerMeter === undefined) {
              const cur = (m.currency ?? m.unit_label ?? '').toUpperCase();
              const amt = Number.isInteger(m.remaining) ? m.remaining.toFixed(0) : m.remaining.toFixed(2);
              const headline = cur === 'USD' ? `$${amt}` : cur ? `${amt} ${cur}` : amt;
              return (
                <>
                  <span className="max-w-[96px] truncate font-display text-[19px] leading-tight font-semibold tracking-tight tabular-nums text-ink">
                    {headline}
                  </span>
                  <span className="mt-0.5 max-w-[92px] truncate font-sans tracking-normal text-[10.5px] text-[var(--kiki-chart-label)] tabular-nums">
                    {outerDisplayPct}% · {normalizedOuter.display}
                  </span>
                </>
              );
            }
            return (
              <>
                <span className="font-display text-[20px] leading-tight font-semibold tracking-tight tabular-nums text-ink">
                  {`${outerDisplayPct}%`}
                </span>
                <span className="mt-0.5 max-w-[92px] truncate font-sans tracking-normal text-[10.5px] text-[var(--kiki-chart-label)]">
                  {normalizedOuter.display}
                </span>
              </>
            );
          })()}
        />
      </div>

      <div className="space-y-1.5">
        {source.meters.map((meter) => {
          const isOuter = meter.id === outerMeter.meter.id;
          const isInner = innerMeter !== undefined && meter.id === innerMeter.meter.id;
          return (
            <QuotaWindowMeter
              key={meter.id}
              meter={meter}
              sourceStatus={status}
              nowMs={nowMs}
              dialRepresented={representedMeterIds.has(meter.id)}
              swatchColor={isOuter ? outerStroke : isInner ? innerStroke : undefined}
            />
          );
        })}
        {status !== 'stale' && source.message ? <p className="font-sans tracking-normal text-[11.5px] text-[var(--kiki-chart-label)]">{source.message}</p> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </section>
  );
}

function EnginePluginDialCard({
  candidate,
  expanded,
  onToggleExpand,
}: {
  readonly candidate: EnginePluginDialCandidate;
  readonly expanded: boolean;
  readonly onToggleExpand: () => void;
}) {
  const { t } = useI18n();
  const { source, engineId, partition, isMultiSeat, readySeats, totalSeats } = candidate;
  const { outerWindow, innerWindow, siblingWindows, unmeasuredPools } = partition;

  const outerStroke = resolveQuotaArcStroke(outerWindow.remainingPercent, outerWindow.pace, false, false);
  const innerStroke = innerWindow
    ? resolveQuotaArcStroke(innerWindow.remainingPercent, innerWindow.pace, false, true)
    : undefined;

  const dotClass =
    candidate.worstBucket <= 1
      ? 'bg-[var(--kiki-chart-danger)]'
      : candidate.worstBucket === 2
        ? 'bg-[var(--kiki-chart-3)]'
        : 'bg-success';

  return (
    <div
      data-quota-dial={`engine:${engineId}`}
      className="flex min-w-0 flex-col justify-between gap-3 py-2"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
            <h3 className="truncate font-sans tracking-normal text-[13px] font-[560] text-ink">
              {source.label}
            </h3>
          </div>
        </div>

        {isMultiSeat ? (
          <button
            type="button"
            data-quota-dial-expand={engineId}
            aria-expanded={expanded}
            onClick={onToggleExpand}
            className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md px-2 py-0.5 font-sans tracking-normal text-[11.5px] text-[var(--kiki-chart-label)] transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
          >
            <DisclosureChevron open={expanded} />
            <span className="tabular-nums">
              {t('usage.quota.fleetSeatsAvailable', { ready: readySeats, total: totalSeats })}
            </span>
          </button>
        ) : null}
      </div>

      <div className="flex justify-center py-0.5">
        <QuotaCalibrationDial
          outerPercent={outerWindow.remainingPercent}
          outerPace={outerWindow.pace}
          innerPercent={innerWindow?.remainingPercent}
          innerPace={innerWindow?.pace}
          ariaLabel={`${source.label}: ${outerWindow.pool.label} ${formatQuotaPercentNumber(outerWindow.remainingPercent)}%`}
          centerContent={isMultiSeat ? (
            <>
              <span className="font-display text-[22px] leading-tight font-semibold tracking-tight tabular-nums text-ink">
                {readySeats}/{totalSeats}
              </span>
              <span className="mt-0.5 font-sans tracking-normal text-[10.5px] text-[var(--kiki-chart-label)]">
                {t('usage.quota.fleetSeatsLabel')}
              </span>
            </>
          ) : (
            <>
              <span className="font-display text-[20px] leading-tight font-semibold tracking-tight tabular-nums text-ink">
                {formatQuotaPercentNumber(outerWindow.remainingPercent)}%
              </span>
              <span className="mt-0.5 max-w-[92px] truncate font-sans tracking-normal text-[10.5px] text-[var(--kiki-chart-label)]">
                {outerWindow.pool.label}
              </span>
            </>
          )}
        />
      </div>

      <div className="space-y-1.5">
        <PoolWindowLine evaluated={outerWindow} swatchColor={outerStroke} ringRole="outer" />
        {innerWindow !== undefined && innerStroke !== undefined ? (
          <PoolWindowLine evaluated={innerWindow} swatchColor={innerStroke} ringRole="inner" />
        ) : null}
        {siblingWindows.map((sib) => (
          <PoolWindowLine key={sib.pool.key} evaluated={sib} swatchColor="var(--kiki-chart-muted)" ringRole="sibling" />
        ))}
        {unmeasuredPools.map((pool) => (
          <div key={pool.key} className="flex items-baseline justify-between gap-2 text-[11.5px]">
            <span className="truncate font-sans tracking-normal text-[var(--kiki-chart-label)]">
              {pool.label}
              {pool.window ? <span className="text-[var(--kiki-chart-muted)]"> · {pool.window}</span> : null}
            </span>
            <span className="tabular-nums text-[var(--kiki-chart-muted)]">
              {pool.fallbackValue ?? t('usage.quota.status.unknown')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EngineNativeDialCard({
  candidate,
  nowMs,
}: {
  readonly candidate: EngineNativeDialCandidate;
  readonly nowMs: number;
}) {
  const { locale } = useI18n();
  const { source, engineId, outerMeter, innerMeter } = candidate;
  const muted = source.status === 'stale';
  const outerPeriod = outerMeter.meter.window?.label ?? formatWindowPeriod(outerMeter.meter.window?.duration_seconds);
  const { title: compactOuter } = compactQuotaMeterLabel(outerMeter.meter.label, outerPeriod);
  const normalizedOuter = normalizeMeterLabel(compactOuter, locale);
  const outerStroke = resolveQuotaArcStroke(outerMeter.remainingPercent, outerMeter.pace, muted, false);
  const innerStroke = innerMeter
    ? resolveQuotaArcStroke(innerMeter.remainingPercent, innerMeter.pace, muted, true)
    : undefined;
  const representedIds = new Set<string>([outerMeter.meter.id, ...(innerMeter ? [innerMeter.meter.id] : [])]);

  const dotClass =
    candidate.worstBucket <= 1
      ? 'bg-[var(--kiki-chart-danger)]'
      : candidate.worstBucket === 2
        ? 'bg-[var(--kiki-chart-3)]'
        : 'bg-success';

  return (
    <div
      data-quota-dial={`engine:${engineId}`}
      className="flex min-w-0 flex-col justify-between gap-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
        <h3 className="truncate font-sans tracking-normal text-[13px] font-[560] text-ink">
          {source.label}
        </h3>
      </div>

      <div className="flex justify-center py-0.5">
        <QuotaCalibrationDial
          outerPercent={outerMeter.remainingPercent}
          outerPace={outerMeter.pace}
          innerPercent={innerMeter?.remainingPercent}
          innerPace={innerMeter?.pace}
          muted={muted}
          ariaLabel={`${source.label}: ${formatQuotaPercentNumber(outerMeter.remainingPercent)}%`}
          centerContent={(
            <>
              <span className="font-display text-[20px] leading-tight font-semibold tracking-tight tabular-nums text-ink">
                {formatQuotaPercentNumber(outerMeter.remainingPercent)}%
              </span>
              <span className="mt-0.5 max-w-[92px] truncate font-sans tracking-normal text-[10.5px] text-[var(--kiki-chart-label)]">
                {normalizedOuter.display}
              </span>
            </>
          )}
        />
      </div>

      <div className="space-y-1.5">
        {source.meters.map((meter) => {
          const isOuter = meter.id === outerMeter.meter.id;
          const isInner = innerMeter !== undefined && meter.id === innerMeter.meter.id;
          return (
            <QuotaWindowMeter
              key={meter.id}
              meter={meter}
              sourceStatus={source.status}
              nowMs={nowMs}
              dialRepresented={representedIds.has(meter.id)}
              swatchColor={isOuter ? outerStroke : isInner ? innerStroke : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

export function QuotaOverviewDials({
  dials,
  endangeredEngineOverflow,
  signedOut,
  providerById,
  quotaSettingsHrefOf,
  quotaLocalUsageHrefOf,
  refreshingSourceId,
  activeRefreshSourceIds,
  sourceFeedbacks,
  onClearFeedback,
  onRefreshSource,
  onToggleSourceEnabled,
  expandedEngineIds,
  onToggleEngineExpand,
  onFocusWithinChange,
  nowMs,
}: {
  readonly dials: readonly QuotaDialCandidate[];
  readonly endangeredEngineOverflow: readonly (EnginePluginDialCandidate | EngineNativeDialCandidate)[];
  readonly signedOut: ReadonlySet<string>;
  readonly providerById: (id: string) => unknown;
  readonly quotaSettingsHrefOf: (source: ProviderQuotaSource, provider: unknown) => string;
  readonly quotaLocalUsageHrefOf: (source: ProviderQuotaSource, provider: unknown) => string | undefined;
  readonly refreshingSourceId: string | undefined;
  readonly activeRefreshSourceIds: readonly string[];
  readonly sourceFeedbacks: Readonly<Record<string, Feedback>>;
  readonly onClearFeedback: (id: string) => void;
  readonly onRefreshSource: (id: string) => Promise<unknown>;
  readonly onToggleSourceEnabled: (id: string, enabled: boolean) => Promise<unknown>;
  readonly expandedEngineIds: ReadonlySet<string>;
  readonly onToggleEngineExpand: (engineId: string) => void;
  readonly onFocusWithinChange: (inside: boolean) => void;
  readonly nowMs: number;
}) {
  if (dials.length === 0) return null;

  const gridColsClass =
    dials.length === 1
      ? 'grid-cols-1 max-w-[380px]'
      : dials.length === 2
        ? 'grid-cols-1 sm:grid-cols-2 sm:divide-x sm:divide-hairline/70'
        : 'grid-cols-1 sm:grid-cols-2 @min-[800px]/quotas:grid-cols-3 @min-[800px]/quotas:divide-x @min-[800px]/quotas:divide-hairline/70';

  return (
    <div
      data-quota-overview-dials
      onFocusCapture={() => { onFocusWithinChange(true); }}
      onBlurCapture={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next === null || !event.currentTarget.contains(next)) {
          onFocusWithinChange(false);
        }
      }}
      className="space-y-2.5 py-2 sm:space-y-3 sm:py-3"
    >
      <div className={`grid gap-y-3.5 sm:gap-y-5 ${gridColsClass}`}>
        {dials.map((candidate, index) => {
          const padClass = dials.length > 1
            ? index === 0
              ? 'sm:pr-6'
              : index === dials.length - 1
                ? 'sm:pl-6'
                : 'sm:px-6'
            : '';
          return (
            <div key={candidate.candidateId} className={`min-w-0 ${padClass}`}>
              {candidate.kind === 'provider' ? (() => {
                const provider = providerById(candidate.source.provider_id);
                return (
                  <ProviderDialCard
                    candidate={candidate}
                    signedOut={candidate.source.kind === 'provider' && signedOut.has(candidate.source.provider_id)}
                    settingsHref={quotaSettingsHrefOf(candidate.source, provider)}
                    localUsageHref={quotaLocalUsageHrefOf(candidate.source, provider)}
                    isRefreshing={
                      refreshingSourceId === candidate.source.id ||
                      candidate.source.refreshing ||
                      activeRefreshSourceIds.includes(candidate.source.id)
                    }
                    feedback={sourceFeedbacks[candidate.source.id]}
                    onClearExternalFeedback={() => onClearFeedback(candidate.source.id)}
                    onRefresh={() => onRefreshSource(candidate.source.id)}
                    onToggleEnabled={(enabled) => onToggleSourceEnabled(candidate.source.id, enabled)}
                    nowMs={nowMs}
                  />
                );
              })() : candidate.kind === 'engine-plugin' ? (
                <EnginePluginDialCard
                  candidate={candidate}
                  expanded={expandedEngineIds.has(candidate.engineId)}
                  onToggleExpand={() => onToggleEngineExpand(candidate.engineId)}
                />
              ) : (
                <EngineNativeDialCard candidate={candidate} nowMs={nowMs} />
              )}
            </div>
          );
        })}
      </div>

      {endangeredEngineOverflow.length > 0 ? (
        <div
          data-quota-endangered-overflow
          className="divide-y divide-hairline/70 border-t border-hairline/70 pt-2"
        >
          {endangeredEngineOverflow.map((item) => {
            const pct = item.kind === 'engine-plugin'
              ? item.partition.worstWindow.remainingPercent
              : item.outerMeter.remainingPercent;
            const pace = item.kind === 'engine-plugin'
              ? item.partition.worstWindow.pace
              : item.outerMeter.pace;
            const windowLabel = item.kind === 'engine-plugin'
              ? [item.partition.worstWindow.pool.label, item.partition.worstWindow.pool.window].filter(Boolean).join(' · ')
              : item.outerMeter.meter.label;
            const canExpandFleet = item.kind === 'engine-plugin' && item.isMultiSeat;
            const isExpanded = canExpandFleet && expandedEngineIds.has(item.engineId);
            const focusEngineRow = () => {
              if (canExpandFleet && !isExpanded) {
                onToggleEngineExpand(item.engineId);
              }
              if (typeof document !== 'undefined') {
                const rowEl = document.querySelector<HTMLElement>(`[data-quota-engine="${item.engineId}"]`);
                rowEl?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
                const focusTarget =
                  rowEl?.querySelector<HTMLElement>(
                    'button:not(:disabled), a[href], select:not(:disabled), [tabindex="0"]',
                  ) ?? rowEl;
                focusTarget?.focus?.({ preventScroll: true });
              }
            };
            return (
              <button
                key={item.candidateId}
                type="button"
                data-quota-endangered-item={item.engineId}
                aria-expanded={canExpandFleet ? isExpanded : undefined}
                onClick={focusEngineRow}
                className="flex min-h-11 w-full items-center justify-between gap-3 py-2 text-left transition-colors hover:bg-ink/[0.03] focus-visible:outline-2 focus-visible:outline-selected-ink"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <QuotaMiniArc remainingPercent={pct} pace={pace} size={32} />
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate font-sans tracking-normal text-[12.5px] font-[550] text-ink">
                        {item.source.label}
                      </span>
                      <span className="truncate font-sans tracking-normal text-[11.5px] text-[var(--kiki-chart-muted)]">
                        {windowLabel}
                      </span>
                    </div>
                    <QuotaPaceCaption pace={pace} />
                  </div>
                </div>
                <span className="shrink-0 font-display text-[13px] font-medium tabular-nums text-ink">
                  {formatQuotaPercentNumber(pct)}%
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
