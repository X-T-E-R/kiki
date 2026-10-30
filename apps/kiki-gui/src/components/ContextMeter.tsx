/**
 * ContextMeter — the composer footer's mini context-usage gauge, rendered as a
 * ring (not a bar). Clicking the ring opens a bounded detail card; compaction
 * is an explicit action inside that card rather than the ring's click side
 * effect.
 *
 * When the server reports an automatic-compaction point, the ring colours
 * against that point (amber from 80% of it, red once it is reached) while the
 * percent keeps reading "share of the usable window". Without one (older
 * engines, external executors) it falls back to fixed window ratios:
 *   - < 50%  ink-soft (normal: nothing to do yet)
 *   - ≥ 50%  amber (warn, and the minimum at which manual compaction is advised)
 *   - ≥ 80%  red (danger / over the keep-under threshold)
 *
 * The detail card keeps the two §9.5 semantics apart: a "Context window"
 * section (the compaction track, or used / available / limit) and a "This session —
 * cumulative" section (lifetime input / output / cache-read / cache-write
 * tokens + cost), plus a prefiltered deep link to the session on /usage. When
 * the server could not read that usage, the cumulative section says so instead
 * of presenting the zero placeholder as a measurement.
 */

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { Link } from 'react-router-dom';

import type { SessionUsageError, UsageAccountingSnapshot } from '@kiki/protocol';

import { sessionActionErrorText } from '@kiki/session-core/commands';
import { formatCostUsd } from '@kiki/session-core/util';
import type { ContextBreakdown } from '@kiki/session-core/wire';
import { useI18n } from '../i18n';
import { compactUsageLevel } from '../lib/autoCompact';
import { pushToast } from '../lib/toasts';
import { usageSessionDeepLink } from '../lib/usageV2';
import { useCanonicalAgentUsage } from './agent-panel/useCanonicalAgentUsage';
import { useCanonicalSessionUsage } from './agent-panel/useCanonicalSessionUsage';
import { KnownSubtotalMarker } from './usage/usageShared';
import { ContextCompactSection, type ContextCompactSectionProps } from './ContextCompactSection';
import { COMPOSER_PANEL_END, useComposerPanelAnchor, usePopoverDismiss } from './ComposerControls';
import { ContextStrategySection, STRATEGY_LABEL_KEY } from './ContextStrategySection';
import { Icon } from './icons';
import { AnchoredPopover } from './overlays/AnchoredPopover';
import type { ContextStrategyHandle, ManualCompactStrategy } from './useContextStrategy';

/**
 * Compaction wiring for the detail card, when the server reports a point.
 * `used` and the configured window come from the meter's own props.
 */
export type ContextMeterAutoCompact = Omit<ContextCompactSectionProps, 'used' | 'windowTokens' | 'residentTokens'> & {
  /** The detail card opened: a chance to re-read the point from the server. */
  readonly onOpen?: () => void;
  /** Context-renewal strategy for this agent, when the engine reports one. */
  readonly strategy?: ContextStrategyHandle;
};

/**
 * What the serving engine has declared about manual compaction, when it has
 * answered at all. `available: false` replaces the card's compact action with
 * the reason (and adds it to the trigger's title); `undefined` — no answer,
 * as with the native engine — leaves the meter exactly as it always was.
 */
export interface ContextMeterCompactAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

/** Usage fraction at which the meter warns (yellow) and compaction becomes available. */
export const CONTEXT_WARN_RATIO = 0.5;

/** Usage fraction at which the meter turns red (danger). */
export const CONTEXT_DANGER_RATIO = 0.8;

export type ContextUsageLevel = 'ok' | 'warn' | 'danger';

/**
 * The detail card's cumulative rows. Structurally a subset of the session
 * record's `SessionUsage`, but fields may be nullable for canonical agent
 * projections: per-agent metrics can omit token kinds or pricing, and an
 * invented `$0.00` would read as free. Standalone unpriced usage keeps its
 * existing hidden cost row; canonical usage renders the unknown explicitly.
 */
