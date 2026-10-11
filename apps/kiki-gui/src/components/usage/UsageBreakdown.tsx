/**
 * Dimension breakdown: one row per key with its cost share, tokens, and cache
 * hit rate. The agent dimension renders parent/child trees; model and agent
 * dimensions also roll up by the attribution fields the server already sends
 * (provider for models, profile name — the subagent role — for agents). Keys
 * whose attribution is null or mixed stay visibly unknown/mixed.
 */

import { useMemo, useState, type ReactNode } from 'react';

import { useI18n } from '../../i18n';
import { DisclosureChevron, Icon } from '../icons';
import {
  aggregateDimensionGroups,
  buildAgentTree,
  type UsageDimensionRow,
  type UsageLegacyDimension,
  type UsageTokensWire,
  type UsageTrendBucketWire,
} from '../../lib/usageV2';
import {
  formatCostOrDash,
  formatPercent,
  KnownSubtotalMarker,
  rowCacheHit,
  ShareBar,
} from './usageShared';

function tokensTotalUnknown(row: UsageDimensionRow): boolean {
  return row.tokensUnknown && row.totalTokens === 0;
}

function sumTokens(rows: readonly UsageDimensionRow[]): UsageTokensWire {
  return rows.reduce(
    (acc, row) => ({
      input_other: acc.input_other + row.tokens.input_other,
      output: acc.output + row.tokens.output,
      input_cache_read: acc.input_cache_read + row.tokens.input_cache_read,
      input_cache_creation: acc.input_cache_creation + row.tokens.input_cache_creation,
    }),
    { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
  );
}

export function DimensionBreakdown({
  trend,
  dimension,
  labelFor,
}: {
  readonly trend: readonly UsageTrendBucketWire[];
  readonly dimension: UsageLegacyDimension;
  readonly labelFor: (row: UsageDimensionRow) => string;
}) {
  const { t, time } = useI18n();
  const rows = useMemo(() => aggregateDimensionGroups(trend), [trend]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const totalCost = rows.reduce((sum, row) => sum + row.costUsdEstimated, 0);
  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (rows.length === 0) {
    return <p className="py-8 text-center text-[13px] text-ink-faint">{t('usage.empty')}</p>;
  }

  const renderRow = (row: UsageDimensionRow, depth: number, control?: ReactNode) => {
    const share = totalCost > 0 ? row.costUsdEstimated / totalCost : 0;
    const label = labelFor(row);
    const cacheHit = rowCacheHit(row);
    return (
      <li
        key={`${depth}:${row.key}`}
        data-usage-breakdown-row={row.key}
        className="grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-x-4 gap-y-1 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_7rem_4.5rem_4.5rem_5.5rem]"
        style={{ paddingLeft: 12 + depth * 20 }}
      >
        <div className="flex min-w-0 items-center gap-2">
          {control ?? <span aria-hidden className="w-5 shrink-0" />}
          <div className="min-w-0">
            <p
              className={`truncate text-[13px] ${row.key === 'unknown' ? 'text-ink-soft italic' : 'font-medium text-ink'}`}
              title={row.key}
            >
              {label}
            </p>
            <p className="truncate font-mono text-[11px] text-ink-faint">
              {row.mixedAttribution
                ? t('usage.dim.mixedAttribution')
                : dimension === 'agent'
                  ? [row.modelAlias, row.provider].filter((part) => part !== null).join(' · ')
                  : ''}
            </p>
          </div>
        </div>
        <div className="hidden items-center gap-2 sm:flex">
          <ShareBar ratio={share} />
          <span className="w-9 shrink-0 text-right font-mono text-[11px] text-ink-faint tabular-nums">{formatPercent(share)}</span>
        </div>
        <span
          data-usage-breakdown-tokens={row.key}
          className="hidden text-right font-mono text-[12px] text-ink-soft tabular-nums sm:block"
        >
          {tokensTotalUnknown(row) ? '—' : time.formatTokens(row.totalTokens)}
          {row.tokensUnknown && row.totalTokens > 0 ? <KnownSubtotalMarker /> : null}
        </span>
        <span className="hidden text-right font-mono text-[12px] text-ink-soft tabular-nums sm:block">
          {formatPercent(cacheHit)}
        </span>
        <span
          data-usage-breakdown-cost={row.key}
          className="text-right font-mono text-[13px] font-semibold text-ink tabular-nums"
        >
          {formatCostOrDash(row.costUsdEstimated, tokensTotalUnknown(row))}
          {row.costUnknown ? <Icon name="partial" size={12} className="ml-1 inline-block align-[-1px] text-amber-ink" /> : null}
        </span>
      </li>
    );
  };

  const header = (
    <div aria-hidden className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-x-4 px-3 pb-2 text-[11px] text-ink-faint sm:grid-cols-[minmax(0,1fr)_7rem_4.5rem_4.5rem_5.5rem]">
      <span className="pl-7">{t(`usage.dimension.${dimension}`)}</span>
      <span className="hidden sm:block">{t('usage.col.share')}</span>
      <span className="hidden text-right sm:block">{t('usage.col.tokens')}</span>
      <span className="hidden text-right sm:block">{t('usage.col.cacheHit')}</span>
      <span className="text-right">{t('usage.col.cost')}</span>
    </div>
  );

  let list: ReactNode;
  if (dimension !== 'agent') {
    list = <ul className="divide-y divide-hairline">{rows.map((row) => renderRow(row, 0))}</ul>;
  } else {
    const tree = buildAgentTree(rows);
    const rootIds = new Set(tree.roots.map((root) => root.agentId ?? root.key));
    const orphans = rows.filter((row) => row.parentAgentId !== null && !rootIds.has(row.parentAgentId));
    list = (
      <ul className="divide-y divide-hairline" data-usage-agent-tree>
        {tree.roots.map((row) => {
          const children = tree.childrenByParent.get(row.agentId ?? row.key) ?? [];
          const open = expanded.has(row.key);
          const childCost = children.reduce((sum, child) => sum + child.costUsdEstimated, 0);
          const childTokens = sumTokens(children);
          const control = children.length > 0 ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={t('usage.agent.subagents', { count: children.length })}
              onClick={() => { toggle(row.key); }}
              className="flex h-6 w-5 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-paper hover:text-ink"
            >
              <DisclosureChevron open={open} className="text-current" />
            </button>
          ) : undefined;
          return (
            <li key={row.key} className="list-none">
              <ul>{renderRow(row, 0, control)}</ul>
              {children.length > 0 ? (
                <button
                  type="button"
                  onClick={() => { toggle(row.key); }}
                  className="mb-2 ml-10 inline-flex min-h-7 items-center gap-2 rounded-md px-2 text-[12px] text-ink-soft hover:bg-ink/[0.05] hover:text-ink"
                >
                  {t('usage.agent.subagents', { count: children.length })}
                  <span className="font-mono text-ink-faint tabular-nums">
                    {formatCostOrDash(childCost, false)} · {time.formatTokens(childTokens.input_other + childTokens.output + childTokens.input_cache_read + childTokens.input_cache_creation)}
                  </span>
                </button>
              ) : null}
              {open ? <ul className="border-t border-dashed border-hairline bg-paper/40">{children.map((child) => renderRow(child, 1))}</ul> : null}
            </li>
          );
        })}
        {orphans.map((row) => renderRow(row, 1))}
      </ul>
    );
  }

  return (
    <div className="min-w-0">
      {header}
      {list}
    </div>
  );
}
