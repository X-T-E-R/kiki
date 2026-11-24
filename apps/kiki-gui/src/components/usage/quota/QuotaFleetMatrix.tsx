import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { compactIdentifier } from '../../../lib/compactIdentifier';
import {
  formatHarnessQuotaReading,
  formatQuotaResetDuration,
  formatQuotaResetShort,
  quotaFuelTier,
  type HarnessQuotaActionDeclaration,
  type HarnessQuotaActionId,
  type HarnessQuotaAccountGroup,
  type HarnessQuotaReading,
} from '../../../lib/providerQuota';
import { DisclosureChevron } from '../../icons';
import { AnchoredPopover, usePopover } from '../../overlays/AnchoredPopover';
import { QuotaFuelMicroBar } from './QuotaArcGauge';
import {
  classifySeatHealth,
  computeRemainingPace,
  parseWindowDurationSeconds,
  readingPoolKey,
  resolveReadingPoolLabel,
  splitSeatIdentity,
  type FleetPoolBottleneckItem,
  type SeatHealthState,
} from './quotaModel';
import { QuotaPaceCaption } from './QuotaWindowMeter';

function columnSequenceSignature(readings: readonly HarnessQuotaReading[], defaultPoolLabel: string): string {
  return readings.map((reading) => readingPoolKey(reading, defaultPoolLabel)).join('|');
}

const SEAT_DOT_CLASS: Record<SeatHealthState, string> = {
  ready: 'bg-success',
  low: 'bg-amber-rule',
  skipped_exhausted: 'bg-[var(--kiki-gauge-tick)]',
  blocking_exhausted: 'bg-danger',
  partial_unknown: 'bg-[var(--kiki-gauge-tick)]',
  unknown: 'bg-[var(--kiki-gauge-tick)]',
};

function accountSeatDotClass(
  readings: readonly HarnessQuotaReading[],
  poolByKey: ReadonlyMap<string, FleetPoolBottleneckItem>,
  defaultPoolLabel: string,
): string {
  return SEAT_DOT_CLASS[classifySeatHealth(readings, poolByKey, defaultPoolLabel)];
}

