import { memo, useId, useState, type ReactNode } from 'react';
import type { AgentCapabilityTarget } from '@kiki/protocol';
import { useI18n } from '../../i18n';
import { DisclosureChevron, Icon } from '../icons';
import type {
  AgentIdentity,
  AgentSkillCapability,
  AgentSubagentTarget,
  AgentTokenUsage,
  AgentToolCapability,
  AgentTreeMetrics,
  DetailDrawerTarget,
} from './types';
import { AgentDetailDrawer } from './AgentDetailDrawer';
import { agentUsageCacheHitRate } from './cacheRate';
import { INSPECTOR_HEAD, INSPECTOR_LINK, InspectorRow } from './InspectorSection';
import { capabilitySourceLabel, SOURCE_TONE_CLASS } from './sourceLabel';

function dispatchPolicyClass(policy: AgentCapabilityTarget['dispatch_policy']): string {
  return policy === 'strict'
    ? 'bg-amber-card text-amber-ink'
    : policy === 'advisory'
      ? 'bg-panel text-ink-soft'
      : 'bg-panel text-ink-faint';
}

function recommendationClass(status: AgentCapabilityTarget['recommendation_status']): string {
  switch (status) {
    case 'preferred':
      return 'bg-success/10 text-success';
    case 'allowed_nonpreferred':
      return 'bg-amber-card text-amber-ink';
    case 'blocked':
      return 'bg-danger/10 text-danger';
    case 'unconfigured':
      return 'bg-panel text-ink-soft';
    default:
      return 'bg-panel text-ink-faint';
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
          className={`rounded-sm px-1.5 py-px text-[11.5px] ${dispatchPolicyClass(policy)}`}
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
            className={`rounded-sm px-1.5 py-px text-[11.5px] ${recommendationClass(status)}`}
          >
            {label}
          </span>
        );
      })}
      {hasUnreportedRecommendation ? (
        <span
          data-recommendation-status="unknown"
          data-advisory-deviation="unknown"
          className={`rounded-sm px-1.5 py-px text-[11.5px] ${recommendationClass(undefined)}`}
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
  readonly subagentTargets?: readonly AgentSubagentTarget[];
  readonly toolCapabilities?: readonly AgentToolCapability[];
  readonly skills?: readonly AgentSkillCapability[];
  readonly draftScope?: { readonly workspace_id?: string; readonly cwd?: string };
  readonly onOpenTreeSelect?: () => void;
  readonly onOpenUsageDetail?: () => void;
  /**
   * Which slice the inspector wants: `usage` (context bar + known metrics),
   * `profile` (the rail's top card: one folded line, then description,
   * badges and the capability tabs), or the legacy `all` for standalone
   * callers.
   */
  readonly part?: 'all' | 'usage' | 'profile';
  /** Profile slice: the capability tabs (or their loading / error line). */
  readonly capabilities?: ReactNode;
  /** Profile slice: folded-line hint, e.g. "14 tools · 3 skills". */
  readonly capabilitySummary?: string;
  /** Profile slice: starts expanded. */
  readonly defaultExpanded?: boolean;
}

export const AgentIdentitySection = memo(function AgentIdentitySection({
  identity,
  usage,
  treeMetrics,
  profilePolicy,
  dispatchTargets,
  subagentTargets,
  toolCapabilities,
  skills,
  draftScope,
  onOpenTreeSelect,
  onOpenUsageDetail,
  part = 'all',
  capabilities,
  capabilitySummary,
  defaultExpanded = false,
}: AgentIdentitySectionProps) {
  const { t, tp } = useI18n();
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

  const [drawerTarget, setDrawerTarget] = useState<DetailDrawerTarget | null>(null);

  const cacheRate = agentUsageCacheHitRate(usage);
  const cacheTooltip =
    usage?.cacheReadTokens !== undefined || usage?.cacheWriteTokens !== undefined
      ? t('agentPanel.cacheRawTooltip', {
          read: formatNumber(usage?.cacheReadTokens),
          write: formatNumber(usage?.cacheWriteTokens),
        })
      : undefined;

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
        : 'bg-ink-soft';

  const effortValue =
    identity.thinkingEffort ?? identity.roleParameters?.['thinkingEffort'] ?? identity.roleParameters?.['effort'];


  const known = (val: number | null | undefined): val is number => val !== null && val !== undefined;
  const metricRows: { key: string; label: string; value: string; title?: string; partial?: boolean }[] = [];
  if (contextPct !== null) {
    metricRows.push({ key: 'context', label: t('inspector.context'), value: `${formatNumber(contextUsed)} / ${formatNumber(contextLimit)} · ${contextPct}%` });
  } else if (known(contextUsed)) {
    metricRows.push({ key: 'context', label: t('inspector.context'), value: formatNumber(contextUsed) });
  }
  if (known(usage?.totalTokens)) {
    metricRows.push({
      key: 'tokens',
      label: t('inspector.tokens'),
      value: formatNumber(usage.totalTokens),
      title: known(usage.inputTokens) && known(usage.outputTokens)
        ? `${formatNumber(usage.inputTokens)} in · ${formatNumber(usage.outputTokens)} out`
        : undefined,
      partial: usage.usagePartial === true,
    });
  }
  if (known(usage?.totalCostUsd)) {
    metricRows.push({ key: 'cost', label: t('inspector.cost'), value: formatCost(usage.totalCostUsd), partial: usage.costPartial === true });
  }
  if (cacheRate !== null) {
    metricRows.push({ key: 'cache', label: t('agentPanel.cacheRate'), value: `${cacheRate}%`, title: cacheTooltip });
  }
  if (known(usage?.compactionCount) && usage.compactionCount > 0) {
    metricRows.push({ key: 'compaction', label: t('agentPanel.compactionLabel').replace(/[:：]\s*$/, ''), value: tp('agentPanel.compactionCount', usage.compactionCount) });
  }
  const treeRows: { key: string; label: string; value: string; title?: string }[] = [];
  if (identity.isMain && treeMetrics !== undefined && (treeMetrics.totalSubagentsCount ?? 0) > 0) {
    if (known(treeMetrics.totalTokens)) treeRows.push({ key: 'tree-tokens', label: t('agentPanel.treeTokens').replace(/[:：]\s*$/, ''), value: formatNumber(treeMetrics.totalTokens) });
    if (known(treeMetrics.totalCostUsd)) treeRows.push({ key: 'tree-cost', label: t('agentPanel.treeCost').replace(/[:：]\s*$/, ''), value: formatCost(treeMetrics.totalCostUsd) });
    if (known(treeMetrics.cacheHitRate)) {
      treeRows.push({
        key: 'tree-cache',
        label: t('agentPanel.treeCacheRate').replace(/[:：]\s*$/, ''),
        value: `${treeMetrics.cacheHitRate}%`,
        title: treeMetrics.cacheReadTokens !== undefined || treeMetrics.cacheWriteTokens !== undefined
          ? t('agentPanel.cacheRawTooltip', { read: formatNumber(treeMetrics.cacheReadTokens), write: formatNumber(treeMetrics.cacheWriteTokens) })
          : undefined,
      });
    }
  }
  const statusKnown = identity.status !== 'unknown';
  const statusDot = (() => {
    switch (identity.status) {
      case 'running':
      case 'background':
        return 'status-dot-busy bg-ink-soft';
      case 'completed':
        return 'bg-success';
      case 'failed':
        return 'bg-danger';
      case 'suspended':
        return 'bg-amber-rule';
      default:
        return 'bg-hairline-strong';
    }
  })();
  const hasBadges = identity.profileSource === 'profile-file' || identity.routeDetached === true || identity.thinkingEffortSource !== undefined;
  const drawer = (
    <AgentDetailDrawer
      target={drawerTarget}
      onClose={() => setDrawerTarget(null)}
      subagentTargets={subagentTargets}
      toolCapabilities={toolCapabilities}
      skills={skills}
      dispatchTargets={dispatchTargets}
      draftScope={draftScope}
    />
  );

  // Usage in two lines: context (label, bar, used / limit), then one tabular
  // line of the rest ("$1.42 · 75% cached · 147k tokens · 1 compaction").
  // With subagents a light text switch flips the figures between this agent
  // and the whole tree. Sans throughout: figures are data, not headings.
  const [scope, setScope] = useState<'agent' | 'tree'>('agent');
  const treeScope = scope === 'tree' && treeRows.length > 0;
  const costShort = (val: number | null | undefined): string | undefined => {
    if (!known(val)) return undefined;
    return val > 0 && val < 0.01 ? '<$0.01' : `$${val.toFixed(2)}`;
  };
  const tokensShort = (val: number | null | undefined): string | undefined => {
    if (!known(val)) return undefined;
    const compact = val >= 1_000_000 ? `${(val / 1_000_000).toFixed(1)}M` : val >= 1_000 ? `${Math.round(val / 1_000)}k` : String(val);
    return t('inspector.tokensShort', { tokens: compact });
  };
  const facts = treeScope
    ? [
        { key: 'cost', text: costShort(treeMetrics?.totalCostUsd), title: known(treeMetrics?.totalCostUsd) ? formatCost(treeMetrics.totalCostUsd) : undefined },
        { key: 'cache', text: known(treeMetrics?.cacheHitRate) ? t('inspector.cached', { pct: treeMetrics.cacheHitRate }) : undefined, title: treeRows.find((row) => row.key === 'tree-cache')?.title },
        { key: 'tokens', text: tokensShort(treeMetrics?.totalTokens), title: undefined },
      ]
    : [
        { key: 'cost', text: costShort(usage?.totalCostUsd), title: known(usage?.totalCostUsd) ? formatCost(usage.totalCostUsd) : undefined },
        { key: 'cache', text: cacheRate !== null ? t('inspector.cached', { pct: cacheRate }) : undefined, title: cacheTooltip },
        {
          key: 'tokens',
          text: tokensShort(usage?.totalTokens),
          title: known(usage?.inputTokens) && known(usage?.outputTokens)
            ? `${formatNumber(usage.inputTokens)} in · ${formatNumber(usage.outputTokens)} out`
            : undefined,
        },
        {
          key: 'compaction',
          text: known(usage?.compactionCount) && usage.compactionCount > 0 ? tp('inspector.compactions', usage.compactionCount) : undefined,
          title: undefined,
        },
      ];
  const shownFacts = facts.filter((fact): fact is { key: string; text: string; title: string | undefined } => fact.text !== undefined);
  const partial = !treeScope && (usage?.usagePartial === true || usage?.costPartial === true);
  const scopeButton = (value: 'agent' | 'tree', label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={scope === value}
      data-usage-scope={value}
      onClick={() => { setScope(value); }}
      className={`h-7 rounded-md px-1.5 text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
        scope === value ? 'text-ink' : 'text-ink-faint hover:text-ink-soft'
      }`}
    >
      {label}
    </button>
  );
  const scopeSwitch = treeRows.length > 0 ? (
    <div role="radiogroup" aria-label={t('inspector.scopeAria')} className="-mr-1.5 flex shrink-0 items-center">
      {scopeButton('agent', t('inspector.scopeAgent'))}
      <span aria-hidden className="text-[12px] text-hairline-strong">/</span>
      {scopeButton('tree', t('inspector.treeTotal'))}
    </div>
  ) : null;
  const usageBlock = contextPct !== null || known(contextUsed) || shownFacts.length > 0 ? (
    <div className="space-y-2">
      {contextPct !== null || known(contextUsed) ? (
        <div className="flex items-center gap-3 text-[12.5px]">
          <span className="shrink-0 text-ink-soft">{t('inspector.context')}</span>
          {/* Compaction-point marking on this bar is owned by the context
              meter work; this slot only lays the bar out. */}
          {contextPct !== null ? (
            <div
              role="meter"
              aria-label={t('inspector.context')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={contextPct}
              title={`${contextPct}%`}
              className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-ink/[0.08]"
            >
              <div className={`h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${barColor}`} style={{ width: `${contextPct}%` }} />
            </div>
          ) : <span className="flex-1" />}
          <span className="shrink-0 text-ink tabular-nums">
            {contextLimit !== null ? `${formatNumber(contextUsed)} / ${formatNumber(contextLimit)}` : formatNumber(contextUsed)}
          </span>
        </div>
      ) : null}
      {shownFacts.length > 0 ? (
        <p {...(treeScope ? { 'data-tree-metrics': '' } : { 'data-agent-usage': '' })} className="truncate text-[12px] text-ink-soft tabular-nums" title={shownFacts.map((fact) => fact.text).join(' · ')}>
          {shownFacts.map((fact, index) => (
            <span key={fact.key} title={fact.title} className={index === 0 ? 'text-ink' : undefined}>
              {index > 0 ? <span aria-hidden className="mx-1.5 text-ink-faint">·</span> : null}
              {fact.text}
            </span>
          ))}
          {partial ? <span className="ml-1.5 text-amber-ink">{t('agentPanel.partialBadge')}</span> : null}
        </p>
      ) : null}
    </div>
  ) : null;

  // The rail's top card. Folded it is one line: a small agent mark, the
  // name in the display face, its source, then model · effort. Open, it adds
  // the description, the badges that change behaviour, and the capability
  // tabs. The whole line is the toggle.
  const [expanded, setExpanded] = useState(defaultExpanded);
  const bodyId = useId();
  const profileLabel = identity.profile !== '' && identity.profile !== unknownLabel ? identity.profile : identity.label;
  const source = capabilitySourceLabel(t, { source: identity.source, sourceFile: identity.sourceFile });
  const modelLine = [
    identity.model,
    effortValue ? t('subagent.effort', { effort: String(effortValue) }) : undefined,
  ].filter((part): part is string => part !== undefined && part !== '').join(' · ');
  const profileCard = (
    <div data-profile-card data-expanded={expanded ? '' : undefined} className="rounded-xl bg-paper/80 ring-1 ring-hairline">
      <button
        type="button"
        data-profile-toggle
        aria-expanded={expanded}
        aria-controls={bodyId}
        title={t(expanded ? 'inspector.profileCollapse' : 'inspector.profileExpand')}
        onClick={() => { setExpanded((open) => !open); }}
        className="flex h-11 w-full min-w-0 items-center gap-2 rounded-xl pr-2.5 pl-2 text-left transition-colors hover:bg-ink/[0.03] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
      >
        <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-ink">
          <Icon name="agent" size={12} />
        </span>
        <span data-profile-name className="min-w-0 shrink truncate font-display text-[14.5px] leading-5 font-semibold tracking-tight text-ink">{profileLabel}</span>
        {source !== undefined ? (
          <span data-profile-source-badge={identity.source} title={source.title} className={`shrink-0 rounded px-1.5 py-px text-[11px] leading-4 ${SOURCE_TONE_CLASS[source.tone]}`}>
            {source.text}
          </span>
        ) : null}
        <span
          data-profile-model
          title={[modelLine, capabilitySummary].filter((part) => part !== undefined && part !== '').join('\n')}
          className="min-w-0 flex-1 truncate text-right text-[12px] text-ink-faint"
        >
          {expanded ? null : modelLine}
        </span>
        <span className="shrink-0"><DisclosureChevron open={expanded} /></span>
      </button>
      {expanded ? (
        <div id={bodyId} data-profile-body className="space-y-2.5 border-t border-hairline px-2.5 pt-2.5 pb-2">
          {identity.summary ? (
            <p className="text-[12.5px] leading-relaxed text-ink-soft">{identity.summary}</p>
          ) : null}
          {identity.model !== undefined && identity.model !== '' ? (
            <p data-profile-model-full className="truncate text-[12px] text-ink-soft" title={modelLine}>{modelLine}</p>
          ) : null}
          {hasBadges || profilePolicy !== undefined ? (
            <div className="flex flex-wrap items-center gap-1">
              {identity.thinkingEffortSource !== undefined ? (
                <span data-thinking-effort-source={identity.thinkingEffortSource} className="rounded-sm bg-amber-card px-1.5 text-[11.5px] text-amber-ink">
                  {t(`agentPanel.effortSource.${identity.thinkingEffortSource}`)}
                </span>
              ) : null}
              {identity.profileSource === 'profile-file' ? (
                <span data-profile-source="profile-file" className="rounded-sm bg-ink/[0.05] px-1.5 text-[11.5px] text-ink-soft">
                  {t('agentPanel.profileFileBadge')}
                </span>
              ) : null}
              {identity.routeDetached === true ? (
                <span data-route-status="detached" className="rounded-sm bg-amber-card px-1.5 text-[11.5px] text-amber-ink">
                  {t('agentPanel.routeDetachedBadge')}
                </span>
              ) : null}
              {/* Only the policy itself: an unreported recommendation is not news. */}
              {profilePolicy !== undefined ? (
                <span data-dispatch-policy={profilePolicy} className={`rounded-sm px-1.5 py-px text-[11.5px] ${dispatchPolicyClass(profilePolicy)}`}>
                  {t(`diagnostics.policy.${profilePolicy}`)}
                </span>
              ) : null}
            </div>
          ) : null}
          {capabilities}
          <button
            type="button"
            data-expand-profile-button
            onClick={() => setDrawerTarget({ kind: 'profile', identity })}
            className={INSPECTOR_LINK}
          >
            {t('inspector.details')}
            <Icon name="arrowRight" size={12} className="text-ink-faint" />
          </button>
        </div>
      ) : null}
    </div>
  );

  if (part === 'usage') {
    return usageBlock === null ? null : (
      <section data-agent-identity-section data-agent-identity-part="usage">
        <div className="mb-1 flex min-h-7 items-center gap-1.5">
          <h3 className={INSPECTOR_HEAD}>{t('inspector.budget')}</h3>
          {onOpenUsageDetail ? (
            <button
              type="button"
              onClick={onOpenUsageDetail}
              title={t('inspector.usage')}
              aria-label={t('inspector.usage')}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
            >
              <Icon name="arrowUpRight" size={12} />
            </button>
          ) : null}
          <span className="flex-1" />
          {scopeSwitch}
        </div>
        {usageBlock}
      </section>
    );
  }
  if (part === 'profile') {
    return (
      <section data-agent-identity-section data-agent-identity-part="profile">
        {profileCard}
        {drawer}
      </section>
    );
  }

  return (
    <section data-agent-identity-section className="space-y-3">
      {/* Identity: the agent name in serif, then model · effort as quiet sans. */}
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <button
            type="button"
            onClick={() => setDrawerTarget({ kind: 'profile', identity })}
            className="min-w-0 truncate text-left font-display text-[18px] leading-tight font-semibold tracking-tight text-ink transition-colors hover:text-ink-soft"
            title={t('inspector.details')}
          >
            {identity.label}
          </button>
          {statusKnown ? (
            <span data-agent-status={identity.status} className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-soft">
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${statusDot}`} />
              {t(`subagent.status.${identity.status}`)}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12.5px] text-ink-soft">
          {identity.model !== undefined ? <span className="truncate" title={identity.model}>{identity.model}</span> : null}
          {effortValue ? (
            <>
              {identity.model !== undefined ? <span aria-hidden className="text-ink-faint">·</span> : null}
              <span className="truncate">{t('agentPanel.thinkingEffort', { value: String(effortValue) })}</span>
            </>
          ) : null}
          {identity.profile !== '' && identity.profile !== unknownLabel && identity.profile !== identity.label ? (
            <>
              <span aria-hidden className="text-ink-faint">·</span>
              <span className="truncate text-ink-faint">{identity.profile}</span>
            </>
          ) : null}
        </p>
        {hasBadges ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {identity.thinkingEffortSource !== undefined ? (
              <span data-thinking-effort-source={identity.thinkingEffortSource} className="rounded-sm bg-amber-card px-1.5 text-[11.5px] text-amber-ink">
                {t(`agentPanel.effortSource.${identity.thinkingEffortSource}`)}
              </span>
            ) : null}
            {identity.profileSource === 'profile-file' ? (
              <span data-profile-source="profile-file" className="rounded-sm bg-panel px-1.5 text-[11.5px] text-ink-soft">
                {t('agentPanel.profileFileBadge')}
              </span>
            ) : null}
            {identity.routeDetached === true ? (
              <span data-route-status="detached" className="rounded-sm bg-amber-card px-1.5 text-[11.5px] text-amber-ink">
                {t('agentPanel.routeDetachedBadge')}
              </span>
            ) : null}
          </div>
        ) : null}
        {identity.summary ? (
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-ink-soft">{identity.summary}</p>
        ) : null}
        {onOpenTreeSelect ? (
          <button type="button" onClick={onOpenTreeSelect} className="mt-1 text-[12px] text-ink-faint underline underline-offset-2 hover:text-ink">
            {t('agentPanel.switchAgent')}
          </button>
        ) : null}
      </div>

      {/* Only what is known: a context bar when there is a limit, then a
          short definition list. No Unknown / Not reported rows. */}
      {contextPct !== null ? (
        <div aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-hairline">
          <div className={`h-full rounded-full transition-[width] duration-300 ${barColor}`} style={{ width: `${contextPct}%` }} />
        </div>
      ) : null}
      {metricRows.length > 0 ? (
        <dl data-agent-usage className="space-y-1 text-[13px]">
          {metricRows.map((row) => (
            <div key={row.key} className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-faint">{row.label}</dt>
              <dd className="min-w-0 truncate text-right text-ink tabular-nums" title={row.title}>
                {row.value}
                {row.partial ? <span className="ml-1 text-[11.5px] text-amber-ink">{t('agentPanel.partialBadge')}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {treeRows.length > 0 ? (
        <dl data-tree-metrics className="space-y-1 text-[13px]">
          <p className="text-[12px] font-medium text-ink-faint">
            {t('inspector.treeTotal')}
            {' · '}
            {t('inspector.treeCounts', { active: treeMetrics?.activeSubagentsCount ?? 0, total: treeMetrics?.totalSubagentsCount ?? 0 })}
          </p>
          {treeRows.map((row) => (
            <div key={row.key} className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-faint">{row.label}</dt>
              <dd className="text-right text-ink tabular-nums" title={row.title}>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {profilePolicy !== undefined || (dispatchTargets?.length ?? 0) > 0 ? (
        <DispatchPolicyBadges profilePolicy={profilePolicy} targets={dispatchTargets} />
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
        <button
          type="button"
          data-expand-profile-button
          onClick={() => setDrawerTarget({ kind: 'profile', identity })}
          className="text-ink underline decoration-hairline-strong underline-offset-2 transition-colors hover:decoration-ink"
        >
          {t('inspector.details')}
        </button>
        {onOpenUsageDetail && metricRows.length > 0 ? (
          <button
            type="button"
            onClick={onOpenUsageDetail}
            className="text-ink underline decoration-hairline-strong underline-offset-2 transition-colors hover:decoration-ink"
          >
            {t('inspector.usage')}
          </button>
        ) : null}
      </div>

      {drawer}
    </section>
  );
});
