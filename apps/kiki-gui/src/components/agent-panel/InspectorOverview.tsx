/**
 * The inspector's resident overview: the numbers a user checks to feel in
 * control, shown in every state (idle included). Three layers, so it reads
 * at a glance and never turns into a wall:
 *
 *   1. context: bar with the automatic-compaction point marked, used / limit
 *   2. three figures: cost, tokens, cache hits (with compactions beside)
 *   3. quiet ink-soft lines: model · effort · permissions, then how long the
 *      session has been open, turns, tool calls
 *
 * Unknown values are left out rather than printed as "Unknown".
 */

import { memo, type ReactNode } from 'react';

import { useI18n } from '../../i18n';
import { useNow } from '../RelativeTime';

export interface OverviewFigures {
  readonly costUsd?: number;
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheRate?: number;
  readonly cacheTitle?: string;
  readonly compactions?: number;
  readonly partial?: boolean;
}

export interface InspectorOverviewProps {
  readonly contextUsed?: number;
  readonly contextLimit?: number;
  /** Automatic-compaction point in tokens (server-reported). */
  readonly compactPoint?: number;
  readonly figures: OverviewFigures;
  /** Whole-tree figures; with them a light scope switch appears. */
  readonly treeFigures?: OverviewFigures;
  readonly scope: 'agent' | 'tree';
  readonly onScope: (scope: 'agent' | 'tree') => void;
  readonly setupLine: readonly string[];
  /** ISO start of the session (main) or of the agent's run (subagent). */
  readonly startedAt?: string;
  readonly turns?: number;
  readonly toolCalls?: number;
}

