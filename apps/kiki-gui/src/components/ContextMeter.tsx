/**
 * ContextMeter — the composer footer's mini context-usage gauge, rendered as a
 * ring (not a bar). Clicking the ring opens a bounded detail card (`ContextMeterCard`).
 */

import { createContext, useContext, useId, useRef, useState, type ReactNode } from 'react';

import type { CompactSessionResponse, SessionUsageError, UsageAccountingSnapshot } from '@kiki/protocol';
import type { ContextBreakdown } from '@kiki/session-core/wire';

import { useI18n } from '../i18n';
import { compactUsageLevel } from '../lib/autoCompact';
import { lazyComponent } from '../lib/lazyComponent';
import { usePopoverDismiss } from './ComposerControls';
import type { ContextCompactSectionProps } from './ContextCompactSection';
import type { CompactionProgress } from './useCompactionProgress';
import type { ContextStrategyHandle } from './useContextStrategy';

const LazyContextMeterCard = lazyComponent(() =>
  import('./ContextMeterCard').then((m) => m.ContextMeterCard),
);

if (import.meta.env.MODE === 'test') {
  await LazyContextMeterCard.preload();
}

export type ContextMeterAutoCompact = Omit<ContextCompactSectionProps, 'used' | 'windowTokens' | 'residentTokens'> & {
  readonly onOpen?: () => void;
  readonly strategy?: ContextStrategyHandle;
};

export interface ContextMeterCompactAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

export const CONTEXT_WARN_RATIO = 0.5;
export const CONTEXT_DANGER_RATIO = 0.8;

export type ContextUsageLevel = 'ok' | 'warn' | 'danger';

export type ContextMeterUsage = {
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_creation_tokens: number | null;
  readonly total_cost_usd: number | null;
  readonly accounting?: UsageAccountingSnapshot;
};

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
const CompactionProgressContext = createContext<CompactionProgress | undefined>(undefined);
const CompactionSeedContext = createContext<((receipt: CompactSessionResponse) => void) | undefined>(undefined);

export function ContextBreakdownProvider({
  value,
  compaction,
  onCompactionReceipt,
  children,
}: {
  value: ContextBreakdown | undefined;
  compaction?: CompactionProgress;
  onCompactionReceipt?: (receipt: CompactSessionResponse) => void;
  children: ReactNode;
}) {
  return (
    <ContextBreakdownContext.Provider value={value}>
      <CompactionProgressContext.Provider value={compaction}>
        <CompactionSeedContext.Provider value={onCompactionReceipt}>
          {children}
        </CompactionSeedContext.Provider>
      </CompactionProgressContext.Provider>
    </ContextBreakdownContext.Provider>
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
  used?: number;
  limit: number;
  usage?: ContextMeterUsage;
  usageError?: SessionUsageError;
  usageScope?: 'session' | 'agent';
  sessionId?: string;
  agentId?: string;
  onCompact?: () => void;
  placement?: 'above' | 'below';
  autoCompact?: ContextMeterAutoCompact;
  compactAvailability?: ContextMeterCompactAvailability;
}) {
  const { t, time } = useI18n();
  const breakdown = useContext(ContextBreakdownContext);
  const compaction = useContext(CompactionProgressContext);
  const seedCompaction = useContext(CompactionSeedContext);
  const manualPending = compaction?.source === 'manual' && (compaction.phase === 'queued' || compaction.phase === 'running');
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onPanelKeyDown = usePopoverDismiss(open, (refocus) => {
    setOpen(false);
    if (refocus === true) triggerRef.current?.focus();
  }, rootRef, 'composer-context', panelRef);

  const measured = used !== undefined;
  const usable = autoCompact?.status.effectiveMaxContextTokens ?? limit;
  const percent = measured ? contextUsagePercent(used, usable) : undefined;
  const level: ContextUsageLevel = !measured
    ? 'ok'
    : autoCompact !== undefined
      ? compactUsageLevel(used, autoCompact.status.tokens)
      : contextUsageLevel(used, limit);
  const warn = level !== 'ok';
  const remaining = measured ? Math.max(0, limit - used) : undefined;
  const label = percent !== undefined ? t('context.meter', { percent }) : '—';
  const usedLabel = measured ? time.formatTokens(used) : '—';
  const compactReason = compactAvailability !== undefined && !compactAvailability.available
    ? compactAvailability.reason
    : undefined;
  const baseTitle = autoCompact !== undefined ? t(
    level === 'danger' ? 'context.meterCompactDueTitle' : 'context.meterCompactTitle',
    {
      used: usedLabel,
      limit: time.formatTokens(usable),
      point: time.formatTokens(autoCompact.status.tokens),
    },
  ) : t(
    level === 'danger'
      ? 'context.meterDangerTitle'
      : warn
        ? 'context.meterWarnTitle'
        : 'context.meterTitle',
    { used: usedLabel, limit: time.formatTokens(limit) },
  );
  const title = compactReason === undefined ? baseTitle : `${baseTitle}\n${compactReason}`;

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape for the open card
    <div ref={rootRef} className="relative shrink-0" onKeyDown={onPanelKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        data-context-meter
        data-context-level={level}
        data-context-unmeasured={!measured ? '' : undefined}
        onClick={() => {
          if (!open) autoCompact?.onOpen?.();
          setOpen((value) => !value);
        }}
        title={title}
        aria-label={title}
        aria-expanded={open}
        aria-controls={detailsId}
        className={`flex h-7 items-center gap-1 rounded-md px-1 transition-colors duration-[var(--kiki-motion-quick)] outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center ${
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
            {percent !== undefined ? (
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
            ) : null}
          </svg>
        </span>
        <span className="text-[12px] tabular-nums @max-[24rem]/toolbar:sr-only">{label}</span>
        {warn ? <span className="sr-only">{t('context.detailsHint')}</span> : null}
      </button>
      {compaction !== undefined ? (
        <span role="status" data-compaction-progress={compaction.phase} data-compaction-unconfirmed={compaction.unconfirmed === true ? '' : undefined} title={compaction.reason ?? (compaction.unconfirmed === true ? t('context.compaction.uncheckedHint') : undefined)} className={`absolute right-0 bottom-full mb-1 whitespace-nowrap text-[11px] ${compaction.phase === 'failed' ? 'text-danger' : 'text-ink-soft'}`}>
          {t(`context.compaction.${compaction.source}.${compaction.phase}`)}
          {compaction.unconfirmed === true ? <span className="text-ink-faint"> · {t('context.compaction.unchecked')}</span> : null}
        </span>
      ) : null}
      {open ? (
        <LazyContextMeterCard
          detailsId={detailsId}
          triggerRef={triggerRef}
          panelRef={panelRef}
          placement={placement}
          used={used}
          limit={limit}
          usable={usable}
          measured={measured}
          percent={percent}
          level={level}
          remaining={remaining}
          label={label}
          usedLabel={usedLabel}
          usage={usage}
          usageError={usageError}
          usageScope={usageScope}
          sessionId={sessionId}
          agentId={agentId}
          breakdown={breakdown}
          manualPending={manualPending}
          seedCompaction={seedCompaction}
          onCompact={onCompact}
          compactReason={compactReason}
          autoCompact={autoCompact}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus === true) triggerRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