export type ContextMeterUsage = {
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_creation_tokens: number | null;
  readonly total_cost_usd: number | null;
  readonly accounting?: UsageAccountingSnapshot;
};

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
  ok: 'var(--color-ink-soft)',
  warn: 'var(--color-amber-rule)',
  danger: 'var(--color-danger)',
};

const ContextBreakdownContext = createContext<ContextBreakdown | undefined>(undefined);
const CompactionProgressContext = createContext<import('./useCompactionProgress').CompactionProgress | undefined>(undefined);

export function ContextBreakdownProvider({
  value,
  compaction,
  children,
}: {
  value: ContextBreakdown | undefined;
  compaction?: import('./useCompactionProgress').CompactionProgress;
  children: ReactNode;
}) {
  return <ContextBreakdownContext.Provider value={value}><CompactionProgressContext.Provider value={compaction}>{children}</CompactionProgressContext.Provider></ContextBreakdownContext.Provider>;
}

/** One labeled token row inside the detail card. */
function TokenRow({ label, value, title }: { label: string; value: number | null; title: string }) {
  const { t, time } = useI18n();
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="font-mono text-ink tabular-nums" title={value === null ? t('diagnostics.unknown') : title}>
        {value === null ? t('diagnostics.unknown') : time.formatTokens(value)}
      </dd>
    </div>
  );
}

