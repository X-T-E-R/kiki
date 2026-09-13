/**
 * ContextMeter — the composer footer's mini context-usage gauge, rendered as a
 * ring (not a bar). Clicking the ring opens a bounded detail card; compaction
 * is an explicit action inside that card rather than the ring's click side
 * effect.
 *
 * The ring colors by threshold (mirrors liveagent's contextUsage levels):
 *   - < 50%  accent (normal)
 *   - ≥ 50%  amber (warn, and the minimum at which manual compaction is advised)
 *   - ≥ 80%  red (danger / over the keep-under threshold)
 *
 * The detail card keeps the two §9.5 semantics apart: a "Context window"
 * section (used / available / limit, right now) and a "This session —
 * cumulative" section (lifetime input / output / cache-read / cache-write
 * tokens + cost), plus a prefiltered deep link to the session on /usage.
 */

import { createContext, useContext, useId, useState, type ReactNode } from 'react';

import { Link } from 'react-router-dom';

import type { SessionUsage } from '@kiki/protocol';

import { formatCostUsd } from '@kiki/session-core/util';
import type { ContextBreakdown } from '@kiki/session-core/wire';
import { useI18n } from '../i18n';
import { usageSessionDeepLink } from '../lib/usageV2';

/** Usage fraction at which the meter warns (yellow) and compaction becomes available. */
export const CONTEXT_WARN_RATIO = 0.5;

/** Usage fraction at which the meter turns red (danger). */
export const CONTEXT_DANGER_RATIO = 0.8;

export type ContextUsageLevel = 'ok' | 'warn' | 'danger';

/** Percentage (0-100, clamped) of the context window in use. */
export function contextUsagePercent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

export function contextUsageWarns(used: number, limit: number): boolean {
  return limit > 0 && used / limit >= CONTEXT_WARN_RATIO;
}

export function contextUsageDanger(used: number, limit: number): boolean {
  return limit > 0 && used / limit >= CONTEXT_DANGER_RATIO;
}

export function contextUsageLevel(used: number, limit: number): ContextUsageLevel {
  if (contextUsageDanger(used, limit)) return 'danger';
  if (contextUsageWarns(used, limit)) return 'warn';
  return 'ok';
}

const LEVEL_STROKE: Record<ContextUsageLevel, string> = {
  ok: 'var(--color-accent)',
  warn: 'var(--color-amber-rule)',
  danger: 'var(--color-danger)',
};

const ContextBreakdownContext = createContext<ContextBreakdown | undefined>(undefined);

export function ContextBreakdownProvider({
  value,
  children,
}: {
  value: ContextBreakdown | undefined;
  children: ReactNode;
}) {
  return <ContextBreakdownContext.Provider value={value}>{children}</ContextBreakdownContext.Provider>;
}

/** One labeled token row inside the detail card. */
function TokenRow({ label, value, title }: { label: string; value: number; title: string }) {
  const { time } = useI18n();
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="font-mono text-ink tabular-nums" title={title}>
        {time.formatTokens(value)}
      </dd>
    </div>
  );
}