export function SingleAccountPluginRow({
  account,
  snapshotReadAt,
  nowMs,
  pluginSourceId,
  accountActions,
  pendingPluginActions,
  onPerformPluginAction,
}: {
  readonly account: HarnessQuotaAccountGroup;
  readonly snapshotReadAt: string | undefined;
  readonly nowMs: number;
  readonly pluginSourceId?: string;
  readonly accountActions?: readonly HarnessQuotaActionDeclaration[];
  readonly pendingPluginActions?: ReadonlySet<string>;
  readonly onPerformPluginAction?: (pluginSourceId: string, action: HarnessQuotaActionId, accountId?: string) => Promise<void>;
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
    <div className="space-y-2">
      <div data-engine-plugin-readings data-quota-account={account.accountId} className={gridClass}>
        {account.readings.map((reading) => (
          <PluginQuotaBucketCell
            key={`${reading.pool ?? 'default'}:${reading.window ?? ''}:${reading.resetAt ?? ''}:${(reading.modelIds ?? []).join(',')}`}
            reading={reading}
            snapshotReadAt={snapshotReadAt}
            nowMs={nowMs}
            showPoolLabel="always"
            showModelDisclosure
            alignTrack={cols > 1}
            muteIfExhausted={false}
          />
        ))}
      </div>
      {pluginSourceId !== undefined && onPerformPluginAction !== undefined && accountActions !== undefined && accountActions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {accountActions.map((action) => {
            const actionKey = `${pluginSourceId}\0${action.id}\0${account.accountId}`;
            const isPending = pendingPluginActions?.has(actionKey) === true;
            return (
              <button
                key={action.id}
                type="button"
                data-quota-account-action={action.id}
                data-quota-account-action-target={account.accountId}
                data-quota-plugin-source={pluginSourceId}
                disabled={isPending}
                onClick={() => { void onPerformPluginAction(pluginSourceId, action.id, account.accountId); }}
                className="inline-flex h-6 shrink-0 items-center rounded border border-hairline bg-paper px-2 text-[11px] font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:h-auto pointer-coarse:min-h-11 pointer-coarse:px-2.5"
              >
                {action.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function PluginAccountsMatrix({
  engineId,
  accountGroups,
  poolByKey,
  snapshotReadAt,
  nowMs,
  pluginSourceId,
  accountActions,
  pendingPluginActions,
  onPerformPluginAction,
}: {
  readonly engineId: string;
  readonly accountGroups: readonly HarnessQuotaAccountGroup[];
  readonly poolByKey: ReadonlyMap<string, FleetPoolBottleneckItem>;
  readonly snapshotReadAt: string | undefined;
  readonly nowMs: number;
  readonly pluginSourceId?: string;
  readonly accountActions?: readonly HarnessQuotaActionDeclaration[];
  readonly pendingPluginActions?: ReadonlySet<string>;
  readonly onPerformPluginAction?: (pluginSourceId: string, action: HarnessQuotaActionId, accountId?: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const defaultPoolLabel = t('usage.quota.engines.defaultPool');
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

  const isLongFleet = accountGroups.length > 8;

  return (
    <div
      className={`border-t border-hairline/70 ${isLongFleet ? 'max-h-[26rem] overflow-y-auto pr-1' : 'pt-2'}`}
      data-engine-plugin-readings={engineId}
      data-quota-matrix-scroll={isLongFleet ? engineId : undefined}
    >
      {isUniformMatrix && firstGroup !== undefined ? (
        <div
          data-quota-matrix-header
          data-quota-matrix-sticky={isLongFleet ? 'true' : undefined}
          className={`hidden border-b border-hairline/70 md:grid md:grid-cols-[minmax(176px,216px)_minmax(0,1fr)] md:items-start md:gap-x-6 ${
            isLongFleet ? 'sticky top-0 z-10 bg-paper/95 py-2 backdrop-blur-[4px]' : 'pb-2'
          }`}
        >
          <span className="font-sans tracking-normal text-[11px] text-[var(--kiki-chart-muted)]">
            {t('usage.quota.summary.seats', { count: accountGroups.length })}
          </span>
          <div className={cellsGridClass}>
            {firstGroup.readings.map((reading, colIndex) => (
              <MatrixColumnHeader
                key={`${reading.pool ?? 'default'}:${reading.window ?? ''}:${(reading.modelIds ?? []).join(',')}`}
                reading={reading}
                showModelDisclosure={firstModelSigOccurrence.has(`0:${colIndex}`)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="divide-y divide-hairline/70">
        {accountGroups.map((group, groupIndex) => {
          const seatDot = accountSeatDotClass(group.readings, poolByKey, defaultPoolLabel);
          const seatIdentity = splitSeatIdentity(group.accountLabel, group.accountId, group.showAccountId);
          return (
            <div
              key={group.accountId}
              data-quota-account={group.accountId}
              className="grid grid-cols-1 gap-x-6 gap-y-2 py-2.5 last:pb-0.5 md:grid-cols-[minmax(176px,216px)_minmax(0,1fr)] md:items-center"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[12px]">
                  <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${seatDot}`} />
                  <span className="min-w-0 truncate font-medium text-ink" title={group.accountLabel}>
                    {compactIdentifier(seatIdentity.primary)}
                  </span>
                </div>
                {seatIdentity.secondary !== undefined ? (
                  <p className="mt-0.5 truncate pl-3.5 font-sans tracking-normal text-[11px] text-[var(--kiki-chart-muted)]" title={seatIdentity.secondary}>
                    {compactIdentifier(seatIdentity.secondary)}
                  </p>
                ) : null}
                {pluginSourceId !== undefined && onPerformPluginAction !== undefined && accountActions !== undefined && accountActions.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-3.5">
                    {accountActions.map((action) => {
                      const actionKey = `${pluginSourceId}\0${action.id}\0${group.accountId}`;
                      const isPending = pendingPluginActions?.has(actionKey) === true;
                      return (
                        <button
                          key={action.id}
                          type="button"
                          data-quota-account-action={action.id}
                          data-quota-account-action-target={group.accountId}
                          data-quota-plugin-source={pluginSourceId}
                          disabled={isPending}
                          onClick={() => { void onPerformPluginAction(pluginSourceId, action.id, group.accountId); }}
                          className="inline-flex h-6 shrink-0 items-center rounded border border-hairline bg-paper px-1.5 text-[10.5px] font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:h-auto pointer-coarse:min-h-11 pointer-coarse:px-2"
                        >
                          {action.label}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>

              <div className={cellsGridClass}>
                {group.readings.map((reading, readingIndex) => {
                  const hasFirstSig = firstModelSigOccurrence.has(`${groupIndex}:${readingIndex}`);
                  const modelDisclosureMode: 'always' | 'mobileOnly' | 'none' = !hasFirstSig
                    ? 'none'
                    : isUniformMatrix
                      ? 'mobileOnly'
                      : 'always';
                  const pool = poolByKey.get(readingPoolKey(reading, defaultPoolLabel));
                  return (
                    <PluginQuotaBucketCell
                      key={`${reading.pool ?? 'default'}:${reading.window ?? ''}:${reading.resetAt ?? ''}:${(reading.modelIds ?? []).join(',')}`}
                      reading={reading}
                      snapshotReadAt={snapshotReadAt}
                      nowMs={nowMs}
                      showPoolLabel={isUniformMatrix ? 'mobileOnly' : 'always'}
                      showModelDisclosure={modelDisclosureMode}
                      alignTrack={maxCols > 1}
                      muteIfExhausted={pool !== undefined && pool.usableSeatCount > 0}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
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
  const modelsPopover = usePopover();
  const models = reading.modelIds ?? [];
  const poolLabel = resolveReadingPoolLabel(reading, t('usage.quota.engines.defaultPool'));
  const foldModels = showModelDisclosure && models.length > 2;

  return (
    <div className="relative min-w-0 text-[11.5px]">
      <div className="flex items-center justify-between gap-1.5">
        <span className="min-w-0 truncate font-sans tracking-normal font-medium text-[var(--kiki-chart-label)]" title={poolLabel}>
          {poolLabel}
          {reading.window ? <span className="font-normal text-[var(--kiki-chart-muted)]"> · {reading.window}</span> : null}
        </span>
        {foldModels ? (
          <button
            type="button"
            data-reading-models-toggle
            {...modelsPopover.triggerProps}
            className="inline-flex shrink-0 items-center gap-0.5 rounded bg-ink/[0.04] px-1.5 py-px font-mono text-[10px] text-ink-faint transition-colors hover:bg-ink/[0.08] hover:text-ink"
          >
            <DisclosureChevron open={modelsPopover.open} />
            <span>{t('usage.quota.engines.modelsCount', { count: models.length })}</span>
          </button>
        ) : null}
      </div>
      {foldModels ? (
        <AnchoredPopover
          {...modelsPopover.popoverProps}
          label={poolLabel}
          align="end"
          widthClassName="w-64"
          className="max-h-40 !p-2"
          data={{ 'data-reading-models-list': '' }}
        >
          <div className="flex flex-col gap-1">
            {models.map((modelId) => (
              <span
                key={modelId}
                title={modelId}
                className="block max-w-full truncate rounded border border-hairline bg-paper px-1.5 py-0.5 font-mono text-[10px] text-ink-soft"
              >
                {modelId}
              </span>
            ))}
          </div>
        </AnchoredPopover>
      ) : null}
    </div>
  );
}

export function PluginQuotaBucketCell({
  reading,
  snapshotReadAt,
  nowMs,
  showPoolLabel,
  showModelDisclosure,
  alignTrack,
  muteIfExhausted,
}: {
  readonly reading: HarnessQuotaReading;
  readonly snapshotReadAt: string | undefined;
  readonly nowMs: number;
  readonly showPoolLabel: 'always' | 'mobileOnly';
  readonly showModelDisclosure: 'always' | 'mobileOnly' | 'none' | boolean;
  readonly alignTrack: boolean;
  readonly muteIfExhausted: boolean;
}) {
  const { t, locale } = useI18n();
  const [modelsOpen, setModelsOpen] = useState(false);
  const val = formatHarnessQuotaReading(reading);
  const models = reading.modelIds ?? [];
  const singleModelAsLabel = reading.pool === undefined && models.length === 1;
  const poolLabel = resolveReadingPoolLabel(reading, t('usage.quota.engines.defaultPool'));
  const disclosureMode = showModelDisclosure === true ? 'always' : showModelDisclosure === false ? 'none' : showModelDisclosure;
  const disclosureActive = disclosureMode !== 'none';
  const disclosureVisibilityClass = disclosureMode === 'mobileOnly' ? 'md:hidden' : undefined;
  const inlineModels = disclosureActive && !singleModelAsLabel && models.length > 0 && models.length <= 2;
  const foldModels = disclosureActive && models.length > 2;
  const distinctReadAt = reading.readAt !== undefined && reading.readAt !== snapshotReadAt ? reading.readAt : undefined;
  const remainingPct = val.kind === 'known' ? val.remainingPercent : undefined;
  const tier = remainingPct !== undefined ? quotaFuelTier(remainingPct) : undefined;
  const mutedSkipped = val.kind === 'known' && val.exhausted && muteIfExhausted;
  const resetShort = formatQuotaResetShort(reading.resetAt, nowMs);
  const resetFull = formatQuotaResetDuration(reading.resetAt, locale);

  const durationSeconds = parseWindowDurationSeconds(reading.window);
  const resetAtMs = reading.resetAt ? Date.parse(reading.resetAt) : Number.NaN;
  const pace = !mutedSkipped && remainingPct !== undefined && durationSeconds !== undefined && Number.isFinite(resetAtMs)
    ? computeRemainingPace({
        remainingPercent: remainingPct,
        durationSeconds,
        resetAtMs,
        nowMs,
      })
    : null;

  const valueTone =
    val.kind === 'unknown'
      ? 'text-[var(--kiki-chart-muted)]'
      : mutedSkipped
        ? 'text-[var(--kiki-chart-muted)]'
        : val.exhausted || (remainingPct !== undefined && remainingPct <= 5) || pace?.state === 'depleting'
          ? 'font-semibold text-ink'
          : 'font-medium text-ink';

  return (
    <div
      className="min-w-0 space-y-1 text-[12px]"
      data-quota-bucket={reading.pool ?? 'default'}
      data-quota-window={reading.window ?? ''}
      data-quota-low={tier === 'critical' && !mutedSkipped ? 'true' : undefined}
      data-reading-read-at={distinctReadAt}
      title={mutedSkipped ? t('usage.quota.seatExhaustedSkipped') : undefined}
    >
      <div className={`font-sans tracking-normal text-[11px] text-[var(--kiki-chart-label)] ${showPoolLabel === 'mobileOnly' ? 'md:hidden' : ''}`}>
        <span className="truncate" title={poolLabel}>{poolLabel}</span>
        {reading.window ? <span className="text-[var(--kiki-chart-muted)]" data-bucket-window> · {reading.window}</span> : null}
      </div>

      <div className="flex items-center gap-2.5">
        {remainingPct !== undefined ? (
          <QuotaFuelMicroBar
            remainingPercent={remainingPct}
            pace={pace}
            muted={mutedSkipped}
            width={64}
            dataAttr="data-bucket-progress"
          />
        ) : val.kind === 'unknown' || alignTrack ? (
          <QuotaFuelMicroBar unknown width={64} />
        ) : null}

        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 tabular-nums">
          {val.kind === 'unknown' ? (
            <span className="font-sans tracking-normal text-[12px] text-[var(--kiki-chart-muted)]" data-reading-state="unknown">
              {t('usage.quota.status.unknown')}
            </span>
          ) : (
            <span
              className={`text-[13px] ${valueTone}`}
              data-reading-state={val.exhausted ? 'exhausted' : 'available'}
            >
              {val.value}
            </span>
          )}
          {resetShort !== undefined && reading.resetAt ? (
            <span
              className="text-[11px] text-[var(--kiki-chart-muted)]"
              title={resetFull ? t('usage.quota.stripReset', { time: resetFull }) : reading.resetAt}
            >
              {resetShort}
            </span>
          ) : null}
        </div>
      </div>

      <QuotaPaceCaption pace={pace} />

      {inlineModels || foldModels ? (
        <div className={`flex flex-wrap items-center justify-between gap-2 pt-0.5 text-[10.5px] text-ink-faint ${disclosureVisibilityClass ?? ''}`}>
          {inlineModels ? (
            <span className="min-w-0 truncate font-mono text-[10px]" data-reading-models-inline title={models.join(' · ')}>
              {models.join(' · ')}
            </span>
          ) : <span />}
          {foldModels ? (
            <button
              type="button"
              data-reading-models-toggle={disclosureMode === 'mobileOnly' ? 'mobile' : 'inline'}
              aria-expanded={modelsOpen}
              onClick={() => { setModelsOpen((prev) => !prev); }}
              className="inline-flex shrink-0 items-center gap-0.5 rounded bg-ink/[0.04] px-1.5 py-px font-mono text-[10px] text-ink-soft transition-colors hover:bg-ink/[0.08] hover:text-ink"
            >
              <DisclosureChevron open={modelsOpen} />
              <span>{t('usage.quota.engines.modelsCount', { count: models.length })}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {foldModels && modelsOpen ? (
        <div
          className={`flex max-h-36 flex-wrap gap-1 overflow-y-auto pt-0.5 pr-0.5 ${disclosureVisibilityClass ?? ''}`}
          data-reading-models-list
        >
          {models.map((modelId) => (
            <span
              key={modelId}
              title={modelId}
              className="inline-block max-w-full truncate rounded border border-hairline bg-paper px-1.5 py-0.5 font-mono text-[10px] text-ink-soft"
            >
              {modelId}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
