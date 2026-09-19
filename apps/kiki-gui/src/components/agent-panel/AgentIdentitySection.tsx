import { memo, useState } from 'react';
import type { AgentCapabilityTarget } from '@kiki/protocol';
import { useI18n } from '../../i18n';
import type { AgentIdentity, AgentTokenUsage, AgentTreeMetrics } from './types';
import { AgentDetailDrawer } from './AgentDetailDrawer';
import { agentUsageCacheHitRate } from './cacheRate';

function dispatchPolicyClass(policy: AgentCapabilityTarget['dispatch_policy']): string {
  return policy === 'strict'
    ? 'border-amber-rule/40 bg-amber-card text-amber-ink'
    : policy === 'advisory'
      ? 'border-accent/30 bg-accent-soft text-accent'
      : 'border-hairline bg-paper text-ink-faint';
}

function recommendationClass(status: AgentCapabilityTarget['recommendation_status']): string {
  switch (status) {
    case 'preferred':
      return 'border-success/30 bg-success/10 text-success';
    case 'allowed_nonpreferred':
      return 'border-amber-rule/40 bg-amber-card text-amber-ink';
    case 'blocked':
      return 'border-danger/30 bg-danger/10 text-danger';
    case 'unconfigured':
      return 'border-hairline bg-paper text-ink-soft';
    default:
      return 'border-hairline bg-paper text-ink-faint';
  }
}

export function DispatchPolicyBadges({
  profilePolicy,
  targets,
  className = '',
}: {
  readonly profilePolicy?: AgentCapabilityTarget['dispatch_policy'];
  readonly targets?: readonly AgentCapabilityTarget[];
  readonly className?: string;
}) {
  const { t } = useI18n();
  const recommendationStates = targets === undefined || targets.length === 0 ? [undefined] : targets;
  const isRecommendationUnreported = (target: AgentCapabilityTarget | undefined) => target === undefined || (
    target.recommendation_status === undefined && target.advisory_deviation === undefined
  );
  const hasUnreportedRecommendation = recommendationStates.some(isRecommendationUnreported);
  const reportedRecommendations = recommendationStates.filter(
    (target): target is AgentCapabilityTarget => !isRecommendationUnreported(target),
  );
  const policies = profilePolicy === undefined
    ? [...new Set(recommendationStates.map((target) => target?.dispatch_policy))]
    : [profilePolicy];
  const recommendations = new Map<string, {
    status: AgentCapabilityTarget['recommendation_status'];
    deviation: boolean | undefined;
  }>();
  for (const target of reportedRecommendations) {
    recommendations.set(
      `${target.recommendation_status ?? 'unknown'}:${String(target.advisory_deviation)}`,
      { status: target.recommendation_status, deviation: target.advisory_deviation },
    );
  }

  return (
    <div data-dispatch-policy-badges className={`flex flex-wrap items-center gap-1 ${className}`}>
      {policies.map((policy) => (
        <span
          key={policy ?? 'unknown'}
          data-dispatch-policy={policy ?? 'unknown'}
          className={`rounded-full border px-1.5 py-px font-mono text-[9.5px] ${dispatchPolicyClass(policy)}`}
        >
          {policy === undefined ? t('diagnostics.unknown') : t(`diagnostics.policy.${policy}`)}
        </span>
      ))}
      {[...recommendations.values()].map(({ status, deviation }) => {
        const label = status === undefined
          ? t('diagnostics.unknown')
          : status === 'unconfigured'
            ? t('diagnostics.unconfigured')
            : status === 'preferred'
              ? t('diagnostics.preferred')
              : status === 'allowed_nonpreferred'
                ? t('diagnostics.allowedNonpreferred')
                : t('diagnostics.blocked');
        return (
          <span
            key={`${status ?? 'unknown'}:${String(deviation)}`}
            data-recommendation-status={status ?? 'unknown'}
            data-advisory-deviation={deviation === undefined ? 'unknown' : String(deviation)}
            className={`rounded-full border px-1.5 py-px font-mono text-[9.5px] ${recommendationClass(status)}`}
          >
            {label}
          </span>
        );
      })}
      {hasUnreportedRecommendation ? (
        <span
          data-recommendation-status="unknown"
          data-advisory-deviation="unknown"
          className={`rounded-full border px-1.5 py-px font-mono text-[9.5px] ${recommendationClass(undefined)}`}
        >
          {t('diagnostics.unknown')}
        </span>
      ) : null}
    </div>
  );
}