export function ContextMeter({
  used,
  limit,
  usage,
  sessionId,
  onCompact,
  placement = 'above',
}: {
  used: number;
  limit: number;
  /** Lifetime session usage (lifetime cumulative `session.usage`) for the detail card. */
  usage?: SessionUsage;
  /** Enables the prefetched deep link to this session on the /usage page (§9.5). */
  sessionId?: string;
  /** Requests a compaction (the session view's /compact action). */
  onCompact?: () => void;
  placement?: 'above' | 'below';
}) {
  const { t, time } = useI18n();
  const breakdown = useContext(ContextBreakdownContext);
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  const percent = contextUsagePercent(used, limit);
  const level = contextUsageLevel(used, limit);
  const warn = level !== 'ok';
  const remaining = Math.max(0, limit - used);
  const label = t('context.meter', { percent });
  const title = t(
    level === 'danger'
      ? 'context.meterDangerTitle'
      : warn
        ? 'context.meterWarnTitle'
        : 'context.meterTitle',
    { used: time.formatTokens(used), limit: time.formatTokens(limit) },
  );

  const usageTotal =
    usage === undefined
      ? undefined
      : usage.input_tokens +
        usage.output_tokens +
        usage.cache_read_tokens +
        usage.cache_creation_tokens;

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        data-context-meter
        data-context-level={level}
        onClick={() => { setOpen((value) => !value); }}
        title={title}
        aria-label={title}
        aria-expanded={open}
        aria-controls={detailsId}
        className={`flex items-center gap-1.5 rounded-full border py-0.5 pr-2 pl-1 transition-colors ${
          level === 'danger'
            ? 'border-danger/50 bg-danger/10 text-danger hover:border-danger'
            : warn
              ? 'border-amber-rule/50 bg-amber-card text-amber-ink hover:border-amber-rule'
              : 'border-hairline text-ink-faint hover:border-hairline-strong hover:text-ink-soft'
        }`}
      >
        <span aria-hidden className="relative flex h-6 w-6 items-center justify-center">
          <svg viewBox="0 0 24 24" className="h-6 w-6 -rotate-90">
            <circle
              cx="12"
              cy="12"
              r="9.5"
              fill="none"
              strokeWidth="2.25"
              stroke="var(--color-hairline)"
            />
            <circle
              cx="12"
              cy="12"
              r="9.5"
              fill="none"
              strokeWidth="2.25"
              strokeLinecap="round"
              pathLength="100"
              strokeDasharray="100"
              strokeDashoffset={100 - percent}
              stroke={LEVEL_STROKE[level]}
              className="transition-[stroke-dashoffset,stroke] duration-300"
            />
          </svg>
          <span className="absolute font-mono text-[7px] leading-none font-semibold tabular-nums">
            {percent}
          </span>
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
          className={`anim-enter absolute right-0 z-30 w-72 rounded-xl border border-hairline bg-panel p-3 shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)] ${
            placement === 'below' ? 'top-full mt-2' : 'bottom-full mb-2'
          }`}
        >
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[11px] font-semibold text-ink">{t('context.detailsTitle')}</p>
            <span className="font-mono text-[11px] text-ink-soft">{label}</span>
          </div>
          {/* §9.5 split: the ring answers "how much context is left right now";
              the cumulative block below answers "what has this session spent". */}
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <p className="text-[10.5px] font-medium text-ink-soft">{t('context.windowTitle')}</p>
            <span className="text-[9.5px] text-ink-faint">{t('context.windowHint')}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-3">
            <span aria-hidden className="relative flex h-10 w-10 shrink-0 items-center justify-center">
              <svg viewBox="0 0 24 24" className="h-10 w-10 -rotate-90">
                <circle
                  cx="12"
                  cy="12"
                  r="9.5"
                  fill="none"
                  strokeWidth="2.25"
                  stroke="var(--color-hairline)"
                />
                <circle
                  cx="12"
                  cy="12"
                  r="9.5"
                  fill="none"
                  strokeWidth="2.25"
                  strokeLinecap="round"
                  pathLength="100"
                  strokeDasharray="100"
                  strokeDashoffset={100 - percent}
                  stroke={LEVEL_STROKE[level]}
                  className="transition-[stroke-dashoffset,stroke] duration-300"
                />
              </svg>
              <span className="absolute font-mono text-[9px] leading-none font-semibold tabular-nums">
                {percent}
              </span>
            </span>
            <dl className="min-w-0 flex-1 space-y-1 text-[11px]">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-faint">{t('context.used')}</dt>
                <dd className="font-mono text-ink tabular-nums">{time.formatTokens(used)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-faint">{t('context.limit')}</dt>
                <dd className="font-mono text-ink tabular-nums">{time.formatTokens(limit)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-faint">{t('context.available')}</dt>
                <dd className="font-mono text-ink tabular-nums">{time.formatTokens(remaining)}</dd>
              </div>
            </dl>
          </div>

          {usage !== undefined ? (
            <dl
              data-context-usage
              className="mt-3 space-y-1.5 border-t border-hairline pt-2.5 text-[11px]"
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[10.5px] font-medium text-ink-soft">{t('context.sessionUsage')}</p>
                <span className="text-[9.5px] text-ink-faint">{t('context.sessionUsageHint')}</span>
              </div>
              <TokenRow label={t('usage.tokens.input')} value={usage.input_tokens} title={String(usage.input_tokens)} />
              <TokenRow label={t('usage.tokens.output')} value={usage.output_tokens} title={String(usage.output_tokens)} />
              <TokenRow label={t('usage.tokens.cacheRead')} value={usage.cache_read_tokens} title={String(usage.cache_read_tokens)} />
              <TokenRow label={t('usage.tokens.cacheWrite')} value={usage.cache_creation_tokens} title={String(usage.cache_creation_tokens)} />
              <div className="flex items-center justify-between gap-3 border-t border-hairline pt-1.5">
                <dt className="text-ink-faint">{t('usage.card.cost')}</dt>
                <dd className="font-mono text-ink tabular-nums">{formatCostUsd(usage.total_cost_usd)}</dd>
              </div>
              {usageTotal !== undefined ? (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-faint">{t('usage.card.tokens')}</dt>
                  <dd className="font-mono text-ink tabular-nums">{time.formatTokens(usageTotal)}</dd>
                </div>
              ) : null}
              {sessionId !== undefined ? (
                <Link
                  data-context-usage-link
                  to={usageSessionDeepLink(sessionId)}
                  onClick={() => { setOpen(false); }}
                  className="block pt-1 text-[10.5px] font-medium text-accent hover:underline"
                >
                  {t('context.viewInUsage')}
                </Link>
              ) : null}
            </dl>
          ) : null}

          {breakdown !== undefined ? (
            <div data-context-breakdown className="mt-3 border-t border-hairline pt-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[10.5px] font-medium text-ink-soft">{t('context.breakdownTitle')}</p>
                <span className="text-[9.5px] text-ink-faint">{t('context.breakdownEstimated')}</span>
              </div>
              <dl className="mt-2 space-y-1.5 text-[11px]">
                <TokenRow label={t('context.system')} value={breakdown.systemTokens} title={String(breakdown.systemTokens)} />
                <TokenRow label={t('context.tools')} value={breakdown.toolsTokens} title={String(breakdown.toolsTokens)} />
                <TokenRow label={t('context.messages')} value={breakdown.messagesTokens} title={String(breakdown.messagesTokens)} />
              </dl>
            </div>
          ) : null}

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