export function ContextMeter({
  used,
  limit,
  usage,
  usageError,
  usageScope = 'session',
  sessionId,
  agentId,
  onCompact,
  placement = 'above',
  autoCompact,
  compactAvailability,
}: {
  used: number;
  limit: number;
  /** Lifetime cumulative usage for the detail card (session record, or an agent's projected totals). */
  usage?: ContextMeterUsage;
  /**
   * Why the cumulative numbers are missing or short. `read-failed` means they
   * are placeholders and the card says so instead of showing zeros;
   * `agent-read-failed` keeps the numbers and marks them incomplete.
   */
  usageError?: SessionUsageError;
  /**
   * Whose cumulative usage the detail card reads and reports: the whole
   * session, or the one agent whose composer carries this meter.
   */
  usageScope?: 'session' | 'agent';
  /** Enables the prefetched deep link to this session on the /usage page (§9.5). */
  sessionId?: string;
  /** Identifies the current agent for the open detail's canonical usage read. */
  agentId?: string;
  /** Requests a compaction (the session view's /compact action). */
  onCompact?: () => void;
  placement?: 'above' | 'below';
  /**
   * The server-reported automatic-compaction point. When present the ring
   * colours against that point (amber from 80% of it, red at it) and the
   * card shows the adjustable track; absent, the card keeps the plain
   * used / limit / available rows (older engines, external executors).
   */
  autoCompact?: ContextMeterAutoCompact;
  /**
   * The engine's declared manual-compaction capability. Absent means nobody
   * answered, which gates nothing; `available: false` means the engine
   * answered and compaction is not (or not known to be) on offer, so the card
   * states the reason instead of rendering an action that cannot work.
   */
  compactAvailability?: ContextMeterCompactAvailability;
}) {
  const { t, time, locale } = useI18n();
  const breakdown = useContext(ContextBreakdownContext);
  const compaction = useContext(CompactionProgressContext);
  const manualPending = compaction?.source === 'manual' && (compaction.phase === 'queued' || compaction.phase === 'running');
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  const canonicalUsage = useCanonicalAgentUsage({ open: open && usageScope === 'agent', sessionId,
    agentId: usageScope === 'agent' ? agentId : undefined });
  const canonicalSession = useCanonicalSessionUsage(open && usageScope === 'session', sessionId);
  const hasCanonicalIdentity = canonicalUsage.hasIdentity;
  const sessionUsage = canonicalSession.active ? canonicalSession.usage ?? usage : usage;
  const sessionAccounting = sessionUsage?.accounting;
  const detailUsage = hasCanonicalIdentity ? canonicalUsage.usage : sessionAccounting === undefined ? sessionUsage : {
    input_tokens: sessionAccounting.tokens.input_other,
    output_tokens: sessionAccounting.tokens.output,
    cache_read_tokens: sessionAccounting.tokens.input_cache_read,
    cache_creation_tokens: sessionAccounting.tokens.input_cache_creation,
    total_cost_usd: sessionAccounting.cost_usd_estimated,
  };
  const detailUsageError: SessionUsageError | undefined = hasCanonicalIdentity
    ? canonicalUsage.state === 'error'
      ? 'read-failed'
      : canonicalUsage.partial
        ? 'agent-read-failed'
        : undefined
    : canonicalSession.error ? 'read-failed' : sessionAccounting !== undefined
      ? sessionAccounting.tokens_unknown || !sessionAccounting.complete ? 'agent-read-failed' : undefined
      : usageError;
  const costUnknown = hasCanonicalIdentity ? canonicalUsage.partial : sessionAccounting?.cost_unknown === true;
  const canonicalUsageLoading = hasCanonicalIdentity && canonicalUsage.state === 'loading' && detailUsage === undefined || canonicalSession.loading && sessionAccounting === undefined;
  const canonicalUsageUnknown = hasCanonicalIdentity && canonicalUsage.state === 'unavailable';
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Same dismissal and placement as the other status-line panels: outside
  // pointer or Escape closes, and above the composer the card floats flush
  // with the composer card's right edge.
  const onPanelKeyDown = usePopoverDismiss(open, (refocus) => {
    setOpen(false);
    if (refocus === true) triggerRef.current?.focus();
  }, rootRef, 'composer-context');
  useComposerPanelAnchor(rootRef, open);
  // The percent answers "how full is the usable window"; colour answers
  // "is compaction close", so it keys on the point once one is known.
  const usable = autoCompact?.status.effectiveMaxContextTokens ?? limit;
  const percent = contextUsagePercent(used, usable);
  const level = autoCompact !== undefined
    ? compactUsageLevel(used, autoCompact.status.tokens)
    : contextUsageLevel(used, limit);
  const warn = level !== 'ok';
  const remaining = Math.max(0, limit - used);
  const label = t('context.meter', { percent });
  const compactReason = compactAvailability !== undefined && !compactAvailability.available
    ? compactAvailability.reason
    : undefined;
  const baseTitle = autoCompact !== undefined ? t(
    level === 'danger' ? 'context.meterCompactDueTitle' : 'context.meterCompactTitle',
    {
      used: time.formatTokens(used),
      limit: time.formatTokens(usable),
      point: time.formatTokens(autoCompact.status.tokens),
    },
  ) : t(
    level === 'danger'
      ? 'context.meterDangerTitle'
      : warn
        ? 'context.meterWarnTitle'
        : 'context.meterTitle',
    { used: time.formatTokens(used), limit: time.formatTokens(limit) },
  );
  const title = compactReason === undefined ? baseTitle : `${baseTitle}\n${compactReason}`;

  const usageTotal =
    detailUsage === undefined
      ? undefined
      : detailUsage.input_tokens === null || detailUsage.output_tokens === null ||
          detailUsage.cache_read_tokens === null || detailUsage.cache_creation_tokens === null
        ? null
        : detailUsage.input_tokens +
          detailUsage.output_tokens +
          detailUsage.cache_read_tokens +
          detailUsage.cache_creation_tokens;

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape for the open card
    <div ref={rootRef} className="relative shrink-0" onKeyDown={onPanelKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        data-context-meter
        data-context-level={level}
        onClick={() => {
          if (!open) autoCompact?.onOpen?.();
          setOpen((value) => !value);
        }}
        title={title}
        aria-label={title}
        aria-expanded={open}
        aria-controls={detailsId}
        // Quiet at rest: a bare ring inside the composer card; the percent
        // label and a tint only appear once the window deserves attention.
        className={`flex h-7 items-center gap-1 rounded-md px-1 transition-colors duration-[var(--kiki-motion-quick)] outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:h-10 ${
          level === 'danger'
            ? 'text-danger hover:bg-danger/10'
            : warn
              ? 'text-amber-ink hover:bg-amber-card'
              : 'text-ink-faint hover:bg-paper hover:text-ink-soft'
        }`}
      >
        <span aria-hidden className="relative flex h-5 w-5 items-center justify-center">
          <svg viewBox="0 0 24 24" className="h-5 w-5 -rotate-90">
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
              className="transition-[stroke-dashoffset,stroke] duration-[var(--kiki-motion-base)]"
            />
          </svg>
        </span>
        {/* On a narrow composer the calm ring alone carries "ok"; the percent
            stays readable to screen readers and returns once it warns. */}
        <span className={`text-[12px] tabular-nums ${warn ? 'font-medium' : '@max-[22rem]/toolbar:sr-only'}`}>{label}</span>
        {warn ? <span className="sr-only">{t('context.detailsHint')}</span> : null}
      </button>
      {compaction !== undefined ? (
        <span role="status" data-compaction-progress={compaction.phase} title={compaction.reason} className={`absolute right-0 bottom-full mb-1 whitespace-nowrap text-[11px] ${compaction.phase === 'failed' ? 'text-danger' : 'text-ink-soft'}`}>
          {t(`context.compaction.${compaction.source}.${compaction.phase}`)}
        </span>
      ) : null}
      {open ? (
        <div
          id={detailsId}
          data-context-details
          role="dialog"
          aria-label={t('context.detailsTitle')}
          className={`anim-enter w-72 rounded-[10px] border border-hairline bg-panel p-3 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)] ${
            placement === 'below' ? 'absolute right-0 z-40 top-full mt-2 max-w-[calc(100vw-48px)]' : COMPOSER_PANEL_END
          }`}
        >
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-display text-[15px] font-semibold text-ink">{t('context.detailsTitle')}</p>
            <span className="shrink-0 whitespace-nowrap text-[12px] text-ink-soft tabular-nums">{label} · {time.formatTokens(used)}</span>
          </div>
          {/* §9.5 split: the ring answers "how much context is left right now";
              the cumulative block below answers "what has this session spent". */}
          {autoCompact !== undefined ? (
            <ContextCompactSection
              {...autoCompact}
              used={used}
              windowTokens={limit}
              residentTokens={breakdown === undefined ? undefined : breakdown.systemTokens + breakdown.toolsTokens}
            />
          ) : (<>
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <p className="text-[12px] font-medium text-ink-soft">{t('context.windowTitle')}</p>
            <span className="text-[12px] text-ink-faint">{t('context.windowHint')}</span>
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
                  className="transition-[stroke-dashoffset,stroke] duration-[var(--kiki-motion-base)]"
                />
              </svg>
              <span className="absolute font-mono text-[11px] leading-none font-medium tabular-nums">
                {percent}
              </span>
            </span>
            <dl className="min-w-0 flex-1 space-y-1 text-[12px]">
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
          </>)}
          {autoCompact?.strategy !== undefined ? (
            <ContextStrategySection handle={autoCompact.strategy} profileName={autoCompact.profile?.name} />
          ) : null}

          {detailUsage !== undefined || hasCanonicalIdentity ? (
            <dl
              data-context-usage
              className="mt-3 space-y-1.5 border-t border-hairline pt-3 text-[12px]"
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[12px] font-medium text-ink-soft">
                  {t(hasCanonicalIdentity ? 'context.agentUsage' : usageScope === 'agent' ? 'context.agentUsage' : 'context.sessionUsage')}
                </p>
                <span className="text-[12px] text-ink-faint">{t('context.sessionUsageHint')}</span>
              </div>
              {!hasCanonicalIdentity && sessionAccounting?.freshness !== undefined && sessionAccounting.freshness !== 'current' ? (
                <p role="status" data-context-usage-freshness={sessionAccounting.freshness} className="text-[12px] text-ink-faint">
                  {t(sessionAccounting.freshness === 'stale' ? 'context.usageStale' : 'context.usageUnverified')}
                </p>
              ) : null}
              {canonicalUsageLoading ? (
                <p role="status" data-context-usage-loading className="text-[12px] text-ink-faint">{t('diagnostics.loading')}</p>
              ) : null}
              {canonicalUsageUnknown ? (
                <p role="status" data-context-usage-unknown className="text-[12px] text-ink-faint">{t('diagnostics.unknown')}</p>
              ) : null}
              {detailUsageError !== undefined ? (
                <p data-context-usage-error title={detailUsageError} className="text-[12px] text-amber-ink">
                  {t(detailUsageError === 'read-failed' ? 'context.usageReadFailed' : 'context.agentUsageIncomplete')}
                </p>
              ) : null}
              {detailUsageError === 'read-failed' || canonicalUsageLoading ? null : detailUsage !== undefined ? (
                <>
                  <TokenRow label={t('usage.tokens.input')} value={detailUsage.input_tokens} title={String(detailUsage.input_tokens)} />
                  <TokenRow label={t('usage.tokens.output')} value={detailUsage.output_tokens} title={String(detailUsage.output_tokens)} />
                  <TokenRow label={t('usage.tokens.cacheRead')} value={detailUsage.cache_read_tokens} title={String(detailUsage.cache_read_tokens)} />
                  <TokenRow label={t('usage.tokens.cacheWrite')} value={detailUsage.cache_creation_tokens} title={String(detailUsage.cache_creation_tokens)} />
                  {detailUsage.total_cost_usd !== null || hasCanonicalIdentity ? (
                    <div className="flex items-center justify-between gap-3 border-t border-hairline pt-1.5">
                      <dt className="text-ink-faint">{t('usage.card.cost')}</dt>
                      <dd className="font-mono text-ink tabular-nums">
                        {detailUsage.total_cost_usd === null ? t('diagnostics.unknown') : formatCostUsd(detailUsage.total_cost_usd)}
                        {costUnknown && detailUsage.total_cost_usd !== null ? <KnownSubtotalMarker /> : null}
                      </dd>
                    </div>
                  ) : null}
                  {usageTotal !== undefined ? (
                    <div
                      className={`flex items-center justify-between gap-3 ${
                        // Priced sessions and canonical unknown-cost rows put the
                        // separator on the cost row; standalone cost-less projections move it here.
                        detailUsage.total_cost_usd === null && !hasCanonicalIdentity ? 'border-t border-hairline pt-1.5' : ''
                      }`}
                    >
                      <dt className="text-ink-faint">{t('usage.card.tokens')}</dt>
                      <dd className="font-mono text-ink tabular-nums">
                        {usageTotal === null ? t('diagnostics.unknown') : time.formatTokens(usageTotal)}
                      </dd>
                    </div>
                  ) : null}
                </>
              ) : null}
              {sessionId !== undefined ? (
                <Link
                  data-context-usage-link
                  to={usageSessionDeepLink(sessionId)}
                  onClick={() => { setOpen(false); }}
                  className="block pt-1 text-[12px] font-medium text-ink underline decoration-hairline-strong underline-offset-2 hover:decoration-ink"
                >
                  {t('context.viewInUsage')}
                </Link>
              ) : null}
            </dl>
          ) : null}

          {breakdown !== undefined ? (
            <div data-context-breakdown className="mt-3 border-t border-hairline pt-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[12px] font-medium text-ink-soft">{t('context.breakdownTitle')}</p>
                <span className="text-[12px] text-ink-faint">{t('context.breakdownEstimated')}</span>
              </div>
              <dl className="mt-2 space-y-1.5 text-[12px]">
                <TokenRow label={t('context.system')} value={breakdown.systemTokens} title={String(breakdown.systemTokens)} />
                <TokenRow label={t('context.tools')} value={breakdown.toolsTokens} title={String(breakdown.toolsTokens)} />
                <TokenRow label={t('context.messages')} value={breakdown.messagesTokens} title={String(breakdown.messagesTokens)} />
              </dl>
            </div>
          ) : null}

          {onCompact !== undefined ? (
            compactReason !== undefined ? (
              // The engine answered that this action is not on offer; the card
              // says why instead of rendering a button that cannot work.
              <p data-context-compact-unavailable className="mt-3 text-[12px] leading-4 text-ink-faint">
                {compactReason}
              </p>
            ) : (
            <CompactActions
              strategy={autoCompact?.strategy}
              pending={manualPending}
              onCompact={() => {
                setOpen(false);
                onCompact();
              }}
              onCompactWith={(strategy) => {
                setOpen(false);
                void autoCompact?.strategy?.compact(strategy)
                  .then((receipt) => { pushToast({ tone: 'success', text: t(receipt?.status === undefined ? 'action.compactRequestedSession' : `context.compaction.manual.${receipt.status}`) }); })
                  .catch((error: unknown) => {
                    pushToast({ tone: 'error', text: t('action.compactFailed', { detail: sessionActionErrorText(locale, error) }) });
                  });
              }}
            />
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
const COMPACT_OPTIONS: readonly ManualCompactStrategy[] = ['summarize', 'fresh'];

/**
 * The card's compaction action. Without a strategy handle it is the plain
 * button; with one, a split button: the main part compacts with the
 * session's own strategy, the chevron offers a one-off choice.
 */
function CompactActions({
  strategy,
  pending,
  onCompact,
  onCompactWith,
}: {
  strategy: ContextStrategyHandle | undefined;
  pending: boolean;
  onCompact: () => void;
  onCompactWith: (strategy: ManualCompactStrategy) => void;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const chevronRef = useRef<HTMLButtonElement | null>(null);
  const tone = 'bg-amber-card text-[12px] font-medium text-amber-ink transition-colors hover:bg-amber-rule/25 focus-visible:ring-2 focus-visible:ring-amber-rule/60 focus-visible:outline-none';
  if (strategy === undefined || !strategy.writable || strategy.status?.source === 'executor') {
    return (
      <button type="button" data-context-compact data-executor-action="manual_compact" disabled={pending} onClick={onCompact} className={`mt-3 w-full rounded-md px-3 py-1.5 ${tone}`}>
        {t('context.compactAction')}
      </button>
    );
  }
  return (
    <div data-executor-action="manual_compact" className="relative mt-3 flex gap-px">
      <button type="button" data-context-compact disabled={pending} onClick={onCompact} className={`min-w-0 flex-1 rounded-l-md px-3 py-1.5 ${tone}`}>
        {t('context.compactAction')}
      </button>
      <button
        ref={chevronRef}
        type="button"
        data-context-compact-with
        disabled={pending}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t('context.strategy.compactOptionsLabel')}
        onClick={() => { setMenuOpen((value) => !value); }}
        className={`flex w-8 shrink-0 items-center justify-center rounded-r-md pointer-coarse:w-11 ${tone}`}
      >
        <Icon name="chevron" size={12} className={`transition-transform ${menuOpen ? '-rotate-90' : 'rotate-90'}`} />
      </button>
      <AnchoredPopover
        open={menuOpen}
        onClose={() => { setMenuOpen(false); }}
        anchorRef={chevronRef}
        id="context-compact-menu"
        label={t('context.strategy.compactWith')}
        role="menu"
        side="above"
        align="end"
        widthClassName="w-64"
        className="p-1"
        data={{ 'data-context-compact-menu': '' }}
        onSurfaceKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
          const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
          if (rows.length === 0) return false;
          const index = rows.indexOf(document.activeElement as HTMLButtonElement);
          event.preventDefault();
          rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
          return true;
        }}
      >
        <p className="px-3 pt-1.5 pb-1 text-[12px] font-medium text-ink-faint">{t('context.strategy.compactWith')}</p>
        {COMPACT_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            role="menuitem"
            data-context-compact-option={option}
            onClick={() => { setMenuOpen(false); onCompactWith(option); }}
            className="flex w-full flex-col items-start rounded-md px-3 py-1.5 text-left text-[13px] text-ink outline-none transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-visible:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:py-2"
          >
            <span>{t(STRATEGY_LABEL_KEY[option])}</span>
            <span className="text-[12px] leading-4 text-ink-faint">{t(`context.strategy.hint.${option}`)}</span>
          </button>
        ))}
      </AnchoredPopover>
    </div>
  );
}
