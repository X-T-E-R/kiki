import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../../i18n';
import {
  compactQuotaMeterLabel,
  formatQuotaResetDuration,
  formatQuotaResetShort,
  formatWindowPeriod,
  quotaFuelTier,
  statusBadgeInfo,
  type ProviderQuotaMeter,
  type ProviderQuotaStatus,
} from '../../../lib/providerQuota';
import {
  computeRemainingPace,
  formatPaceEta,
  meterPrimaryReading,
  normalizeMeterLabel,
  parseWindowDurationSeconds,
  type RemainingPace,
} from './quotaModel';

/**
 * Unified 6px remaining-fuel bar with optional expected-pace tick (CodexBar-inspired, inverted to Remaining Fuel).
 */
export function QuotaFuelTrack({
  remainingPercent,
  pace,
  muted = false,
  dataAttr = 'data-quota-progress',
}: {
  readonly remainingPercent: number;
  readonly pace?: RemainingPace | null;
  readonly muted?: boolean;
  readonly dataAttr?: 'data-quota-progress' | 'data-bucket-progress';
}) {
  const pct = Math.max(0, Math.min(100, Math.round(remainingPercent)));
  const tier = quotaFuelTier(pct);

  let barTone = 'bg-ink/68';
  if (muted) {
    barTone = 'bg-ink/25';
  } else if (pct <= 5 || pace?.state === 'depleting') {
    barTone = 'bg-danger';
  } else if (tier === 'critical' || tier === 'low' || pace?.state === 'fast') {
    barTone = 'bg-amber-rule';
  }

  const containerProps = dataAttr === 'data-quota-progress'
    ? { 'data-quota-progress': true, 'data-remaining-percent': pct }
    : { 'data-bucket-progress': true };

  return (
    <div
      className="relative h-1.5 w-full rounded-full bg-ink/[0.07]"
      {...containerProps}
    >
      <div className="h-full w-full overflow-hidden rounded-full">
        <div
          className={`h-full rounded-full transition-all duration-200 ${barTone}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {pace !== null && pace !== undefined && !muted ? (
        <span
          aria-hidden
          data-quota-pace-tick
          className="pointer-events-none absolute top-1/2 h-2.5 w-[1.5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink/45"
          style={{ left: `${Math.max(2, Math.min(98, pace.expectedRemainingPct))}%` }}
        />
      ) : null}
    </div>
  );
}

export function QuotaPaceCaption({ pace }: { readonly pace: RemainingPace | null | undefined }) {
  const { t, locale } = useI18n();
  if (pace === null || pace === undefined || pace.state === 'on_track') return null;
  const text = pace.state === 'depleting'
    ? t('usage.quota.pace.depleting', { eta: formatPaceEta(pace.etaSeconds, locale) })
    : t('usage.quota.pace.fast');
  return (
    <p
      data-quota-pace={pace.state}
      className={`text-[11px] tabular-nums ${pace.state === 'depleting' ? 'text-danger' : 'text-amber-ink'}`}
    >
      {text}
    </p>
  );
}

export function QuotaWindowMeter({
  meter,
  sourceStatus,
  nowMs = Date.now(),
}: {
  readonly meter: ProviderQuotaMeter;
  readonly sourceStatus: ProviderQuotaStatus;
  readonly nowMs?: number;
}) {
  const { t, locale } = useI18n();
  const periodLabel = meter.window?.label ?? formatWindowPeriod(meter.window?.duration_seconds);
  const { title: compactLabel, periodSuffix } = compactQuotaMeterLabel(meter.label, periodLabel);
  const normalizedLabel = normalizeMeterLabel(compactLabel, locale);
  const status = meter.status ?? sourceStatus;
  const badge = statusBadgeInfo(status);
  const display = meterPrimaryReading(meter, t('usage.quota.status.unknown'));
  const tier = display.remainingPercent !== undefined ? quotaFuelTier(display.remainingPercent) : undefined;
  const muted = status === 'stale' || status === 'error';

  const durationSeconds = parseWindowDurationSeconds(periodLabel, meter.window?.duration_seconds);
  const resetTime = meter.window?.reset_at;
  const resetAtMs = resetTime ? Date.parse(resetTime) : Number.NaN;
  const pace = !muted && display.showBar && display.remainingPercent !== undefined && durationSeconds !== undefined && Number.isFinite(resetAtMs)
    ? computeRemainingPace({
        remainingPercent: display.remainingPercent,
        durationSeconds,
        resetAtMs,
        nowMs,
      })
    : null;

  const primaryTone = display.unknown
    ? 'text-ink-faint'
    : muted
      ? 'font-medium text-ink-soft'
      : display.exhausted || tier === 'critical' || pace?.state === 'depleting'
        ? 'font-medium text-danger'
        : tier === 'low' || pace?.state === 'fast'
          ? 'font-medium text-amber-ink'
          : 'font-medium text-ink';

  const resetShort = formatQuotaResetShort(resetTime, nowMs);
  const resetFull = formatQuotaResetDuration(resetTime, locale);

  return (
    <div
      className="space-y-1 text-[12px]"
      data-quota-meter={meter.id}
      data-quota-low={tier === 'critical' ? 'true' : undefined}
      data-meter-detail={display.hoverDetail}
      title={display.hoverDetail ?? normalizedLabel.rawTitle}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-ink-soft" title={normalizedLabel.rawTitle ?? compactLabel}>
            {normalizedLabel.display}
          </span>
          {periodSuffix ? <span className="shrink-0 text-ink-faint">· {periodSuffix}</span> : null}
          {meter.scope === 'team' ? (
            <span className="shrink-0 text-[11px] text-ink-faint">· {t('usage.quota.scope.team')}</span>
          ) : null}
          {status !== 'ready' ? (
            <span
              className={`shrink-0 rounded px-1 py-px text-[10px] font-medium ${badge.toneClass}`}
              data-meter-status={status}
              title={t(badge.labelKey as I18nKey)}
            >
              {status === 'stale' ? '◷' : t(badge.labelKey as I18nKey)}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-baseline gap-x-2 tabular-nums">
          <span className={`text-[12px] ${primaryTone}`}>{display.primaryText}</span>
          {display.secondaryText !== undefined ? (
            <span className="text-[11px] text-ink-faint">{display.secondaryText}</span>
          ) : null}
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
      {display.showBar && display.remainingPercent !== undefined ? (
        <QuotaFuelTrack remainingPercent={display.remainingPercent} pace={pace} muted={muted} />
      ) : null}
      <QuotaPaceCaption pace={pace} />
      {meter.message ? <p className="text-[11px] text-danger">{meter.message}</p> : null}
    </div>
  );
}