function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${value >= 100_000 ? Math.round(value / 1_000) : (value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(value);
}

function costText(value: number): string {
  if (value > 0 && value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

/** Coarse age: "4m", "2h 5m", "3d 1h". */
function useAge(startedAt: string | undefined): string | undefined {
  const { t } = useI18n();
  const now = useNow();
  if (startedAt === undefined) return undefined;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return undefined;
  const minutes = Math.max(1, Math.floor((now - start) / 60_000));
  if (minutes < 60) return t('inspector.durationM', { m: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('inspector.durationH', { h: hours, m: minutes % 60 });
  return t('inspector.durationD', { d: Math.floor(hours / 24), h: hours % 24 });
}

function Figure({ value, label, title, tone = 'text-ink', ...data }: {
  value: ReactNode;
  label: string;
  title?: string;
  tone?: string;
} & { [key: `data-${string}`]: string }) {
  return (
    <div className="min-w-0" title={title} {...data}>
      <div className={`truncate text-[15px] leading-5 font-medium tabular-nums ${tone}`}>{value}</div>
      <div className="truncate text-[11.5px] leading-4 text-ink-faint">{label}</div>
    </div>
  );
}

export const InspectorOverview = memo(function InspectorOverview({
  contextUsed,
  contextLimit,
  compactPoint,
  figures,
  treeFigures,
  scope,
  onScope,
  setupLine,
  startedAt,
  turns,
  toolCalls,
}: InspectorOverviewProps) {
  const { t, tp } = useI18n();
  const age = useAge(startedAt);
  const tree = scope === 'tree' && treeFigures !== undefined;
  const shown = tree ? treeFigures : figures;
  const pct = contextUsed !== undefined && contextLimit !== undefined && contextLimit > 0
    ? Math.min(100, Math.round((contextUsed / contextLimit) * 100))
    : undefined;
  const pointPct = compactPoint !== undefined && contextLimit !== undefined && contextLimit > 0 && compactPoint < contextLimit
    ? (compactPoint / contextLimit) * 100
    : undefined;
  // Tone keys on the compaction point once known: "is compaction close".
  const level = contextUsed === undefined
    ? 'ok'
    : compactPoint !== undefined
      ? contextUsed >= compactPoint ? 'danger' : contextUsed >= compactPoint * 0.8 ? 'warn' : 'ok'
      : pct !== undefined && pct >= 80 ? 'danger' : pct !== undefined && pct >= 50 ? 'warn' : 'ok';
  const barTone = level === 'danger' ? 'bg-danger' : level === 'warn' ? 'bg-amber-rule' : 'bg-ink-soft';
  const scopeButton = (value: 'agent' | 'tree', label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={scope === value}
      data-usage-scope={value}
      onClick={() => { onScope(value); }}
      className={`h-7 rounded-md px-1.5 text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
        scope === value ? 'text-ink' : 'text-ink-faint hover:text-ink-soft'
      }`}
    >
      {label}
    </button>
  );
  const figureCells = [
    shown.costUsd !== undefined
      ? <Figure key="cost" data-overview-fact="cost" value={costText(shown.costUsd)} label={t('inspector.cost')} title={`$${shown.costUsd.toFixed(4)}`} />
      : null,
    shown.totalTokens !== undefined
      ? <Figure
          key="tokens"
          data-overview-fact="tokens"
          value={compactTokens(shown.totalTokens)}
          label={t('inspector.tokens')}
          title={shown.inputTokens !== undefined && shown.outputTokens !== undefined
            ? t('inspector.inOut', { input: compactTokens(shown.inputTokens), output: compactTokens(shown.outputTokens) })
            : undefined}
        />
      : null,
    shown.cacheRate !== undefined
      ? <Figure key="cache" data-overview-fact="cache" value={`${shown.cacheRate}%`} label={t('agentPanel.cacheRate')} title={shown.cacheTitle} />
      : null,
  ].filter((cell) => cell !== null);
  const sessionLine = [
    age !== undefined ? t('inspector.sessionAge', { duration: age }) : undefined,
    turns !== undefined && turns > 0 ? tp('inspector.turns', turns) : undefined,
    toolCalls !== undefined && toolCalls > 0 ? tp('inspector.toolCalls', toolCalls) : undefined,
    !tree && shown.compactions !== undefined && shown.compactions > 0 ? tp('inspector.compactions', shown.compactions) : undefined,
  ].filter((part): part is string => part !== undefined);
  return (
    <section data-inspector-overview className="space-y-3">
      {treeFigures !== undefined ? (
        <div role="radiogroup" aria-label={t('inspector.scopeAria')} className="-my-1 -mr-1.5 flex items-center justify-end">
          {scopeButton('agent', t('inspector.scopeAgent'))}
          <span aria-hidden className="text-[12px] text-hairline-strong">/</span>
          {scopeButton('tree', t('inspector.treeTotal'))}
        </div>
      ) : null}

      {contextUsed !== undefined ? (
        <div data-overview-context={level} className="space-y-1.5">
          <div className="flex items-baseline gap-2 text-[12.5px]">
            <span className="text-ink-soft">{t('inspector.context')}</span>
            <span className="ml-auto text-[13px] font-medium text-ink tabular-nums">
              {compactTokens(contextUsed)}
              {contextLimit !== undefined ? <span className="font-normal text-ink-faint"> / {compactTokens(contextLimit)}</span> : null}
            </span>
          </div>
          {pct !== undefined ? (
            <div
              role="meter"
              aria-label={t('inspector.context')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-valuetext={t('inspector.ofWindow', { pct })}
              className="relative h-1.5 rounded-full bg-ink/[0.08]"
            >
              <div className={`h-full rounded-full transition-[width] duration-[var(--kiki-motion-base)] motion-reduce:transition-none ${barTone}`} style={{ width: `${pct}%` }} />
              {pointPct !== undefined ? (
                <span
                  aria-hidden
                  data-overview-compact-mark
                  className="absolute -top-[3px] -bottom-[3px] w-[2px] -translate-x-1/2 rounded-full bg-ink-faint"
                  style={{ left: `${pointPct}%` }}
                />
              ) : null}
            </div>
          ) : null}
          <p className="flex min-w-0 gap-1.5 text-[11.5px] text-ink-faint tabular-nums">
            {pct !== undefined ? <span>{t('inspector.ofWindow', { pct })}</span> : null}
            {compactPoint !== undefined ? (
              <>
                {pct !== undefined ? <span aria-hidden>·</span> : null}
                <span title={t('inspector.compactAtTitle', { point: compactPoint.toLocaleString() })} className={level === 'ok' ? undefined : level === 'danger' ? 'text-danger' : 'text-amber-ink'}>
                  {t('inspector.compactAt', { point: compactTokens(compactPoint) })}
                </span>
              </>
            ) : null}
          </p>
        </div>
      ) : null}

      {figureCells.length > 0 ? (
        <div {...(tree ? { 'data-tree-metrics': '' } : { 'data-agent-usage': '' })} className="grid grid-cols-3 gap-3">
          {figureCells}
          {shown.partial === true ? <span className="col-span-3 -mt-1 text-[11.5px] text-amber-ink">{t('agentPanel.partialBadge')}</span> : null}
        </div>
      ) : null}

      {setupLine.length > 0 || sessionLine.length > 0 ? (
        <div className="space-y-0.5 text-[12px] leading-[18px] text-ink-soft">
          {setupLine.length > 0 ? (
            <p data-overview-setup className="truncate" title={setupLine.join(' · ')}>
              {setupLine.map((part, index) => (
                <span key={`${index}:${part}`}>
                  {index > 0 ? <span aria-hidden className="mx-1.5 text-ink-faint">·</span> : null}
                  {part}
                </span>
              ))}
            </p>
          ) : null}
          {sessionLine.length > 0 ? (
            <p data-overview-session className="truncate text-ink-faint tabular-nums" title={startedAt === undefined ? undefined : t('inspector.sessionAgeTitle', { at: new Date(startedAt).toLocaleString() })}>
              {sessionLine.join(' · ')}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
});
