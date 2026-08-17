/**
 * ContextMeter — the composer footer's mini context-usage gauge. Clicking the
 * gauge opens a bounded detail popover; compaction is an explicit action inside
 * that panel rather than the meter's click side effect.
 */

import { useId, useState } from 'react';

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
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  const percent = contextUsagePercent(used, limit);
  const warn = contextUsageWarns(used, limit);
  const remaining = Math.max(0, limit - used);
  const label = t('context.meter', { percent });
  const title = t(warn ? 'context.meterWarnTitle' : 'context.meterTitle', {
    used: time.formatTokens(used),
    limit: time.formatTokens(limit),
  });
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        data-context-meter
        onClick={() => { setOpen((value) => !value); }}
        title={title}
        aria-label={title}
        aria-expanded={open}
        aria-controls={detailsId}
        className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 transition-colors ${
          warn
            ? 'border-amber-rule/50 bg-amber-card text-amber-ink hover:border-amber-rule'
            : 'border-hairline text-ink-faint hover:border-hairline-strong hover:text-ink-soft'
        }`}
      >
        <span className="h-1 w-10 overflow-hidden rounded-full bg-hairline">
          <span
            className={`block h-full rounded-full ${warn ? 'bg-amber-rule' : 'bg-accent'}`}
            style={{ width: `${percent}%` }}
          />
        </span>
        <span className="font-mono text-[9.5px]">{label}</span>
        {warn ? <span className="text-[9.5px] font-medium">{t('context.detailsHint')}</span> : null}
      </button>
      {open ? (
        <div
          id={detailsId}
          data-context-details
          role="dialog"
          aria-label={t('context.detailsTitle')}
          className="anim-enter absolute right-0 bottom-full z-30 mb-2 w-64 rounded-xl border border-hairline bg-panel p-3 shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)]"
        >
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[11px] font-semibold text-ink">{t('context.detailsTitle')}</p>
            <span className="font-mono text-[11px] text-ink-soft">{label}</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-hairline">
            <div
              className={`h-full rounded-full ${warn ? 'bg-amber-rule' : 'bg-accent'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <dl className="mt-3 space-y-1.5 text-[11px]">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-faint">{t('context.used')}</dt>
              <dd className="font-mono text-ink">{time.formatTokens(used)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-faint">{t('context.available')}</dt>
              <dd className="font-mono text-ink">{time.formatTokens(remaining)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-hairline pt-1.5">
              <dt className="text-ink-faint">{t('context.limit')}</dt>
              <dd className="font-mono text-ink">{time.formatTokens(limit)}</dd>
            </div>
          </dl>
          {onCompact !== undefined ? (
            <button
              type="button"
              data-context-compact
              onClick={() => {
                setOpen(false);
                onCompact();
              }}
              className="mt-3 w-full rounded-lg border border-amber-rule/50 bg-amber-card px-2.5 py-1.5 text-[11px] font-medium text-amber-ink transition-colors hover:border-amber-rule"
            >
              {t('context.compactAction')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
