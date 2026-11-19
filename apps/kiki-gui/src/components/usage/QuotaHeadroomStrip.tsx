import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import {
  formatWindowPeriod,
  meterRemainingPercent,
  meterValue,
  quotaFuelTier,
} from '../../lib/providerQuota';

interface HeadroomPill {
  readonly id: string;
  readonly label: string;
  readonly window?: string;
  readonly remainingText: string;
  readonly remainingPercent?: number;
  readonly exhausted: boolean;
  readonly resetAt?: string;
}

/**
 * Single-line quota headroom strip above the usage bar when active provider
 * meters exist. Degrades silently when the mock or server omits the route.
 */
export function QuotaHeadroomStrip({
  enabled,
  onOpenQuota,
}: {
  readonly enabled: boolean;
  readonly onOpenQuota: () => void;
}) {
  const { client, scopeId } = useConnection();
  const { t, time } = useI18n();
  const hasRoute = typeof client.getProviderQuotas === 'function';

  const quotaQuery = useQuery({
    queryKey: ['provider-quotas', scopeId],
    queryFn: () => client.getProviderQuotas(),
    enabled: enabled && hasRoute,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60_000,
  });

  const pills = useMemo<readonly HeadroomPill[]>(() => {
    const sources = quotaQuery.data?.sources ?? [];
    const collected: Array<HeadroomPill & { readonly pctSort: number; readonly windowDuration: number }> = [];
    for (const source of sources) {
      if (!source.enabled || !source.supported || source.meters.length === 0) continue;
      for (const meter of source.meters) {
        const reading = meterValue(meter);
        if (reading.kind === 'unknown') continue;
        const remainingPercent = meterRemainingPercent(meter);
        const exhausted =
          (remainingPercent !== undefined && remainingPercent <= 0) ||
          (meter.remaining !== null && meter.remaining <= 0);
        const windowLabel = meter.window?.label ?? formatWindowPeriod(meter.window?.duration_seconds);
        const remainingText =
          reading.kind === 'remaining' || reading.kind === 'balance'
            ? reading.value
            : remainingPercent !== undefined
              ? `${remainingPercent}%`
              : reading.value;
        const windowDuration =
          typeof meter.window?.duration_seconds === 'number' &&
          Number.isFinite(meter.window.duration_seconds) &&
          meter.window.duration_seconds > 0
            ? meter.window.duration_seconds
            : Number.POSITIVE_INFINITY;
        const pctSort = exhausted ? 0 : (remainingPercent ?? 100);
        collected.push({
          id: `${source.id}:${meter.id}`,
          label: source.label,
          window: windowLabel,
          remainingText,
          remainingPercent,
          exhausted,
          resetAt: meter.window?.reset_at,
          pctSort,
          windowDuration,
        });
      }
    }
    return collected
      .toSorted((left, right) => {
        if (left.pctSort !== right.pctSort) return left.pctSort - right.pctSort;
        return left.windowDuration - right.windowDuration;
      })
      .slice(0, 4);
  }, [quotaQuery.data]);

  if (pills.length === 0) return null;

  const nowMs = Date.now();

  return (
    <div
      data-usage-quota-strip
      aria-label={t('usage.quota.stripLabel')}
      className="flex flex-wrap items-center gap-2"
    >
      {pills.map((pill) => {
        const exhausted = pill.exhausted;
        const tier = pill.remainingPercent !== undefined ? quotaFuelTier(pill.remainingPercent) : 'healthy';
        const critical = exhausted || tier === 'critical';
        const warn = !critical && tier === 'low';
        const toneClass = critical
          ? 'border-danger/40 bg-danger/5 text-danger hover:border-danger/60'
          : warn
            ? 'border-amber-rule/50 bg-amber-card/70 text-amber-ink hover:border-amber-rule'
            : 'border-hairline bg-panel text-ink-soft hover:border-hairline-strong hover:text-ink';
        const dotClass = critical ? 'bg-danger' : warn ? 'bg-amber-rule' : 'bg-ink/45';
        const leftText = t('usage.quota.stripLeft', { value: pill.remainingText });
        const resetMs = pill.resetAt !== undefined ? Date.parse(pill.resetAt) : Number.NaN;
        const futureResetHint =
          Number.isFinite(resetMs) && resetMs > nowMs
            ? t('usage.quota.stripReset', { time: time.formatDuration(resetMs - nowMs) })
            : undefined;
        const ariaParts = [
          pill.window !== undefined ? `${pill.label} ${pill.window}` : pill.label,
          leftText,
          ...(futureResetHint !== undefined ? [futureResetHint] : []),
        ];
        return (
          <button
            key={pill.id}
            type="button"
            data-usage-quota-pill={pill.id}
            title={futureResetHint}
            aria-label={ariaParts.join(' · ')}
            onClick={onOpenQuota}
            className={`inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors focus-visible:outline-2 focus-visible:outline-selected-ink ${toneClass}`}
          >
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
            <span className="max-w-32 truncate font-medium text-ink">{pill.label}</span>
            {pill.window !== undefined ? (
              <span className="font-mono text-[10.5px] text-ink-faint">{pill.window}</span>
            ) : null}
            <span className="tabular-nums">{leftText}</span>
          </button>
        );
      })}
    </div>
  );
}
