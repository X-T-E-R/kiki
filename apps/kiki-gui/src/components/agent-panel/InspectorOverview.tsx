/**
 * The inspector's resident overview: the numbers a user checks to feel in
 * control, shown in every state (idle included). Three layers, so it reads
 * at a glance and never turns into a wall:
 *
 *   1. context: bar with the automatic-compaction point marked, used / limit
 *   2. three figures: cost, tokens, cache hits (with compactions beside)
 *   3. one quiet line: the work this conversation has done — turns, tool
 *      calls, compactions
 *
 * How long the session has been open is history, not something to read while
 * checking the present, so it lives in the work line's hover as the absolute
 * start time rather than occupying the first screen.
 *
 * What this agent is set up to do is not here either: model, effort, window
 * and permission mode already live in the profile card, and the permission
 * mode is set from the composer. Restating them below the numbers is the
 * duplication this component exists without.
 *
 * The figures sit in one measured row that ends where the numbers do, so a
 * missing figure closes its gap instead of holding a third of the column open
 * as blank paper. Unknown values are left out rather than printed as
 * "Unknown", and an incomplete count says so rather than reading as final.
 */

import { memo, type ReactNode } from 'react';

import { useI18n } from '../../i18n';

export interface OverviewFigures {
  readonly costUsd?: number;
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheRate?: number;
  readonly cacheTitle?: string;
  readonly compactions?: number;
  readonly partial?: boolean;
  /** This count covers part of the tree, not all of it. */
  readonly incomplete?: boolean;
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
  /** ISO start of the session (main) or of the agent's run (subagent). */
  readonly startedAt?: string;
  readonly turns?: number;
  readonly toolCalls?: number;
  readonly renderLayout?: (body: ReactNode, scopeSwitch: ReactNode) => ReactNode;
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
  startedAt,
  turns,
  toolCalls,
  renderLayout,
}: InspectorOverviewProps) {
  const { t, tp } = useI18n();
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
  const scopeButton = (value: 'agent' | 'tree', label: string, fullLabel = label) => (
    <button
      type="button"
      role="radio"
      aria-checked={scope === value}
      aria-label={fullLabel}
      title={fullLabel}
      data-usage-scope={value}
      onClick={() => { onScope(value); }}
      className={`h-7 min-w-0 truncate rounded-md px-1 text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${value === 'tree' ? 'shrink-0' : ''} ${
        scope === value ? 'text-ink' : 'text-ink-faint hover:text-ink-soft'
      }`}
    >
      {label}
    </button>
  );
  // The scope is a standing control of these figures on the page that owns a
  // whole tree, not a treat that appears once the tree happens to be fully
  // measurable: main always carries the switch, and a tree the server has not
  // finished counting is marked rather than dropped. A subagent's own figures
  // have no tree of their own, so it has nothing to switch to.
  const treePartial = treeFigures?.incomplete === true;
  const scopeSwitch = treeFigures === undefined ? null : (
    <div
      role="radiogroup"
      aria-label={t('inspector.scopeAria')}
      className="ml-auto flex min-w-0 flex-nowrap items-baseline justify-end whitespace-nowrap"
    >
      {scopeButton('agent', t('inspector.scopeAgent'))}
      <span aria-hidden className="shrink-0 text-[12px] text-hairline-strong">/</span>
      <button
        type="button"
        role="radio"
        aria-checked={scope === 'tree'}
        aria-label={t('inspector.treeTotal')}
        title={treePartial ? t('inspector.treeTotalPartial') : t('inspector.treeTotal')}
        data-usage-scope="tree"
        data-usage-scope-incomplete={treePartial || undefined}
        onClick={() => { onScope('tree'); }}
        className={`h-7 shrink-0 truncate rounded-md px-1 text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
          scope === 'tree' ? 'text-ink' : treePartial ? 'text-amber-ink hover:text-amber-ink' : 'text-ink-faint hover:text-ink-soft'
        }`}
      >
        {t('inspector.scopeTree')}
        {treePartial ? <span className="ml-1 text-[11px]" aria-hidden>*</span> : null}
      </button>
    </div>
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
  const workLine = [
    turns !== undefined && turns > 0 ? tp('inspector.turns', turns) : undefined,
    toolCalls !== undefined && toolCalls > 0 ? tp('inspector.toolCalls', toolCalls) : undefined,
    !tree && shown.compactions !== undefined && shown.compactions > 0 ? tp('inspector.compactions', shown.compactions) : undefined,
  ].filter((part): part is string => part !== undefined);
  // Where the session began is a question only asked while tracing it, so it
  // rides the work line as its title and prints no line of its own.
  const startedTitle = startedAt === undefined ? undefined : t('inspector.sessionAgeTitle', { at: new Date(startedAt).toLocaleString() });
  const body = (
    <section data-inspector-overview className="space-y-2.5">
      {renderLayout === undefined ? scopeSwitch : null}

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
        <div {...(tree ? { 'data-tree-metrics': '' } : { 'data-agent-usage': '' })} className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
          {figureCells}
          {shown.partial === true ? <span className="text-[11.5px] text-amber-ink">{t('agentPanel.partialBadge')}</span> : null}
        </div>
      ) : null}

      {tree && treePartial ? (
        <p data-overview-tree-incomplete className="-mt-1 text-[11.5px] leading-4 text-amber-ink">
          {t('inspector.treePartialNote')}
        </p>
      ) : null}

      {workLine.length > 0 ? (
        <p data-overview-session className="truncate text-[12px] leading-[18px] text-ink-faint tabular-nums" title={startedTitle}>
          {workLine.join(' · ')}
        </p>
      ) : startedTitle === undefined ? null : (
        // A conversation with no turns, tool calls or compactions yet has no
        // counters line to hang the start time on; screen readers still get it.
        <p data-overview-started className="sr-only">{startedTitle}</p>
      )}
    </section>
  );
  return renderLayout === undefined ? body : renderLayout(body, scopeSwitch);
});
