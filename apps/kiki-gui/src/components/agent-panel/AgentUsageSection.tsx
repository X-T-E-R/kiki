import { memo } from 'react';
import { useI18n } from '../../i18n';
import type { AgentTokenUsage, AgentTreeMetrics } from './types';
import { agentUsageCacheHitRate } from './cacheRate';

export interface AgentUsageSectionProps {
  readonly usage?: AgentTokenUsage;
  readonly treeMetrics?: AgentTreeMetrics;
  readonly onOpenUsageDetail?: () => void;
}

export const AgentUsageSection = memo(function AgentUsageSection({
  usage,
  treeMetrics,
  onOpenUsageDetail,
}: AgentUsageSectionProps) {
  const { t } = useI18n();
  const unknownLabel = t('agentPanel.unknown');
  const formatTokens = (count: number | null | undefined): string => {
    if (count === null || count === undefined) return unknownLabel;
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
    return String(count);
  };
  const formatCost = (usd: number | null | undefined): string => {
    if (usd === null || usd === undefined) return unknownLabel;
    return `$${usd.toFixed(4)}`;
  };

  if (!usage && !treeMetrics) {
    return (
      <div className="rounded-xl border border-hairline bg-panel p-3 text-[11.5px] text-ink-faint">
        {t('agentPanel.usageUnavailable')}
      </div>
    );
  }

  const contextUsed = usage?.contextTokens ?? null;
  const contextLimit = usage?.contextLimit ?? null;
  const contextPct = contextUsed !== null && contextLimit !== null && contextLimit > 0
    ? Math.min(100, Math.round((contextUsed / contextLimit) * 100))
    : null;

  const contextBarTone =
    contextPct !== null && contextPct >= 80
      ? 'bg-danger'
      : contextPct !== null && contextPct >= 50
        ? 'bg-amber-rule'
        : 'bg-accent';

  const cacheRate = agentUsageCacheHitRate(usage);
  const cacheTooltip =
    usage?.cacheReadTokens !== undefined || usage?.cacheWriteTokens !== undefined
      ? t('agentPanel.cacheRawTooltip', {
          read: formatTokens(usage?.cacheReadTokens),
          write: formatTokens(usage?.cacheWriteTokens),
        })
      : undefined;

  return (
    <div
      data-agent-usage-section
      className="space-y-2 rounded-xl border border-hairline bg-panel p-3 shadow-xs"
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10.5px] font-semibold tracking-wider text-ink-faint uppercase">
          {t('agentPanel.usageTitle')}
        </span>
        {onOpenUsageDetail ? (
          <button
            type="button"
            onClick={onOpenUsageDetail}
            className="text-[10px] text-ink-faint hover:text-accent transition-colors"
          >
            {t('agentPanel.usageDetails')}
          </button>
        ) : null}
      </div>

      {usage ? (
        <div className="space-y-2.5">
          {/* Context Meter Bar & Status */}
          <div>
            <div className="flex items-baseline justify-between text-[11px]">
              <span className="text-ink-soft">{t('agentPanel.contextWindow')}</span>
              <span className="font-mono font-medium text-ink">
                {contextUsed !== null && contextLimit !== null
                  ? `${formatTokens(contextUsed)} / ${formatTokens(contextLimit)} (${contextPct}%)`
                  : unknownLabel}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-paper border border-hairline">
              <div
                className={`h-full rounded-full transition-all duration-300 ${contextBarTone}`}
                style={{ width: `${contextPct ?? 0}%` }}
              />
            </div>
          </div>

          {/* 4 Distinct Metrics Grids: Cost / Tokens / Compaction / Cache */}
          <div className="grid grid-cols-2 gap-2 pt-1 font-mono text-[11px]">
            {/* 1. Agent Cost */}
            <div className="rounded-lg border border-hairline bg-paper/50 p-2">
              <span className="block text-[10px] text-ink-faint uppercase">{t('agentPanel.agentCost')}</span>
              <span className="font-medium text-ink">{formatCost(usage.totalCostUsd)}</span>
            </div>

            {/* 2. Cumulative Tokens */}
            <div className="rounded-lg border border-hairline bg-paper/50 p-2">
              <span className="block text-[10px] text-ink-faint uppercase">{t('agentPanel.totalTokens')}</span>
              <span className="font-medium text-ink">
                {usage.totalTokens !== null ? formatTokens(usage.totalTokens) : formatTokens(usage.inputTokens !== null && usage.outputTokens !== null ? usage.inputTokens + usage.outputTokens : null)}
              </span>
              <span className="block text-[9.5px] text-ink-faint">
                {t('agentPanel.inputOutput', {
                  input: formatTokens(usage.inputTokens),
                  output: formatTokens(usage.outputTokens),
                })}
              </span>
            </div>

            {/* 3. Compaction Count */}
            <div className="rounded-lg border border-hairline bg-paper/50 p-2">
              <span className="block text-[10px] text-ink-faint uppercase">{t('agentPanel.compactionLabel')}</span>
              <span className="font-medium text-ink">
                {usage.compactionCount !== null
                  ? t('agentPanel.compactionCount', { count: usage.compactionCount })
                  : unknownLabel}
              </span>
            </div>

            {/* 4. Cache Efficiency */}
            <div
              className="rounded-lg border border-hairline bg-paper/50 p-2"
              title={cacheTooltip}
            >
              <span className="block text-[10px] text-ink-faint uppercase">{t('agentPanel.cacheRate')}</span>
              <span className="font-medium text-ink">
                {cacheRate !== null ? `${cacheRate}%` : unknownLabel}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {/* Tree Totals (Root Agent) */}
      {treeMetrics ? (
        <div
          data-tree-metrics
          className="mt-2.5 rounded-lg border border-amber-rule/30 bg-amber-card/40 p-2 font-mono text-[11px]"
        >
          <div className="flex items-center justify-between text-amber-ink font-semibold text-[10.5px] uppercase">
            <span>{t('agentPanel.treeSummary')}</span>
            <span>
              {t('agentPanel.treeActiveCounts', {
                active: treeMetrics.activeSubagentsCount ?? unknownLabel,
                total: treeMetrics.totalSubagentsCount ?? unknownLabel,
              })}
            </span>
          </div>
          <div className="mt-1 flex items-baseline justify-between pt-1 border-t border-amber-rule/20">
            <span className="text-ink-soft">{t('agentPanel.treeTokens')}</span>
            <span className="font-medium text-ink">{formatTokens(treeMetrics.totalTokens)}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-ink-soft">{t('agentPanel.treeCost')}</span>
            <span className="font-medium text-ink">{formatCost(treeMetrics.totalCostUsd)}</span>
          </div>
          {treeMetrics.cacheHitRate !== null && treeMetrics.cacheHitRate !== undefined ? (
            <div className="flex items-baseline justify-between">
              <span className="text-ink-soft">{t('agentPanel.treeCacheRate')}</span>
              <span
                className="font-medium text-ink"
                title={
                  treeMetrics.cacheReadTokens !== undefined || treeMetrics.cacheWriteTokens !== undefined
                    ? t('agentPanel.cacheRawTooltip', {
                        read: formatTokens(treeMetrics.cacheReadTokens),
                        write: formatTokens(treeMetrics.cacheWriteTokens),
                      })
                    : undefined
                }
              >
                {`${treeMetrics.cacheHitRate}%`}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
