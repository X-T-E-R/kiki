import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../../i18n';
import {
  compactQuotaMeterLabel,
  formatQuotaPercentNumber,
  formatQuotaResetDuration,
  formatQuotaResetShort,
  formatWindowPeriod,
  quotaFuelTier,
  statusBadgeInfo,
  type ProviderQuotaMeter,
  type ProviderQuotaStatus,
} from '../../../lib/providerQuota';
import { QuotaFuelMicroBar } from './QuotaArcGauge';
import {
  computeRemainingPace,
  formatPaceEta,
  meterPrimaryReading,
  normalizeMeterLabel,
  parseWindowDurationSeconds,
  type RemainingPace,
} from './quotaModel';

export function QuotaPaceCaption({ pace }: { readonly pace: RemainingPace | null | undefined }) {
  const { t, locale } = useI18n();
  if (pace === null || pace === undefined || pace.state === 'on_track') return null;
  const text = pace.state === 'depleting'
    ? t('usage.quota.pace.depleting', { eta: formatPaceEta(pace.etaSeconds, locale) })
    : t('usage.quota.pace.fast');
  return (
    <p
      data-quota-pace={pace.state}
      className={`font-sans tracking-normal text-[12px] leading-4 tabular-nums ${
        pace.state === 'depleting'
          ? 'text-[var(--kiki-chart-danger-text)]'
          : 'text-[var(--kiki-chart-warn-text)]'
      }`}
    >
      {text}
    </p>
  );
}

export function QuotaWindowMeter({
  meter,
  sourceStatus,
  nowMs = Date.now(),
  dialRepresented = false,
  swatchColor,
}: {
  readonly meter: ProviderQuotaMeter;
  readonly sourceStatus: ProviderQuotaStatus;
  readonly nowMs?: number;
  /** When true, the meter's ratio is already drawn on the parent QuotaCalibrationDial arc. */
  readonly dialRepresented?: boolean;
  readonly swatchColor?: string;
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
    ? 'text-[var(--kiki-chart-muted)]'
    : muted
      ? 'font-normal text-[var(--kiki-chart-label)]'
      : 'font-normal text-ink';

  const resetShort = formatQuotaResetShort(resetTime, nowMs);
  const resetFull = formatQuotaResetDuration(resetTime, locale);
  const pctRaw = display.remainingPercent !== undefined
    ? Math.max(0, Math.min(100, display.remainingPercent))
    : undefined;

  return (
    <div
      className="space-y-1 text-[12px] leading-4"
      data-quota-meter={meter.id}
      data-quota-low={tier === 'critical' ? 'true' : undefined}
      data-meter-detail={display.hoverDetail}
      title={display.hoverDetail ?? normalizedLabel.rawTitle}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {!dialRepresented && display.showBar && pctRaw !== undefined ? (
            <QuotaFuelMicroBar
              remainingPercent={pctRaw}
              pace={pace}
              muted={muted}
              width={72}
              dataAttr="data-quota-progress"
            />
          ) : !dialRepresented && display.unknown ? (
            <QuotaFuelMicroBar unknown width={72} />
          ) : dialRepresented && display.showBar && pctRaw !== undefined ? (
            <span
              data-quota-progress
              data-remaining-percent={formatQuotaPercentNumber(pctRaw)}
              className="inline-flex h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: swatchColor ?? 'var(--kiki-chart-1)' }}
            />
          ) : null}

          <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 font-sans tracking-normal">
            <span className="truncate text-[var(--kiki-chart-label)]" title={normalizedLabel.rawTitle ?? compactLabel}>
              {normalizedLabel.display}
            </span>
            {periodSuffix ? <span className="shrink-0 text-[var(--kiki-chart-muted)]">· {periodSuffix}</span> : null}
            {meter.scope === 'team' ? (
              <span className="shrink-0 text-[12px] leading-4 text-[var(--kiki-chart-muted)]">· {t('usage.quota.scope.team')}</span>
            ) : null}
            {status !== 'ready' ? (
              <span
                className={`shrink-0 rounded px-1 py-px text-[12px] leading-4 font-normal ${badge.toneClass}`}
                data-meter-status={status}
                title={t(badge.labelKey as I18nKey)}
              >
                {status === 'stale' ? '◷' : t(badge.labelKey as I18nKey)}
              </span>
            ) : null}
          </span>
        </div>

        <span className="flex shrink-0 items-baseline gap-x-2 tabular-nums">
          <span className={`text-[13px] leading-5 ${primaryTone}`}>{display.primaryText}</span>
          {display.secondaryText !== undefined ? (
            <span className="text-[12px] leading-4 text-[var(--kiki-chart-muted)]">{display.secondaryText}</span>
          ) : null}
          {resetShort !== undefined && resetTime ? (
            <span
              className="text-[12px] leading-4 text-[var(--kiki-chart-muted)]"
              title={resetFull ? t('usage.quota.stripReset', { time: resetFull }) : resetTime}
            >
              {resetShort}
            </span>
          ) : null}
        </span>
      </div>
      <QuotaPaceCaption pace={pace} />
      {meter.message ? <p className="font-sans tracking-normal text-[12px] leading-4 text-[var(--kiki-chart-danger-text)]">{meter.message}</p> : null}
    </div>
  );
}