export interface AgentIdentitySectionProps {
  readonly identity: AgentIdentity;
  readonly usage?: AgentTokenUsage;
  readonly treeMetrics?: AgentTreeMetrics;
  readonly profilePolicy?: AgentCapabilityTarget['dispatch_policy'];
  readonly dispatchTargets?: readonly AgentCapabilityTarget[];
  readonly onOpenTreeSelect?: () => void;
  readonly onOpenUsageDetail?: () => void;
}

export const AgentIdentitySection = memo(function AgentIdentitySection({
  identity,
  usage,
  treeMetrics,
  profilePolicy,
  dispatchTargets,
  onOpenTreeSelect,
  onOpenUsageDetail,
}: AgentIdentitySectionProps) {
  const { t } = useI18n();
  const unknownLabel = t('agentPanel.unknown');
  const formatNumber = (val: number | null | undefined, suffix = ''): string => {
    if (val === null || val === undefined) return unknownLabel;
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M${suffix}`;
    if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k${suffix}`;
    return `${val}${suffix}`;
  };
  const formatCost = (val: number | null | undefined): string => {
    if (val === null || val === undefined) return unknownLabel;
    return `$${val.toFixed(4)}`;
  };

  const [detailOpen, setDetailOpen] = useState(false);
  const [metricsDetailExpanded, setMetricsDetailExpanded] = useState(false);

  const cacheRate = agentUsageCacheHitRate(usage);
  const cacheTooltip =
    usage?.cacheReadTokens !== undefined || usage?.cacheWriteTokens !== undefined
      ? t('agentPanel.cacheRawTooltip', {
          read: formatNumber(usage?.cacheReadTokens),
          write: formatNumber(usage?.cacheWriteTokens),
        })
      : undefined;

  const statusColor = (() => {
    switch (identity.status) {
      case 'running':
      case 'background':
        return 'bg-accent text-panel';
      case 'completed':
        return 'bg-success/15 text-success border border-success/30';
      case 'failed':
        return 'bg-danger/15 text-danger border border-danger/30';
      case 'suspended':
        return 'bg-amber-card text-amber-ink border border-amber-rule/40';
      default:
        return 'bg-paper text-ink-faint border border-hairline';
    }
  })();

  const contextUsed = usage?.contextTokens ?? null;
  const contextLimit = usage?.contextLimit ?? null;
  const contextPct =
    contextUsed !== null && contextLimit !== null && contextLimit > 0
      ? Math.min(100, Math.round((contextUsed / contextLimit) * 100))
      : null;

  const barColor =
    contextPct !== null && contextPct >= 80
      ? 'bg-danger'
      : contextPct !== null && contextPct >= 50
        ? 'bg-amber-rule'
        : 'bg-accent';

  const effortValue =
    identity.thinkingEffort ?? identity.roleParameters?.['thinkingEffort'] ?? identity.roleParameters?.['effort'];

  return (
    <div
      data-agent-identity-section
      className="rounded-xl border border-hairline bg-panel p-3 shadow-xs transition-colors space-y-2.5"
    >
      {/* 1. Header: Display Name, Profile Tag, Model/Effort, Status */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setDetailOpen(true)}
              className="font-display text-[15px] font-semibold text-ink tracking-tight hover:text-accent text-left cursor-pointer transition-colors"
              title={t('agentPanel.viewDetails')}
            >
              {identity.label}
            </button>
            {identity.isMain ? (
              <span className="rounded-sm bg-accent-soft px-1.5 py-0.2 text-[9.5px] font-mono font-medium text-accent uppercase">
                {t('agentPanel.mainBadge')}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setDetailOpen(true)}
              className="rounded-md bg-paper border border-hairline px-1.5 py-0.2 font-mono text-[10px] text-ink-soft hover:border-hairline-strong hover:text-ink cursor-pointer transition-colors"
              title={t('agentPanel.viewDetails')}
            >
              {identity.profile}
            </button>
            {identity.profileSource === 'profile-file' ? (
              <span
                data-profile-source="profile-file"
                className="rounded-sm border border-accent/30 bg-accent-soft px-1 text-[9px] text-accent"
              >
                {t('agentPanel.profileFileBadge')}
              </span>
            ) : null}
            {identity.routeDetached === true ? (
              <span
                data-route-status="detached"
                className="rounded-sm border border-amber-rule/40 bg-amber-card px-1 text-[9px] text-amber-ink"
              >
                {t('agentPanel.routeDetachedBadge')}
              </span>
            ) : null}
          </div>

          <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-ink-faint">
            <span className="truncate text-ink-soft" title={identity.model ?? t('agentPanel.unknownModel')}>
              {identity.model ?? t('agentPanel.unknownModel')}
            </span>
            {effortValue ? (
              <>
                <span>·</span>
                <span className="truncate text-ink-faint">
                  {t('agentPanel.thinkingEffort', { value: String(effortValue) })}
                </span>
                {identity.thinkingEffortSource !== undefined ? (
                  <span
                    data-thinking-effort-source={identity.thinkingEffortSource}
                    className="rounded-sm border border-amber-rule/40 bg-amber-card px-1 text-[9px] text-amber-ink"
                  >
                    {t(`agentPanel.effortSource.${identity.thinkingEffortSource}`)}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
          <DispatchPolicyBadges profilePolicy={profilePolicy} targets={dispatchTargets} className="mt-1.5" />
        </div>

        <div className="flex flex-col items-end gap-1 shrink-0">
          <span
            data-agent-status={identity.status}
            className={`rounded-full px-2 py-0.5 text-[10px] font-mono font-medium capitalize ${statusColor}`}
          >
            {identity.status === 'unknown' ? unknownLabel : t(`subagent.status.${identity.status}`)}
          </span>
          {onOpenTreeSelect ? (
            <button
              type="button"
              onClick={onOpenTreeSelect}
              className="text-[10px] text-ink-faint hover:text-accent underline transition-colors"
            >
              {t('agentPanel.switchAgent')}
            </button>
          ) : null}
        </div>
      </div>

      {/* 2. One-line Summary */}
      {identity.summary ? (
        <p className="text-[12px] leading-relaxed text-ink-soft line-clamp-2">
          {identity.summary}
        </p>
      ) : null}

      {/* 3. Compact Integrated Accounting Strip */}
      <div className="rounded-lg border border-hairline bg-paper/60 p-2 text-[11px] font-mono">
        {/* Context Window Line */}
        <div className="flex items-baseline justify-between text-[10.5px]">
          <span className="text-ink-faint uppercase font-semibold">{t('agentPanel.contextUsageLimit')}</span>
          <span className="font-medium text-ink">
            {`${formatNumber(contextUsed)} / ${formatNumber(contextLimit)}${
              contextPct === null ? '' : ` (${contextPct}%)`
            }`}
          </span>
        </div>

        {/* Progress bar: ONLY rendered when contextPct is known (not null) to avoid fake 0 progress bar */}
        {contextPct !== null ? (
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-paper border border-hairline">
            <div
              className={`h-full rounded-full transition-all duration-300 ${barColor}`}
              style={{ width: `${contextPct}%` }}
            />
          </div>
        ) : null}

        {/* 4 Inline KPI Badges: 费用, 累计 Tokens, 压缩次数, 缓存 */}
        <div className="mt-2 grid grid-cols-2 gap-1.5 pt-1.5 border-t border-hairline text-[10.5px]">
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-1 pr-1">
            <span className="text-ink-faint flex items-center gap-1">
              <span>{t('agentPanel.costLabel')}</span>
              {usage?.costPartial ? (
                <span className="rounded bg-amber-card text-amber-ink px-1 text-[9px] font-sans border border-amber-rule/40" title={t('agentPanel.partialCost')}>
                  {t('agentPanel.partialBadge')}
                </span>
              ) : null}
            </span>
            <span className="font-medium text-ink">{formatCost(usage?.totalCostUsd)}</span>
          </div>
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-1 pl-1">
            <span className="text-ink-faint flex items-center gap-1">
              <span>{t('agentPanel.totalTokensLabel')}</span>
              {usage?.usagePartial ? (
                <span className="rounded bg-amber-card text-amber-ink px-1 text-[9px] font-sans border border-amber-rule/40" title={t('agentPanel.partialBadge')}>
                  {t('agentPanel.partialBadge')}
                </span>
              ) : null}
            </span>
            <span className="font-medium text-ink">{formatNumber(usage?.totalTokens)}</span>
          </div>
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-1 pr-1">
            <span className="text-ink-faint">{t('agentPanel.compactionLabel')}</span>
            <span className="font-medium text-ink">
              {usage?.compactionCount !== null && usage?.compactionCount !== undefined
                ? t('agentPanel.compactionCount', { count: usage.compactionCount })
                : unknownLabel}
            </span>
          </div>
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-1 pl-1">
            <span className="text-ink-faint">{t('agentPanel.cacheRateLabel')}</span>
            <span
              className="font-medium text-ink"
              title={cacheTooltip}
            >
              {cacheRate !== null ? `${cacheRate}%` : unknownLabel}
            </span>
          </div>
        </div>

        {/* Optional Secondary Usage Details Toggle */}
        <div className="mt-1.5 flex items-center justify-between pt-1 border-t border-hairline/60 text-[10px]">
          <button
            type="button"
            onClick={() => setMetricsDetailExpanded(!metricsDetailExpanded)}
            className="text-ink-faint hover:text-ink transition-colors"
          >
            {metricsDetailExpanded ? t('agentPanel.collapseMetrics') : t('agentPanel.inOutDetails')}
          </button>
          {onOpenUsageDetail ? (
            <button
              type="button"
              onClick={onOpenUsageDetail}
              className="text-accent hover:underline"
            >
              {t('agentPanel.usageDashboard')}
            </button>
          ) : null}
        </div>

        {metricsDetailExpanded ? (
          <div className="mt-1.5 space-y-0.5 rounded bg-panel p-1.5 text-[10px] text-ink-soft border border-hairline">
            <div className="flex justify-between">
              <span>{t('agentPanel.inputTokensLabel')}</span>
              <span className="font-medium text-ink">{formatNumber(usage?.inputTokens)}</span>
            </div>
            <div className="flex justify-between">
              <span>{t('agentPanel.outputTokensLabel')}</span>
              <span className="font-medium text-ink">{formatNumber(usage?.outputTokens)}</span>
            </div>
          </div>
        ) : null}
      </div>

      {/* 4. Tree Metrics (ONLY shown when isMain === true) */}
      {identity.isMain && treeMetrics ? (
        <div
          data-tree-metrics
          className="rounded-lg border border-amber-rule/30 bg-amber-card/40 p-2 font-mono text-[10.5px]"
        >
          <div className="flex items-center justify-between text-amber-ink font-semibold uppercase">
            <span>{t('agentPanel.treeSummary')}</span>
            <span>
              {t('agentPanel.treeCounts', {
                active: treeMetrics.activeSubagentsCount ?? unknownLabel,
                total: treeMetrics.totalSubagentsCount ?? unknownLabel,
              })}
            </span>
          </div>
          <div className="mt-1 flex items-baseline justify-between pt-1 border-t border-amber-rule/20">
            <span className="text-ink-soft">{t('agentPanel.treeTokens')}</span>
            <span className="font-medium text-ink">{formatNumber(treeMetrics.totalTokens)}</span>
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
                        read: formatNumber(treeMetrics.cacheReadTokens),
                        write: formatNumber(treeMetrics.cacheWriteTokens),
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

      {/* 5. Profile Details Action */}
      <div className="border-t border-hairline pt-2 flex items-center justify-between text-[11px]">
        <span className="font-mono text-[10.5px] text-ink-faint">
          {t('agentPanel.profileDetail')}
        </span>
        <button
          type="button"
          data-expand-profile-button
          onClick={() => setDetailOpen(true)}
          className="text-accent hover:text-accent-deep transition-colors font-mono hover:underline cursor-pointer flex items-center gap-1"
        >
          <span>{t('agentPanel.viewDetails')}</span>
          <span aria-hidden>→</span>
        </button>
      </div>

      {/* Detail Drawer */}
      <AgentDetailDrawer
        target={detailOpen ? { kind: 'profile', identity } : null}
        onClose={() => setDetailOpen(false)}
      />
    </div>
  );
});
