/**
 * ContextMeter — the composer footer's mini context-usage gauge: a percentage
 * plus a thin bar, fed by the same state fields the right rail's meta section
 * reads. At or above CONTEXT_WARN_RATIO the meter turns amber and advertises
 * compaction; clicking it asks the parent to run /compact.
 */

import { useI18n } from '../i18n';

/** Usage fraction at which the meter warns and suggests compaction. */
export const CONTEXT_WARN_RATIO = 0.8;

/** Percentage (0-100, clamped) of the context window in use. */
export function contextUsagePercent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

export function contextUsageWarns(used: number, limit: number): boolean {
  return limit > 0 && used / limit >= CONTEXT_WARN_RATIO;
}

export function ContextMeter({
  used,
  limit,
  onCompact,
}: {
  used: number;
  limit: number;
  /** Requests a compaction (the session view's /compact action). */
  onCompact?: () => void;
}) {
  const { t, time } = useI18n();
  const percent = contextUsagePercent(used, limit);
  const warn = contextUsageWarns(used, limit);
  const label = t('context.meter', { percent });
  const title = warn
    ? t('context.meterWarnTitle', {
        used: time.formatTokens(used),
        limit: time.formatTokens(limit),
      })
    : t('context.meterTitle', {
        used: time.formatTokens(used),
        limit: time.formatTokens(limit),
      });
  return (
    <button
      type="button"
      data-context-meter
      onClick={onCompact}
      disabled={onCompact === undefined}
      title={title}
      aria-label={title}
      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 transition-colors ${
        warn
          ? 'border-amber-rule/50 bg-amber-card text-amber-ink hover:border-amber-rule'
          : 'border-hairline text-ink-faint hover:border-hairline-strong hover:text-ink-soft'
      } disabled:cursor-default`}
    >
      <span className="h-1 w-10 overflow-hidden rounded-full bg-hairline">
        <span
          className={`block h-full rounded-full ${warn ? 'bg-amber-rule' : 'bg-accent'}`}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="font-mono text-[9.5px]">{label}</span>
      {warn ? <span className="text-[9.5px] font-medium">{t('context.compactHint')}</span> : null}
    </button>
  );
}
